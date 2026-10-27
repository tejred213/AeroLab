/**
 * Local (in-browser) simulation engines. Runs inside the Web Worker; also used
 * directly by unit tests. Mirrors the backend's SimulationEngine dispatch.
 */
import { type AeroResult, type SimulationConfig, SimulationError, type SimulationResult } from "@/lib/types";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { prepareCase } from "@/lib/simulation/assemble";
import type { FlowField } from "@/lib/simulation/field";
import { hashConfig } from "@/lib/simulation/hash";
import { type ProgressReporter, runReducedOrder, solveVisualizationField } from "@/lib/simulation/reducedOrderEngine";

export interface LocalRun {
  result: SimulationResult;
  field: FlowField | null;
}

const RESULT_CACHE_LIMIT = 64;
/** Aerodynamic results keyed by configuration hash (fields are cached on the main thread). */
const resultCache = new Map<string, AeroResult>();

function remember(hash: string, aero: AeroResult): void {
  if (resultCache.size >= RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(hash, aero);
}

export function clearLocalCache(): void {
  resultCache.clear();
}

/**
 * Runs one simulation with a local engine.
 * @param wantField also return a flow field for visualisation.
 */
export function runLocal(
  config: SimulationConfig,
  wantField: boolean,
  report: ProgressReporter = () => {},
): LocalRun {
  const started = performance.now();
  const hash = hashConfig(config);
  // The road gradient does not affect the aerodynamics, so it is left out of the cache key.
  const cacheKey = hashConfig({ ...config, environment: { ...config.environment, gradient: 0 } });

  if (config.mode === "cfd" || config.mode === "ml-surrogate") {
    throw new SimulationError(
      "BACKEND_REQUIRED",
      config.mode === "cfd"
        ? "Mode C (CFD) runs only on the Python backend with an installed CFD solver. Nothing was computed."
        : "Mode D (ML surrogate) needs a trained model on the Python backend. Nothing was computed.",
    );
  }

  report("PREPARING", 0, "Preparing geometry");
  const prepared = prepareCase(config);
  const cached = resultCache.get(cacheKey);

  if (config.mode === "analytical") {
    const aero = cached ?? runAnalytical(config, "browser", prepared);
    if (!cached) remember(cacheKey, aero);
    const field = wantField ? solveVisualizationField(config, report, prepared) : null;
    report("COMPLETE", 1, cached ? "Complete (cached result)" : "Complete");
    return { result: { hash, config, aero, durationMs: performance.now() - started, cached: !!cached }, field };
  }

  // Reduced-order: the solve that produces the coefficients also produces the field.
  if (cached && !wantField) {
    report("COMPLETE", 1, "Complete (cached result)");
    return { result: { hash, config, aero: cached, durationMs: performance.now() - started, cached: true }, field: null };
  }
  const run = runReducedOrder(config, "browser", report, prepared);
  remember(cacheKey, run.aero);
  report("COMPLETE", 1, "Complete");
  return {
    result: { hash, config, aero: run.aero, durationMs: performance.now() - started, cached: false },
    field: wantField ? run.field : null,
  };
}
