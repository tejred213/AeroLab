/**
 * Parameter sweeps and 2D design-space maps: the same simulation repeated over
 * one or two geometry parameters. Pure functions; run in the worker.
 */
import {
  type GeometryParams,
  type ParamId,
  type Powertrain,
  type SimulationConfig,
  SimulationError,
  type VehicleSpec,
} from "@/lib/types";
import { clampParam, PARAM_BY_ID } from "@/lib/geometry/parameters";
import { studyConfig, studySurfaceNote } from "@/lib/geometry/sampledBody";
import { makePerformanceInput } from "@/lib/simulation/config";
import { runLocal } from "@/lib/simulation/engine";
import { computePerformance } from "@/lib/vehicle/performance";

export type SweepMetric = "cd" | "cl" | "drag" | "downforce" | "topSpeed" | "efficiency" | "accel100";

export const SWEEP_METRICS: { id: SweepMetric; label: string }[] = [
  { id: "cd", label: "Cd" },
  { id: "cl", label: "Cl" },
  { id: "drag", label: "Drag" },
  { id: "downforce", label: "Downforce" },
  { id: "topSpeed", label: "Top speed" },
  { id: "efficiency", label: "Efficiency (−Cl/Cd)" },
  { id: "accel100", label: "0–100 km/h" },
];

export interface SweepRow {
  /** Value of the first swept parameter. */
  x: number;
  /** Value of the second swept parameter (2D maps only). */
  y: number | null;
  valid: boolean;
  /** Why the point could not be evaluated. */
  error: string | null;
  cd: number | null;
  cdUncertainty: number | null;
  cl: number | null;
  clUncertainty: number | null;
  drag: number | null;
  downforce: number | null;
  topSpeed: number | null;
  /** Aerodynamic efficiency: downforce / drag = -Cl / Cd. */
  efficiency: number | null;
  accel100: number | null;
}

export interface SweepRequest {
  config: SimulationConfig;
  spec: VehicleSpec;
  powertrain: Powertrain;
  paramX: ParamId;
  valuesX: number[];
  paramY: ParamId | null;
  valuesY: number[];
}

export interface SweepResult {
  request: SweepRequest;
  rows: SweepRow[];
  /** Provenance of the engine that produced every row. */
  provenance: string;
  durationMs: number;
}

/** Inclusive list of values from start to end in steps of |step|, limited to the parameter range. */
export function sweepValues(param: ParamId, start: number, end: number, step: number, maxPoints = 60): number[] {
  const magnitude = Math.abs(step);
  if (!(magnitude > 0)) return [clampParam(param, start)];
  const count = Math.min(Math.floor(Math.abs(end - start) / magnitude + 1e-9) + 1, maxPoints);
  const direction = end >= start ? 1 : -1;
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = clampParam(param, start + direction * magnitude * i);
    if (values.length === 0 || Math.abs(values[values.length - 1] - value) > 1e-12) values.push(value);
  }
  return values;
}

const EMPTY: Omit<SweepRow, "x" | "y" | "error"> = {
  valid: false,
  cd: null,
  cdUncertainty: null,
  cl: null,
  clUncertainty: null,
  drag: null,
  downforce: null,
  topSpeed: null,
  efficiency: null,
  accel100: null,
};

/** Evaluates one design point: aerodynamics with the configured engine, then vehicle performance. */
export function evaluatePoint(
  config: SimulationConfig,
  spec: VehicleSpec,
  powertrain: Powertrain,
  x: number,
  y: number | null,
): SweepRow {
  try {
    const { result } = runLocal(config, false);
    const { aero } = result;
    const performance = computePerformance(
      makePerformanceInput(spec, powertrain, config.geometry, aero.coefficients, aero.air.density, config.environment, config.speed),
    );
    const c = aero.coefficients;
    return {
      x,
      y,
      valid: true,
      error: null,
      cd: c.cd,
      cdUncertainty: aero.uncertainty.cd,
      cl: c.cl,
      clUncertainty: aero.uncertainty.cl,
      drag: aero.forces.drag,
      downforce: aero.forces.downforce,
      topSpeed: performance.topSpeed,
      efficiency: -c.cl / c.cd,
      accel100: performance.accelTimes.find((entry) => entry.target === 100)?.time ?? null,
    };
  } catch (error) {
    const message = error instanceof SimulationError || error instanceof Error ? error.message : "Evaluation failed";
    return { x, y, ...EMPTY, error: message };
  }
}

/** Runs a 1D sweep (paramY = null) or a 2D design-space map. */
export function runSweep(
  request: SweepRequest,
  onProgress: (done: number, total: number, rows: SweepRow[]) => void = () => {},
): SweepResult {
  const started = performance.now();
  const { paramX, valuesX, paramY } = request;
  const config = studyConfig(request.config, [paramX, paramY]);
  const valuesY = paramY ? request.valuesY : [Number.NaN];
  const total = valuesX.length * valuesY.length;
  const rows: SweepRow[] = [];
  let provenance = "";

  for (const y of valuesY) {
    for (const x of valuesX) {
      const geometry: GeometryParams = { ...config.geometry, [paramX]: x };
      if (paramY) geometry[paramY] = y;
      const pointConfig: SimulationConfig = { ...config, geometry };
      rows.push(evaluatePoint(pointConfig, request.spec, request.powertrain, x, paramY ? y : null));
      onProgress(rows.length, total, rows);
    }
  }
  if (rows.some((row) => row.valid)) {
    provenance =
      (config.mode === "reduced-order"
        ? `Mode B · Reduced-order (${config.fidelity} grid), computed in the browser`
        : "Mode A · Analytical, computed in the browser") + studySurfaceNote(request.config, config);
  }
  return { request, rows, provenance, durationMs: performance.now() - started };
}

export function describeParam(param: ParamId): string {
  return PARAM_BY_ID[param].label;
}
