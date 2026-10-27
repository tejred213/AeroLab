import { describe, expect, test } from "vitest";
import { computeMetrics } from "@/lib/geometry/metrics";
import { buildBodyShape } from "@/lib/geometry/profile";
import { buildSolidModel, insideBody, wakeHalfWidth } from "@/lib/geometry/solids";
import { MODEL } from "@/lib/physics/model";
import { computeRearFlow } from "@/lib/physics/rearFlow";
import { runLocal } from "@/lib/simulation/engine";
import { CELL_FLUID, CELL_SOLID, CELL_WAKE, createFieldSample, sampleField } from "@/lib/simulation/field";
import { buildGrid, computeApertures, markActiveCells, solvePotential } from "@/lib/simulation/potentialFlow";
import { runReducedOrder, solveVisualizationField } from "@/lib/simulation/reducedOrderEngine";
import { probeCentreline } from "@/lib/simulation/surfaceProbe";
import { BUILT_IN_VEHICLES, getBuiltInVehicle } from "@/lib/vehicle/library";
import { configFor } from "./helpers";

const CALIBRATION_SPEED = MODEL.calibration.speed;

describe("rear-flow closure", () => {
  const rearFlowOf = (vehicleId: string, changes = {}) => {
    const shape = buildBodyShape({ ...getBuiltInVehicle(vehicleId).geometry, ...changes });
    return computeRearFlow(shape, computeMetrics(shape).frontalArea);
  };

  test("shallow slopes stay attached, steep ones separate at the roof edge", () => {
    const fastback = rearFlowOf("fastback");
    const hatchback = rearFlowOf("hatchback");
    expect(fastback.separationFraction).toBeLessThan(0.01);
    expect(hatchback.separationFraction).toBeGreaterThan(0.99);
    expect(hatchback.baseArea).toBeGreaterThan(fastback.baseArea);
    expect(hatchback.basePressureCoefficient).toBeLessThan(fastback.basePressureCoefficient);
    expect(hatchback.vortexDrag).toBeLessThan(1e-6);
    expect(fastback.vortexDrag).toBeGreaterThan(0);
  });

  test("a steep window on a notchback forms a bubble that re-attaches on the deck", () => {
    const bubble = rearFlowOf("sedan", { rearWindowAngle: 50 });
    expect(bubble.separationFraction).toBeLessThan(0.2);
    expect(bubble.bubbleFraction).toBeGreaterThan(0.8);
    expect(rearFlowOf("sedan").bubbleFraction).toBeLessThan(0.15);
  });

  test("boat-tailing raises base pressure", () => {
    expect(rearFlowOf("sedan", { rearTaper: 0.25 }).basePressureCoefficient).toBeGreaterThan(
      rearFlowOf("sedan", { rearTaper: 0 }).basePressureCoefficient,
    );
  });
});

describe("cut-cell potential-flow solver", () => {
  const geometry = getBuiltInVehicle("fastback").geometry;
  const shape = buildBodyShape(geometry);
  const metrics = computeMetrics(shape);
  const grid = buildGrid(
    { length: metrics.length, width: geometry.width, rideHeight: geometry.rideHeight, roofHeight: geometry.roofHeight },
    "coarse",
    true,
  );
  const model = buildSolidModel(shape, computeRearFlow(shape, metrics.frontalArea), { x: 0.12, y: 0.1 });

  test("the grid has faces exactly on the floor, roof, nose and tail", () => {
    const has = (faces: Float64Array, value: number) => Array.from(faces).some((face) => Math.abs(face - value) < 1e-9);
    expect(has(grid.zf, geometry.rideHeight)).toBe(true);
    expect(has(grid.zf, geometry.rideHeight + geometry.roofHeight)).toBe(true);
    expect(has(grid.xf, 0)).toBe(true);
    expect(has(grid.xf, metrics.length)).toBe(true);
    expect(has(grid.yf, geometry.width / 2)).toBe(true);
    expect(grid.yf[0]).toBe(0);
    for (const faces of [grid.xf, grid.yf, grid.zf]) {
      for (let i = 1; i < faces.length; i++) expect(faces[i]).toBeGreaterThan(faces[i - 1]);
    }
  });

  test("apertures are fractions, closed inside the body and open far away", () => {
    const apertures = computeApertures(grid, model);
    for (const array of [apertures.ux, apertures.uy, apertures.uz, apertures.bx, apertures.by, apertures.bz]) {
      for (let n = 0; n < array.length; n++) {
        if (array[n] < 0 || array[n] > 1) throw new Error("aperture outside [0, 1]");
      }
    }
    // Adding the wake can only close openings.
    for (let n = 0; n < apertures.ux.length; n++) expect(apertures.ux[n]).toBeLessThanOrEqual(apertures.bx[n] + 1e-6);
    const active = markActiveCells(grid, apertures);
    const locate = (centres: Float64Array, value: number) => centres.findIndex((centre) => centre > value);
    const cell = (x: number, y: number, z: number) =>
      locate(grid.xc, x) + grid.nx * (locate(grid.yc, y) + grid.ny * locate(grid.zc, z));
    expect(active[cell(2.4, 0.2, 0.7)]).toBe(0); // inside the cabin
    expect(active[cell(-3, 0.5, 1.0)]).toBe(1); // upstream
    expect(active[cell(2.4, 0.3, 0.05)]).toBe(1); // under the floor
    expect(active[cell(metrics.length + 0.3, 0.1, 0.6)]).toBe(0); // inside the wake body
  });

  test("the linear solve converges to the requested tolerance", () => {
    const apertures = computeApertures(grid, model);
    const active = markActiveCells(grid, apertures);
    const progress: number[] = [];
    const solution = solvePotential(grid, apertures, active, {
      yawDeg: 0,
      tolerance: 1e-6,
      onProgress: (fraction) => progress.push(fraction),
    });
    expect(solution.converged).toBe(true);
    expect(solution.residual).toBeLessThanOrEqual(1e-6);
    expect(solution.iterations).toBeGreaterThan(50);
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.every((fraction, i) => fraction >= 0 && fraction < 1 && (i === 0 || fraction >= progress[i - 1] - 0.2))).toBe(true);
  });

  test("the solid model agrees with the profile it was built from", () => {
    const scratch = new Float64Array(16);
    expect(insideBody(model, 2.4, 0.3, 0.7, scratch)).toBe(true);
    expect(insideBody(model, 2.4, 0.3, 0.05, scratch)).toBe(false); // under the floor
    expect(insideBody(model, 2.4, 1.5, 0.7, scratch)).toBe(false); // beside the car
    expect(insideBody(model, shape.frontAxleX, shape.wheelCentreY, 0.05, scratch)).toBe(true); // inside a tyre
    expect(wakeHalfWidth(model, metrics.length + 0.2, 0.6)).toBeGreaterThan(0.5);
    expect(wakeHalfWidth(model, 1.0, 1.5)).toBe(0);
  });
});

describe("Mode B · reduced-order engine", () => {
  test.each(BUILT_IN_VEHICLES.map((vehicle) => [vehicle.id, vehicle] as const))(
    "%s: the reference geometry reproduces the class reference coefficients",
    (id, vehicle) => {
      const { aero } = runReducedOrder(configFor(id, {}, { speed: CALIBRATION_SPEED, mode: "reduced-order" }));
      expect(aero.coefficients.cd).toBeCloseTo(vehicle.reference.cd, 6);
      expect(aero.coefficients.cl).toBeCloseTo(vehicle.reference.cl, 6);
      expect(aero.solver?.converged).toBe(true);
    },
  );

  test("the result is labelled reduced-order and separates solved from closure terms", () => {
    const { aero } = runReducedOrder(configFor("sedan", {}, { mode: "reduced-order" }));
    expect(aero.mode).toBe("reduced-order");
    expect(aero.provenance).toMatch(/^Mode B/);
    expect(aero.provenance).toMatch(/not CFD/);
    const labels = aero.breakdown.drag.map((item) => item.label).join(" | ");
    expect(labels).toMatch(/\(integrated\)/);
    expect(labels).toMatch(/\(closure\)/);
    expect(aero.solver!.fluidCells).toBeLessThan(aero.solver!.cells);
    expect(aero.assumptions.some((assumption) => /inviscid/.test(assumption))).toBe(true);
  });

  test("lowering the car reduces lift and drag smoothly", () => {
    const heights = [0.17, 0.15, 0.13, 0.11, 0.09, 0.07];
    const runs = heights.map(
      (rideHeight) => runReducedOrder(configFor("fastback", { rideHeight }, { mode: "reduced-order" })).aero,
    );
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].coefficients.cl).toBeLessThan(runs[i - 1].coefficients.cl);
      expect(runs[i].coefficients.cd).toBeLessThan(runs[i - 1].coefficients.cd);
    }
    // No step-to-step jump larger than a few times the average step: the response is smooth.
    const steps = runs.slice(1).map((run, i) => runs[i].coefficients.cl - run.coefficients.cl);
    const mean = steps.reduce((sum, step) => sum + step, 0) / steps.length;
    for (const step of steps) expect(step).toBeLessThan(3 * mean);
  });

  test("coarse and medium grids agree on the effect of a change", () => {
    const delta = (fidelity: "coarse" | "medium") => {
      const run = (rideHeight: number) =>
        runReducedOrder({ ...configFor("fastback", { rideHeight }, { mode: "reduced-order" }), fidelity }).aero.coefficients;
      const high = run(0.15);
      const low = run(0.09);
      return { cd: low.cd - high.cd, cl: low.cl - high.cl };
    };
    const coarse = delta("coarse");
    const medium = delta("medium");
    expect(Math.sign(medium.cd)).toBe(Math.sign(coarse.cd));
    expect(Math.sign(medium.cl)).toBe(Math.sign(coarse.cl));
    expect(Math.abs(medium.cl - coarse.cl)).toBeLessThan(0.5 * Math.abs(coarse.cl));
    expect(Math.abs(medium.cd - coarse.cd)).toBeLessThan(0.5 * Math.abs(coarse.cd));
  });

  test("a rear wing adds downforce in both modes", () => {
    const base = runReducedOrder(configFor("fastback", {}, { mode: "reduced-order" })).aero;
    const wing = runReducedOrder(configFor("fastback", { wingChord: 0.3, wingAngle: 10 }, { mode: "reduced-order" })).aero;
    expect(wing.coefficients.cl).toBeLessThan(base.coefficients.cl - 0.05);
    expect(wing.coefficients.cd).toBeGreaterThan(base.coefficients.cd);
  });

  test("crosswind is solved on the full width", () => {
    const { aero, field } = runReducedOrder(
      configFor("suv", {}, { mode: "reduced-order", environment: { windSpeed: 10, windAngle: 60 } }),
    );
    expect(field!.symmetric).toBe(false);
    expect(aero.solver!.gridSize[1]).toBeGreaterThan(40);
    expect(aero.coefficients.cs).toBeGreaterThan(0);
    const sample = createFieldSample();
    sampleField(field!, -4, 0, 2, sample);
    expect(sample.v).toBeGreaterThan(0.05); // the onset flow has a lateral component
  });

  test("the engine cache returns an identical run without solving again", () => {
    const config = configFor("hatchback", { rideHeight: 0.151 }, { mode: "reduced-order" });
    const first = runLocal(config, false);
    const second = runLocal(config, false);
    expect(first.result.cached).toBe(false);
    expect(second.result.cached).toBe(true);
    expect(second.result.aero.coefficients).toEqual(first.result.aero.coefficients);
  });
});

describe("flow field used for visualisation", () => {
  const config = configFor("fastback");
  const field = solveVisualizationField(config);
  const sample = createFieldSample();
  const speedAt = (x: number, y: number, z: number) => {
    sampleField(field, x, y, z, sample);
    return Math.hypot(sample.u, sample.v, sample.w);
  };

  test("is labelled as a reduced-order field, not CFD", () => {
    expect(field.provenance).toMatch(/Not a CFD solution/);
    expect(field.provenance).toMatch(/synthetic/);
    expect(field.symmetric).toBe(true);
    expect(field.u.length).toBe(field.nx * field.ny * field.nz);
  });

  test("contains fluid, solid and wake cells", () => {
    const kinds = new Set(field.kind);
    expect(kinds.has(CELL_FLUID) && kinds.has(CELL_SOLID) && kinds.has(CELL_WAKE)).toBe(true);
    sampleField(field, 2.4, 0.1, 0.7, sample);
    expect(sample.kind).toBe(CELL_SOLID);
    sampleField(field, 5.2, 0.1, 0.7, sample);
    expect(sample.kind).toBe(CELL_WAKE);
  });

  test("the flow is undisturbed far upstream and stagnates at the nose", () => {
    expect(speedAt(-4.5, 0.5, 1.5)).toBeCloseTo(1, 1);
    sampleField(field, -0.12, 0.05, 0.42, sample);
    expect(sample.cp).toBeGreaterThan(0.5);
    expect(sample.u).toBeLessThan(0.7);
  });

  test("air accelerates over the roof and the pressure there is below ambient", () => {
    const roofTop = config.geometry.rideHeight + config.geometry.roofHeight;
    expect(speedAt(2.8, 0.05, roofTop + 0.12)).toBeGreaterThan(1.05);
    sampleField(field, 2.8, 0.05, roofTop + 0.12, sample);
    expect(sample.cp).toBeLessThan(-0.1);
  });

  test("flow is mirror-symmetric about the centre plane", () => {
    sampleField(field, 1.0, 1.2, 0.8, sample);
    const right = { ...sample };
    sampleField(field, 1.0, -1.2, 0.8, sample);
    expect(sample.u).toBeCloseTo(right.u, 9);
    expect(sample.v).toBeCloseTo(-right.v, 9);
    expect(sample.w).toBeCloseTo(right.w, 9);
    // The body pushes the air outward on each side.
    sampleField(field, 0.2, 1.1, 0.5, sample);
    expect(sample.v).toBeGreaterThan(0);
  });

  test("the wake holds reversed flow on its centreline (empirical model)", () => {
    sampleField(field, 5.3, 0.05, 0.62, sample);
    expect(sample.kind).toBe(CELL_WAKE);
    expect(sample.u).toBeLessThan(0);
    expect(sample.ti).toBeGreaterThan(0.1);
  });

  test("the centreline probe returns a Cp distribution with a stagnation peak and roof suction", () => {
    const probe = probeCentreline(field, config.geometry);
    const upper = probe.map((point) => point.cpUpper).filter((cp): cp is number => cp !== null);
    expect(upper.length).toBeGreaterThan(50);
    expect(Math.max(...upper)).toBeGreaterThan(0.3);
    expect(Math.min(...upper)).toBeLessThan(-0.3);
    expect(Math.max(...upper)).toBeLessThanOrEqual(1.0001);
  });

  test("points outside the domain return the freestream", () => {
    sampleField(field, 200, 0, 1, sample);
    expect(sample.inside).toBe(false);
    expect(sample.u).toBeCloseTo(1, 12);
    expect(sample.v).toBeCloseTo(0, 12);
  });
});
