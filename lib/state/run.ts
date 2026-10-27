/**
 * Orchestrates one simulation run: validate, dispatch to the right executor
 * (browser worker or Python backend), compute vehicle performance, obtain a flow
 * field for visualisation, and record the experiment.
 */
import {
  type Fidelity,
  type GeometryParams,
  type JobProgress,
  type SimulationConfig,
  SimulationError,
  type SimulationResult,
} from "@/lib/types";
import { validateGeometry } from "@/lib/geometry/validate";
import { uploadedCfdSurface } from "@/lib/import/cfdSurface";
import { ensureBodyLoaded } from "@/lib/import/modelStore";
import { relativeWind } from "@/lib/physics/wind";
import { checkBackend, simulateBackend } from "@/lib/simulation/backendApi";
import { performanceLocal, simulateLocal } from "@/lib/simulation/client";
import { makeConfig, makePerformanceInput } from "@/lib/simulation/config";
import type { FlowField } from "@/lib/simulation/field";
import { canonicalJson, hashConfig, hashString } from "@/lib/simulation/hash";
import { refreshAccount, useAccountStore } from "@/lib/state/accountStore";
import { type Experiment, summarizePerformance, useExperimentStore } from "@/lib/state/experimentStore";
import { useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";
import { currentVehicle, useSimStore } from "@/lib/state/simStore";
import { useFlowStore } from "@/lib/state/viewStore";

const FIELD_CACHE_LIMIT = 4;
const fieldCache = new Map<string, FlowField>();

/** The velocity-ratio field depends only on geometry, yaw angle and grid fidelity. */
export function fieldKeyOf(geometry: GeometryParams, yawDeg: number, fidelity: Fidelity, bodyId?: string): string {
  return hashString(canonicalJson({ geometry, yaw: Math.round(yawDeg * 100) / 100, fidelity, bodyId: bodyId ?? null }));
}

function fieldKeyForConfig(config: SimulationConfig): string {
  const wind = relativeWind(config.speed, config.environment.windSpeed, config.environment.windAngle);
  return fieldKeyOf(config.geometry, wind.yawAngleDeg, config.fidelity, config.bodyId);
}

function rememberField(key: string, field: FlowField): void {
  fieldCache.delete(key);
  if (fieldCache.size >= FIELD_CACHE_LIMIT) {
    const oldest = fieldCache.keys().next().value;
    if (oldest !== undefined) fieldCache.delete(oldest);
  }
  fieldCache.set(key, field);
}

/** Configuration of the simulation described by the current editor state. */
export function currentConfig(): SimulationConfig {
  const state = useSimStore.getState();
  return makeConfig(currentVehicle(state), state.geometry, state.environment, state.speed, state.mode, state.fidelity);
}

/** Probes the backend and records its availability. Never throws. */
export async function refreshBackendStatus(): Promise<boolean> {
  const backend = useBackendStore.getState();
  if (useSettingsStore.getState().demoMode) {
    backend.setStatus("offline", null, "Demo mode: backend disabled.");
    return false;
  }
  // Re-checking a backend that is already online keeps it "online" meanwhile, so
  // panels that depend on it are not torn down (and their state lost) by a refresh.
  if (backend.status !== "online") backend.setStatus("checking", backend.info);
  try {
    const info = await checkBackend();
    useBackendStore.getState().setStatus("online", info);
    void refreshAccount();
    return true;
  } catch (error) {
    useBackendStore.getState().setStatus("offline", null, error instanceof Error ? error.message : "Backend unavailable");
    return false;
  }
}

function usesBackend(config: SimulationConfig): boolean {
  if (config.mode === "cfd" || config.mode === "ml-surrogate") return true;
  // The measured envelope of an imported model exists only in this browser.
  if (config.bodyId) return false;
  const settings = useSettingsStore.getState();
  return !settings.demoMode && settings.computeTarget === "backend";
}

/**
 * Runs the current configuration. Resolves with the recorded experiment, or
 * null when the run failed (the error is stored for the UI to show).
 */
export async function runSimulation(): Promise<Experiment | null> {
  const sim = useSimStore.getState();
  if (sim.running) return null;
  const config = currentConfig();
  const setRun = useSimStore.getState().setRunState;
  const onProgress = (job: JobProgress) => setRun({ job });

  const issues = validateGeometry(config.geometry).filter((issue) => issue.severity === "error");
  if (issues.length > 0) {
    setRun({
      error: { code: "INVALID_GEOMETRY", message: issues.map((issue) => issue.message).join(" ") },
      job: { state: "FAILED", progress: 0, message: "Invalid geometry" },
    });
    return null;
  }

  setRun({ running: true, error: null, job: { state: "QUEUED", progress: 0, message: "Queued" } });
  try {
    // What goes to the backend. For an imported 3D model in Mode C that is the wrapped surface of the model,
    // not its browser-only envelope.
    let request = config;
    if (config.bodyId) {
      if (config.mode === "ml-surrogate") {
        throw new SimulationError(
          "IMPORTED_MODEL_UNSUPPORTED",
          "Mode D is not available for an imported 3D model: the surrogate is trained on the parametric shape. " +
            "Use Mode A, B or C. Nothing was computed.",
        );
      }
      const model = currentVehicle(sim).importedModel;
      if (config.mode === "cfd" && model) {
        // Mode C meshes the wrapped surface of the model; it is built now if it has not been built before.
        const { bodyId: _browserOnly, ...rest } = config;
        request = { ...rest, cfdSurface: await uploadedCfdSurface(model, onProgress) };
      }
      const loaded = await ensureBodyLoaded(config.bodyId);
      if (!loaded && config.mode !== "cfd") {
        throw new SimulationError(
          "IMPORTED_BODY_MISSING",
          "The measured shape of this imported 3D model is not stored in this browser any more. Import the model again, " +
            "or change a shape parameter to continue with the fitted parametric shape. Nothing was computed.",
        );
      }
    }
    const fieldKey = fieldKeyForConfig(config);
    let field = fieldCache.get(fieldKey) ?? null;
    let result: SimulationResult;

    if (usesBackend(config)) {
      if (useSettingsStore.getState().demoMode) {
        throw new SimulationError(
          "BACKEND_REQUIRED",
          "This mode needs the Python backend, which is disabled in demo mode. Nothing was computed.",
        );
      }
      // The backend hashes with its own scheme; the UI compares against the local hash.
      try {
        result = { ...(await simulateBackend(request, onProgress)), hash: hashConfig(config) };
      } finally {
        // The run used (or was refused) part of the account's Mode C quota.
        if (config.mode === "cfd") void refreshAccount();
      }
      useBackendStore.getState().setStatus("online", useBackendStore.getState().info);
      if (!field) {
        // Coefficients came from the backend; the picture still needs a field.
        try {
          const visual = await simulateLocal({ ...config, mode: "analytical" }, true, (job) =>
            onProgress({ ...job, state: job.state === "COMPLETE" ? "POST_PROCESSING" : job.state }),
          );
          field = visual.field;
        } catch {
          // The coefficients stand without a picture: a failed visualisation must not discard a finished run.
        }
      }
    } else {
      const run = await simulateLocal(config, !field, onProgress);
      result = run.result;
      if (run.field) field = run.field;
    }

    return await commitResult(config, result, field, fieldKey);
  } catch (error) {
    const code = error instanceof SimulationError ? error.code : "SIMULATION_FAILED";
    const message = error instanceof Error ? error.message : "The simulation failed.";
    if (code === "BACKEND_UNAVAILABLE") useBackendStore.getState().setStatus("offline", null, message);
    if (code === "AUTH_REQUIRED") useAccountStore.setState({ status: "signed-out", user: null, cfdQuota: null });
    setRun({ running: false, error: { code, message }, job: { state: "FAILED", progress: 0, message: "Failed" } });
    return null;
  }
}

/**
 * Computes vehicle performance for an aerodynamic result, records the
 * experiment and makes it the displayed result.
 */
async function commitResult(
  config: SimulationConfig,
  result: SimulationResult,
  field: FlowField | null,
  fieldKey: string,
): Promise<Experiment> {
  const sim = useSimStore.getState();
  const vehicle = currentVehicle(sim);
  const input = makePerformanceInput(
    sim.spec,
    sim.powertrain,
    config.geometry,
    result.aero.coefficients,
    result.aero.air.density,
    config.environment,
    config.speed,
  );
  const performance = await performanceLocal(input);

  if (field) {
    rememberField(fieldKey, field);
    useFlowStore.getState().setField(field, fieldKey);
  }

  const experiment = useExperimentStore.getState().add({
    createdAt: Date.now(),
    projectName: sim.projectName,
    vehicleId: vehicle.id,
    vehicleName: vehicle.name,
    config,
    spec: { ...sim.spec },
    powertrain: structuredClone(sim.powertrain),
    aero: result.aero,
    performance: summarizePerformance(performance, input),
    saved: false,
  });

  useSimStore.getState().setRunState({
    running: false,
    result,
    performance,
    resultExperimentId: experiment.id,
    job: { state: "COMPLETE", progress: 1, message: result.cached ? "Complete (cached result)" : "Complete" },
  });
  return experiment;
}

/**
 * Records a result obtained outside the normal run path (for example CFD
 * coefficients imported from a solver run elsewhere).
 */
export async function recordExternalResult(result: SimulationResult): Promise<Experiment> {
  const config = result.config;
  const fieldKey = fieldKeyForConfig(config);
  const normalised = { ...result, hash: hashConfig(config) };
  // Show the result under the mode it belongs to; otherwise it would be flagged stale straight away.
  useSimStore.getState().setMode(config.mode);
  useSimStore.getState().setRunState({ error: null });
  return commitResult(config, normalised, fieldCache.get(fieldKey) ?? null, fieldKey);
}

/**
 * Recomputes vehicle performance for the displayed aerodynamic result after a
 * chassis or powertrain change (the aerodynamics are unaffected).
 */
export async function refreshPerformance(): Promise<void> {
  const sim = useSimStore.getState();
  const { result } = sim;
  if (!result || sim.running) return;
  try {
    const performance = await performanceLocal(
      makePerformanceInput(
        sim.spec,
        sim.powertrain,
        result.config.geometry,
        result.aero.coefficients,
        result.aero.air.density,
        result.config.environment,
        result.config.speed,
      ),
    );
    if (useSimStore.getState().result === result) useSimStore.getState().setRunState({ performance });
  } catch {
    // A failed refresh leaves the previous performance in place; the next run recomputes it.
  }
}

/** True when the editor state no longer matches the configuration of the displayed result. */
export function isResultStale(result: SimulationResult | null): boolean {
  if (!result) return false;
  return hashConfig(currentConfig()) !== result.hash;
}
