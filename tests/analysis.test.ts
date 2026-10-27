import { beforeEach, describe, expect, test } from "vitest";
import { vehicleSpecOf } from "@/lib/simulation/config";
import { clearLocalCache, runLocal } from "@/lib/simulation/engine";
import { explainSweep } from "@/lib/simulation/explain";
import { canonicalJson, hashConfig, hashString } from "@/lib/simulation/hash";
import {
  constraintViolation,
  type DesignMetrics,
  type OptimizationRequest,
  runOptimization,
  seededRandom,
} from "@/lib/simulation/optimize";
import { runSweep, type SweepRequest, sweepValues } from "@/lib/simulation/sweep";
import { SimulationError, type SimulationMode } from "@/lib/types";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { configFor } from "./helpers";

function sweepRequest(vehicleId: string, overrides: Partial<SweepRequest>, mode: SimulationMode = "analytical"): SweepRequest {
  const vehicle = getBuiltInVehicle(vehicleId);
  return {
    config: configFor(vehicleId, {}, { mode }),
    spec: vehicleSpecOf(vehicle),
    powertrain: vehicle.powertrain,
    paramX: "spoilerAngle",
    valuesX: [0, 10, 20, 30],
    paramY: null,
    valuesY: [],
    ...overrides,
  };
}

function optimizationRequest(overrides: Partial<OptimizationRequest> = {}): OptimizationRequest {
  const vehicle = getBuiltInVehicle("fastback");
  return {
    config: configFor("fastback"),
    spec: vehicleSpecOf(vehicle),
    powertrain: vehicle.powertrain,
    objective: "min-drag",
    variables: [
      { param: "rideHeight", min: 0.08, max: 0.2 },
      { param: "spoilerAngle", min: 0, max: 30 },
    ],
    constraints: [],
    algorithm: "differential-evolution",
    iterations: 8,
    seed: 7,
    ...overrides,
  };
}

beforeEach(() => clearLocalCache());

describe("local engine dispatch", () => {
  test("modes that need the backend refuse to compute instead of substituting another model", () => {
    for (const mode of ["cfd", "ml-surrogate"] as const) {
      let caught: unknown;
      try {
        runLocal(configFor("sedan", {}, { mode }), false);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SimulationError);
      expect((caught as SimulationError).code).toBe("BACKEND_REQUIRED");
      expect((caught as SimulationError).message).toContain("Nothing was computed");
    }
  });

  test("results carry the mode that produced them", () => {
    const analytical = runLocal(configFor("sedan"), false).result.aero;
    expect(analytical.mode).toBe("analytical");
    expect(analytical.provenance).not.toMatch(/\bCFD\b(?! solution)/);
    const reduced = runLocal(configFor("sedan", {}, { mode: "reduced-order" }), false).result.aero;
    expect(reduced.mode).toBe("reduced-order");
    expect(reduced.solver?.converged).toBe(true);
  });

  test("the visualisation field is labelled as a reduced-order field, never as CFD", () => {
    const { field } = runLocal(configFor("hatchback"), true);
    expect(field).not.toBeNull();
    expect(field!.provenance).toContain("Not a CFD solution");
    expect(field!.u.length).toBe(field!.nx * field!.ny * field!.nz);
  });

  test("identical configurations are served from the cache; the gradient does not change the aerodynamics", () => {
    const config = configFor("fastback");
    const first = runLocal(config, false).result;
    const second = runLocal(config, false).result;
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.aero).toBe(first.aero);
    const uphill = runLocal(configFor("fastback", {}, { environment: { gradient: 5 } }), false).result;
    expect(uphill.cached).toBe(true);
    expect(uphill.hash).not.toBe(first.hash);
    expect(runLocal(configFor("fastback", { rideHeight: 0.09 }), false).result.cached).toBe(false);
  });

  test("an unbuildable geometry raises an error with the reason", () => {
    const config = configFor("sedan", { hoodLength: 1.9, rearDeckLength: 1.2, windshieldAngle: 18 });
    expect(() => runLocal(config, false)).toThrowError(/roof/i);
  });
});

describe("configuration hash", () => {
  test("is independent of key order and float noise, and sensitive to real changes", () => {
    expect(canonicalJson({ b: 1, a: [1, 2, { d: null, c: "x" }] })).toBe('{"a":[1,2,{"c":"x","d":null}],"b":1}');
    expect(canonicalJson({ a: 0.1 + 0.2 })).toBe(canonicalJson({ a: 0.3 }));
    expect(canonicalJson({ a: Number.NaN })).toBe('{"a":null}');
    expect(hashString("aerolab")).toMatch(/^[0-9a-f]{16}$/);
    expect(hashString("aerolab")).toBe(hashString("aerolab"));
    expect(hashString("aerolab")).not.toBe(hashString("aerolaB"));

    const config = configFor("sedan");
    const reordered = { ...config, geometry: Object.fromEntries(Object.entries(config.geometry).reverse()) as typeof config.geometry };
    expect(hashConfig(reordered)).toBe(hashConfig(config));
    expect(hashConfig(configFor("sedan", { rideHeight: config.geometry.rideHeight + 0.001 }))).not.toBe(hashConfig(config));
    expect(hashConfig({ ...config, mode: "reduced-order" })).not.toBe(hashConfig(config));
    expect(hashConfig({ ...config, speed: config.speed + 1 })).not.toBe(hashConfig(config));
  });
});

describe("parameter sweep", () => {
  test("sweep values are inclusive, ordered and limited to the parameter range", () => {
    expect(sweepValues("spoilerAngle", 0, 30, 10)).toEqual([0, 10, 20, 30]);
    expect(sweepValues("spoilerAngle", 30, 0, 10)).toEqual([30, 20, 10, 0]);
    expect(sweepValues("spoilerAngle", 0, 30, -10)).toEqual([0, 10, 20, 30]);
    expect(sweepValues("spoilerAngle", 10, 30, 0)).toEqual([10]);
    // Beyond the range every value clamps to the limit and duplicates are dropped.
    expect(sweepValues("spoilerAngle", 60, 90, 10)).toEqual([60, 70]);
    expect(sweepValues("rideHeight", 0.05, 0.32, 0.001).length).toBe(60);
    expect(sweepValues("rideHeight", 0.05, 0.32, 0.001, 500).length).toBe(271);
  });

  test("a spoiler-angle sweep reports every point and a falling lift coefficient", () => {
    const progress: number[] = [];
    const result = runSweep(sweepRequest("fastback", {}), (done, total) => progress.push(done / total));
    expect(result.rows.map((row) => row.x)).toEqual([0, 10, 20, 30]);
    expect(result.rows.every((row) => row.valid && row.y === null && row.error === null)).toBe(true);
    const lifts = result.rows.map((row) => row.cl!);
    expect(lifts).toEqual([...lifts].sort((a, b) => b - a));
    for (const row of result.rows) {
      expect(row.efficiency).toBeCloseTo(-row.cl! / row.cd!, 12);
      expect(row.cdUncertainty).toBeGreaterThan(0);
      expect(row.topSpeed).toBeGreaterThan(50);
      expect(row.accel100).toBeGreaterThan(3);
    }
    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
    expect(result.provenance).toContain("Mode A");
    expect(result.provenance).not.toContain("CFD");
  });

  test("the sweep leaves the configuration it was given untouched", () => {
    const request = sweepRequest("fastback", {});
    const before = JSON.stringify(request.config);
    runSweep(request);
    expect(JSON.stringify(request.config)).toBe(before);
  });

  test("a design-space map marks points that cannot be built, with the reason and no numbers", () => {
    const result = runSweep(
      sweepRequest("sedan", { paramX: "hoodLength", valuesX: [1.15, 1.9], paramY: "rearDeckLength", valuesY: [0.55, 1.2] }),
    );
    expect(result.rows.map((row) => [row.x, row.y])).toEqual([
      [1.15, 0.55],
      [1.9, 0.55],
      [1.15, 1.2],
      [1.9, 1.2],
    ]);
    expect(result.rows[0].valid).toBe(true);
    const impossible = result.rows[3];
    expect(impossible.valid).toBe(false);
    expect(impossible.error).toMatch(/roof/i);
    expect([impossible.cd, impossible.cl, impossible.drag, impossible.topSpeed, impossible.accel100]).toEqual([null, null, null, null, null]);
  });

  test("a reduced-order sweep is labelled as Mode B", () => {
    const result = runSweep(sweepRequest("fastback", { paramX: "rideHeight", valuesX: [0.09, 0.15] }, "reduced-order"));
    expect(result.rows.every((row) => row.valid)).toBe(true);
    expect(result.provenance).toContain("Mode B");
    // Lower ride height: less lift.
    expect(result.rows[0].cl!).toBeLessThan(result.rows[1].cl!);
  });
});

describe("sweep explanation", () => {
  test("states the computed change, the model's mechanism, and that it is not a measurement", () => {
    const result = runSweep(sweepRequest("fastback", {}));
    const text = explainSweep(result, "automotive");
    expect(text[0]).toContain("Increasing rear spoiler angle from 0.0 to 30.0 °");
    expect(text[0]).toContain("km/h");
    expect(text.some((paragraph) => paragraph.startsWith("In these models a steeper spoiler blade"))).toBe(true);
    const caveat = text[text.length - 1];
    expect(caveat).toContain("simplified model");
    expect(caveat).toContain("not measurements");
    expect(caveat).toContain("Mode A");
    expect(explainSweep(result, "si")[0]).toContain("m/s");
  });

  test("reports a reversing trend instead of only the end-to-end change", () => {
    const result = runSweep(sweepRequest("sedan", { paramX: "diffuserAngle", valuesX: [0, 5, 10, 15, 20] }));
    expect(explainSweep(result, "si").some((paragraph) => paragraph.includes("not monotonic"))).toBe(true);
  });

  test("declines to describe a trend from fewer than two valid points", () => {
    const result = runSweep(sweepRequest("fastback", { valuesX: [10] }));
    expect(explainSweep(result, "si")).toEqual(["Fewer than two points could be simulated, so no trend can be reported."]);
  });
});

describe("optimiser", () => {
  const metrics: DesignMetrics = { cd: 0.3, cl: -0.1, drag: 400, downforce: 130, topSpeed: 70, efficiency: 0.33 };

  test("the random generator is reproducible", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const values = Array.from({ length: 200 }, () => a());
    expect(values).toEqual(Array.from({ length: 200 }, () => b()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(seededRandom(43)()).not.toBe(values[0]);
  });

  test("constraint violation is zero when satisfied and normalised by the limit otherwise", () => {
    expect(constraintViolation([{ metric: "downforce", op: ">=", value: 100 }], metrics)).toBe(0);
    expect(constraintViolation([{ metric: "downforce", op: ">=", value: 200 }], metrics)).toBeCloseTo(70 / 200, 12);
    expect(constraintViolation([{ metric: "cd", op: "<=", value: 0.25 }], metrics)).toBeCloseTo(0.05 / 0.25, 12);
    expect(
      constraintViolation(
        [
          { metric: "downforce", op: ">=", value: 200 },
          { metric: "cd", op: "<=", value: 0.25 },
        ],
        metrics,
      ),
    ).toBeCloseTo(0.35 + 0.2, 12);
  });

  test("minimising drag never ends worse than the starting design, and improves monotonically", () => {
    const steps: number[] = [];
    const result = runOptimization(optimizationRequest(), (step) => steps.push(step.iteration));
    expect(steps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.best.feasible).toBe(true);
    expect(result.best.metrics.drag).toBeLessThanOrEqual(result.baseline.metrics.drag);
    for (let i = 1; i < result.history.length; i++) {
      expect(result.history[i].metrics.drag).toBeLessThanOrEqual(result.history[i - 1].metrics.drag + 1e-9);
    }
    // 1 baseline + the first generation + one trial per member per iteration.
    expect(result.evaluations).toBe(1 + 16 + 8 * 16);
    expect(result.best.values.rideHeight).toBeGreaterThanOrEqual(0.08);
    expect(result.best.values.rideHeight).toBeLessThanOrEqual(0.2);
    expect(result.best.geometry.spoilerAngle).toBe(result.best.values.spoilerAngle);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThanOrEqual(5);
    expect(result.candidates[0].metrics.drag).toBeCloseTo(result.best.metrics.drag, 9);
    expect(result.provenance).toContain("Mode A");
  });

  test("the same seed gives the same search; a different seed explores differently", () => {
    const first = runOptimization(optimizationRequest({ iterations: 4 }));
    const again = runOptimization(optimizationRequest({ iterations: 4 }));
    expect(again.best.values).toEqual(first.best.values);
    expect(again.history).toEqual(first.history);
    const other = runOptimization(optimizationRequest({ iterations: 1, seed: 99 }));
    expect(other.history[0].metrics).not.toEqual(runOptimization(optimizationRequest({ iterations: 1 })).history[0].metrics);
  });

  test("constraints are honoured: the best design is feasible and trades top speed for downforce", () => {
    const free = runOptimization(optimizationRequest({ objective: "max-top-speed" }));
    const target = free.best.metrics.downforce + 60;
    const constrained = runOptimization(
      optimizationRequest({ objective: "max-top-speed", constraints: [{ metric: "downforce", op: ">=", value: target }] }),
    );
    expect(constrained.best.feasible).toBe(true);
    expect(constrained.best.violation).toBe(0);
    expect(constrained.best.metrics.downforce).toBeGreaterThanOrEqual(target);
    expect(constrained.best.metrics.topSpeed).toBeLessThanOrEqual(free.best.metrics.topSpeed + 1e-9);
  });

  test("targets that cannot be met are reported as infeasible, not as a solution", () => {
    const result = runOptimization(
      optimizationRequest({ objective: "meet-targets", iterations: 4, constraints: [{ metric: "downforce", op: ">=", value: 50000 }] }),
    );
    expect(result.best.feasible).toBe(false);
    expect(result.best.violation).toBeGreaterThan(0);
    expect(result.history.every((step) => !step.feasible)).toBe(true);
  });

  test("an empty variable list is rejected", () => {
    expect(() => runOptimization(optimizationRequest({ variables: [] }))).toThrowError(/at least one design variable/);
  });
});
