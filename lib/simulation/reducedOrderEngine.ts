import type { AeroResult, Fidelity, GeometryParams, JobState, SimulationConfig } from "@/lib/types";
import { MODEL } from "@/lib/physics/model";
import type { RawAero } from "@/lib/physics/aeroAnalytical";
import { assembleResult, type PreparedCase, prepareCase } from "@/lib/simulation/assemble";
import type { FlowField } from "@/lib/simulation/field";
import { canonicalJson, hashConfig, hashString } from "@/lib/simulation/hash";
import { solveReducedOrder } from "@/lib/simulation/reducedOrder";

export const REDUCED_ORDER_PROVENANCE =
  "Mode B · Reduced-order — 3D potential flow solved numerically (cut-cell finite volume) with empirical " +
  "closures for separation, base pressure, friction and wheels. Inviscid; not CFD.";

export const REDUCED_ORDER_ASSUMPTIONS = [
  "Steady, incompressible, inviscid, irrotational airflow (potential flow) at constant air density.",
  "No turbulence model: there is no viscosity in the solved equations.",
  "The separated wake is replaced by a closed displacement body whose shape is prescribed empirically.",
  "Separation location is an empirical function of the effective rear slope; it is not predicted by the solver.",
  "Base pressure blends an empirical value with the pressure the solver finds along the wake boundary.",
  "Skin friction, wheel drag, underbody roughness, trailing-vortex drag and crosswind forces are empirical closures.",
  "Rear wing uses lifting-line theory with the local dynamic pressure sampled from the solved field.",
  "Open-jet test section: constant-pressure side and top boundaries, uniform inflow, stationary ground plane.",
  "Simplified wheels (non-rotating cylinders) and simplified ground interaction.",
  "Rigid vehicle body; no thermal or cooling-flow effects.",
  "Results are anchored to an approximate class reference and are most reliable as differences between configurations.",
];

export type ProgressReporter = (state: JobState, progress: number, message: string) => void;

/** Uncalibrated reference solutions, keyed by reference geometry + fidelity. */
const referenceCache = new Map<string, { raw: RawAero }>();

function referenceKey(geometry: GeometryParams, fidelity: Fidelity): string {
  return hashString(canonicalJson({ version: MODEL.version, geometry, fidelity }));
}

export interface ReducedOrderRun {
  aero: AeroResult;
  field: FlowField | null;
}

/** Mode B engine: potential-flow solve + closures, calibrated to the class reference. */
export function runReducedOrder(
  config: SimulationConfig,
  source: "browser" | "backend" = "browser",
  report: ProgressReporter = () => {},
  prepared: PreparedCase = prepareCase(config),
): ReducedOrderRun {
  const key = referenceKey(config.referenceGeometry, config.fidelity);
  let reference = referenceCache.get(key);
  const referenceShare = reference ? 0 : 0.45;

  if (!reference) {
    const solved = solveReducedOrder(prepared.referenceShape, prepared.referenceMetrics, prepared.calibrationFlow, {
      fidelity: config.fidelity,
      buildField: false,
      hash: key,
      onProgress: (stage, fraction, message) => {
        const within = stage === "MESHING" ? 0.05 * fraction : stage === "SOLVING" ? 0.05 + 0.9 * fraction : 0.95;
        report(stage, referenceShare * within, `Reference geometry · ${message}`);
      },
    });
    reference = { raw: solved.raw };
    referenceCache.set(key, reference);
  }

  const solved = solveReducedOrder(prepared.shape, prepared.metrics, prepared.flow, {
    fidelity: config.fidelity,
    buildField: true,
    hash: hashConfig(config),
    onProgress: (stage, fraction, message) => {
      const within = stage === "MESHING" ? 0.05 * fraction : stage === "SOLVING" ? 0.05 + 0.9 * fraction : 0.96;
      report(stage, referenceShare + (1 - referenceShare) * within, message);
    },
  });

  const aero = assembleResult({
    config,
    prepared,
    raw: solved.raw,
    rawReference: reference.raw,
    mode: "reduced-order",
    source,
    provenance: REDUCED_ORDER_PROVENANCE,
    uncertaintyModel: MODEL.uncertainty.reducedOrder,
    assumptions: REDUCED_ORDER_ASSUMPTIONS,
    solver: { ...solved.diagnostics, rawCd: solved.raw.cd, rawCl: solved.raw.cl },
  });
  return { aero, field: solved.field };
}

/**
 * Flow field for visualisation only (used when the coefficients come from
 * another mode). No reference solve, no calibration.
 */
export function solveVisualizationField(
  config: SimulationConfig,
  report: ProgressReporter = () => {},
  prepared: PreparedCase = prepareCase(config),
): FlowField {
  const solved = solveReducedOrder(prepared.shape, prepared.metrics, prepared.flow, {
    fidelity: config.fidelity,
    buildField: true,
    hash: hashConfig(config),
    onProgress: (stage, fraction, message) => {
      const within = stage === "MESHING" ? 0.05 * fraction : stage === "SOLVING" ? 0.05 + 0.9 * fraction : 0.96;
      report(stage, within, `Visualisation field · ${message}`);
    },
  });
  if (!solved.field) throw new Error("Field was not built");
  return solved.field;
}
