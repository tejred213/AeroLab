/**
 * Design optimisation over geometry parameters with differential evolution
 * (a population-based evolutionary algorithm). Constraints are handled with
 * feasibility rules: a feasible design always beats an infeasible one, and
 * infeasible designs are ranked by how much they violate the constraints.
 *
 * The optimiser only searches; every candidate is scored by the configured
 * simulation engine, so its results inherit that engine's limitations.
 * backend/optimization mirrors the types and adds SciPy / Bayesian search.
 */
import type { GeometryParams, ParamId, Powertrain, SimulationConfig, VehicleSpec } from "@/lib/types";
import { studyConfig, studySurfaceNote } from "@/lib/geometry/sampledBody";
import { makePerformanceInput } from "@/lib/simulation/config";
import { runLocal } from "@/lib/simulation/engine";
import { solveTopSpeed } from "@/lib/vehicle/performance";

export type Objective = "min-drag" | "max-downforce" | "max-top-speed" | "max-efficiency" | "meet-targets";

export const OBJECTIVES: { id: Objective; label: string }[] = [
  { id: "min-drag", label: "Minimize drag" },
  { id: "max-downforce", label: "Maximize downforce" },
  { id: "max-top-speed", label: "Maximize top speed" },
  { id: "max-efficiency", label: "Maximize aerodynamic efficiency" },
  { id: "meet-targets", label: "Find designs that meet all targets" },
];

export type ConstraintMetric = "cd" | "cl" | "drag" | "downforce" | "topSpeed" | "efficiency";

export interface Constraint {
  metric: ConstraintMetric;
  op: ">=" | "<=";
  /** SI value. */
  value: number;
}

export interface DesignVariable {
  param: ParamId;
  min: number;
  max: number;
}

export type OptimizationAlgorithm = "differential-evolution" | "bayesian";

export interface OptimizationRequest {
  config: SimulationConfig;
  spec: VehicleSpec;
  powertrain: Powertrain;
  objective: Objective;
  variables: DesignVariable[];
  constraints: Constraint[];
  algorithm: OptimizationAlgorithm;
  iterations: number;
  seed: number;
}

export interface DesignMetrics {
  cd: number;
  cl: number;
  drag: number;
  downforce: number;
  topSpeed: number;
  efficiency: number;
}

export interface OptimizationStep {
  iteration: number;
  evaluations: number;
  feasible: boolean;
  /** Total normalised constraint violation of the best design (0 when feasible). */
  violation: number;
  metrics: DesignMetrics;
}

export interface Candidate {
  geometry: GeometryParams;
  values: Partial<Record<ParamId, number>>;
  metrics: DesignMetrics;
  feasible: boolean;
  violation: number;
}

export interface OptimizationResult {
  request: OptimizationRequest;
  history: OptimizationStep[];
  best: Candidate;
  baseline: Candidate;
  /** Best distinct designs of the final population. */
  candidates: Candidate[];
  evaluations: number;
  algorithm: string;
  provenance: string;
  durationMs: number;
}

/** Deterministic pseudo-random generator (mulberry32) so optimisation runs are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Scored {
  x: number[];
  metrics: DesignMetrics | null;
  objective: number;
  violation: number;
}

function objectiveValue(objective: Objective, metrics: DesignMetrics): number {
  switch (objective) {
    case "min-drag":
      return metrics.drag;
    case "max-downforce":
      return -metrics.downforce;
    case "max-top-speed":
      return -metrics.topSpeed;
    case "max-efficiency":
      return -metrics.efficiency;
    case "meet-targets":
      return 0;
  }
}

/** Sum of constraint violations, each normalised by the size of its limit. */
export function constraintViolation(constraints: Constraint[], metrics: DesignMetrics): number {
  let total = 0;
  for (const constraint of constraints) {
    const value = metrics[constraint.metric];
    const excess = constraint.op === ">=" ? constraint.value - value : value - constraint.value;
    if (excess > 0) total += excess / Math.max(Math.abs(constraint.value), 1e-3);
  }
  return total;
}

/** Feasibility rules (Deb): true when a is at least as good as b. */
function betterOrEqual(a: Scored, b: Scored): boolean {
  if (a.violation <= 0 && b.violation <= 0) return a.objective <= b.objective;
  if (a.violation <= 0) return true;
  if (b.violation <= 0) return false;
  return a.violation <= b.violation;
}

export function geometryFor(request: OptimizationRequest, x: number[]): GeometryParams {
  const geometry: GeometryParams = { ...request.config.geometry };
  request.variables.forEach((variable, index) => {
    geometry[variable.param] = x[index];
  });
  return geometry;
}

/** Aerodynamics (configured engine) + top speed for one design. Returns null if it cannot be simulated. */
export function evaluateDesign(request: OptimizationRequest, geometry: GeometryParams): DesignMetrics | null {
  try {
    const variedParams = request.variables.map((variable) => variable.param);
    const config: SimulationConfig = { ...studyConfig(request.config, variedParams), geometry };
    const { aero } = runLocal(config, false).result;
    const c = aero.coefficients;
    const { topSpeed } = solveTopSpeed(
      makePerformanceInput(request.spec, request.powertrain, geometry, c, aero.air.density, config.environment, config.speed),
    );
    return {
      cd: c.cd,
      cl: c.cl,
      drag: aero.forces.drag,
      downforce: aero.forces.downforce,
      topSpeed,
      efficiency: -c.cl / c.cd,
    };
  } catch {
    return null;
  }
}

function toCandidate(request: OptimizationRequest, scored: Scored): Candidate {
  const values: Partial<Record<ParamId, number>> = {};
  request.variables.forEach((variable, index) => {
    values[variable.param] = scored.x[index];
  });
  return {
    geometry: geometryFor(request, scored.x),
    values,
    metrics: scored.metrics ?? { cd: NaN, cl: NaN, drag: NaN, downforce: NaN, topSpeed: NaN, efficiency: NaN },
    feasible: scored.metrics !== null && scored.violation <= 0,
    violation: scored.violation,
  };
}

const INVALID_VIOLATION = 1e6;

export function runOptimization(
  request: OptimizationRequest,
  onProgress: (step: OptimizationStep, total: number) => void = () => {},
): OptimizationResult {
  const started = performance.now();
  const dimension = request.variables.length;
  if (dimension === 0) throw new Error("Select at least one design variable.");
  const random = seededRandom(request.seed);
  const populationSize = Math.min(Math.max(8 * dimension, 12), 40);
  const differentialWeight = 0.7;
  const crossover = 0.9;
  let evaluations = 0;

  const score = (x: number[]): Scored => {
    evaluations++;
    const metrics = evaluateDesign(request, geometryFor(request, x));
    if (!metrics) return { x, metrics: null, objective: Infinity, violation: INVALID_VIOLATION };
    return {
      x,
      metrics,
      objective: objectiveValue(request.objective, metrics),
      violation: constraintViolation(request.constraints, metrics),
    };
  };

  const clampTo = (value: number, index: number) =>
    Math.min(Math.max(value, request.variables[index].min), request.variables[index].max);

  // The current design is always part of the first generation.
  const start = request.variables.map((variable, index) => clampTo(request.config.geometry[variable.param], index));
  const baselineScored = score(request.variables.map((variable) => request.config.geometry[variable.param]));
  let population: Scored[] = [score(start)];
  while (population.length < populationSize) {
    population.push(
      score(request.variables.map((variable) => variable.min + random() * (variable.max - variable.min))),
    );
  }

  const bestOf = (members: Scored[]) =>
    members.reduce((best, member) => (betterOrEqual(member, best) ? member : best), members[0]);

  const history: OptimizationStep[] = [];
  const record = (iteration: number) => {
    const best = bestOf(population);
    if (!best.metrics) return;
    const step: OptimizationStep = {
      iteration,
      evaluations,
      feasible: best.violation <= 0,
      violation: best.violation,
      metrics: best.metrics,
    };
    history.push(step);
    onProgress(step, request.iterations);
  };
  record(0);

  for (let iteration = 1; iteration <= request.iterations; iteration++) {
    const next: Scored[] = [];
    for (let i = 0; i < populationSize; i++) {
      // DE/rand/1/bin: mutate three distinct members, cross with the target.
      let a = i;
      let b = i;
      let c = i;
      while (a === i) a = Math.floor(random() * populationSize);
      while (b === i || b === a) b = Math.floor(random() * populationSize);
      while (c === i || c === a || c === b) c = Math.floor(random() * populationSize);
      const forced = Math.floor(random() * dimension);
      const trial = population[i].x.map((value, d) => {
        if (random() < crossover || d === forced) {
          return clampTo(population[a].x[d] + differentialWeight * (population[b].x[d] - population[c].x[d]), d);
        }
        return value;
      });
      const scored = score(trial);
      next.push(betterOrEqual(scored, population[i]) ? scored : population[i]);
    }
    population = next;
    record(iteration);
  }

  // Distinct candidates from the final population, best first.
  const ordered = [...population].sort((p, q) => (betterOrEqual(p, q) ? (betterOrEqual(q, p) ? 0 : -1) : 1));
  const candidates: Candidate[] = [];
  for (const member of ordered) {
    if (!member.metrics) continue;
    const distinct = candidates.every((existing) =>
      request.variables.some((variable, d) => {
        const span = variable.max - variable.min || 1;
        return Math.abs((existing.values[variable.param] ?? 0) - member.x[d]) / span > 0.02;
      }),
    );
    if (distinct) candidates.push(toCandidate(request, member));
    if (candidates.length >= 5) break;
  }

  return {
    request,
    history,
    best: toCandidate(request, bestOf(population)),
    baseline: toCandidate(request, baselineScored),
    candidates,
    evaluations,
    algorithm: `Differential evolution (rand/1/bin, population ${populationSize})`,
    provenance:
      (request.config.mode === "reduced-order"
        ? `Scored with Mode B · Reduced-order (${request.config.fidelity} grid), in the browser`
        : "Scored with Mode A · Analytical, in the browser") +
      studySurfaceNote(
        request.config,
        studyConfig(
          request.config,
          request.variables.map((variable) => variable.param),
        ),
      ),
    durationMs: performance.now() - started,
  };
}
