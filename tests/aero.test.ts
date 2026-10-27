import { describe, expect, test } from "vitest";
import { MODEL } from "@/lib/physics/model";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { clearLocalCache, runLocal } from "@/lib/simulation/engine";
import { canonicalJson, hashConfig, hashString } from "@/lib/simulation/hash";
import { SimulationError } from "@/lib/types";
import { BUILT_IN_VEHICLES } from "@/lib/vehicle/library";
import { configFor, evaluate, KMH } from "./helpers";

const CALIBRATION_SPEED = MODEL.calibration.speed;
const codesOf = (warnings: { code: string }[]) => warnings.map((warning) => warning.code);

describe("Mode A · analytical engine", () => {
  test.each(BUILT_IN_VEHICLES.map((vehicle) => [vehicle.id, vehicle] as const))(
    "%s: the reference geometry reproduces the class reference coefficients",
    (id, vehicle) => {
      const aero = runAnalytical(configFor(id, {}, { speed: CALIBRATION_SPEED }));
      // Standard air differs from the calibration air in the 5th digit of density, hence 6 decimals.
      expect(aero.coefficients.cd).toBeCloseTo(vehicle.reference.cd, 6);
      expect(aero.coefficients.cl).toBeCloseTo(vehicle.reference.cl, 6);
      // The raw build-up is in the right neighbourhood on its own: the calibration is a correction, not a rescue.
      expect(Math.abs(aero.calibration.cdOffset)).toBeLessThan(0.06);
      expect(Math.abs(aero.calibration.clOffset)).toBeLessThan(0.06);
    },
  );

  test("the result states its mode, its provenance and its uncertainty", () => {
    const aero = runAnalytical(configFor("sedan"));
    expect(aero.mode).toBe("analytical");
    expect(aero.provenance).toMatch(/^Mode A/);
    expect(aero.provenance).toMatch(/No flow field is solved/);
    expect(aero.provenance).not.toMatch(/\bCFD\b/);
    expect(aero.uncertainty.cd).toBeGreaterThan(0.005);
    expect(aero.uncertainty.cl).toBeGreaterThan(0.02);
    expect(aero.assumptions.length).toBeGreaterThan(5);
  });

  test("uncertainty grows as the geometry moves away from the reference", () => {
    const near = runAnalytical(configFor("fastback", { rideHeight: 0.125 }));
    const far = runAnalytical(configFor("fastback", { rideHeight: 0.07, spoilerHeight: 0.15, spoilerAngle: 50 }));
    expect(far.uncertainty.cd).toBeGreaterThan(near.uncertainty.cd);
    expect(far.uncertainty.cl).toBeGreaterThan(near.uncertainty.cl);
  });

  test("forces follow F = q C A and the build-up sums to the coefficient", () => {
    const aero = runAnalytical(configFor("sedan", {}, { speed: 40 }));
    const { coefficients: c, forces: f } = aero;
    const q = 0.5 * aero.air.density * 40 * 40;
    expect(f.dynamicPressure).toBeCloseTo(q, 9);
    expect(f.drag).toBeCloseTo(q * c.cd * c.frontalArea, 9);
    expect(f.lift).toBeCloseTo(q * c.cl * c.frontalArea, 9);
    expect(f.downforce).toBeCloseTo(-f.lift, 12);
    expect(c.clFront + c.clRear).toBeCloseTo(c.cl, 12);
    expect(aero.breakdown.drag.reduce((sum, item) => sum + item.value, 0)).toBeCloseTo(c.cd, 12);
    expect(aero.breakdown.lift.reduce((sum, item) => sum + item.value, 0)).toBeCloseTo(c.cl, 12);
  });

  test("drag force grows with the square of speed (coefficient nearly constant)", () => {
    const slow = runAnalytical(configFor("sedan", {}, { speed: 30 }));
    const fast = runAnalytical(configFor("sedan", {}, { speed: 60 }));
    // Skin friction falls slightly with Reynolds number, so the ratio sits just under 4.
    expect(fast.forces.drag / slow.forces.drag).toBeGreaterThan(3.9);
    expect(fast.forces.drag / slow.forces.drag).toBeLessThan(4.0);
    expect(fast.coefficients.cd).toBeLessThan(slow.coefficients.cd);
  });

  test("lowering the car reduces drag and lift monotonically", () => {
    const runs = [0.17, 0.14, 0.11, 0.08].map((rideHeight) => runAnalytical(configFor("fastback", { rideHeight })));
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i].coefficients.cd).toBeLessThan(runs[i - 1].coefficients.cd);
      expect(runs[i].coefficients.cl).toBeLessThan(runs[i - 1].coefficients.cl);
    }
  });

  test("downforce devices cost drag", () => {
    const clean = runAnalytical(configFor("fastback", { spoilerHeight: 0, wingChord: 0 }));
    const spoiler = runAnalytical(configFor("fastback", { spoilerHeight: 0.1, spoilerAngle: 40, wingChord: 0 }));
    const wing = runAnalytical(configFor("fastback", { spoilerHeight: 0, wingChord: 0.3, wingAngle: 10 }));
    for (const modified of [spoiler, wing]) {
      expect(modified.coefficients.cl).toBeLessThan(clean.coefficients.cl);
      expect(modified.coefficients.cd).toBeGreaterThan(clean.coefficients.cd);
    }
    // The wing stalls: beyond the onset angle downforce stops growing while drag keeps rising.
    const steep = runAnalytical(configFor("fastback", { spoilerHeight: 0, wingChord: 0.3, wingAngle: 24 }));
    const moderate = runAnalytical(configFor("fastback", { spoilerHeight: 0, wingChord: 0.3, wingAngle: 16 }));
    expect(steep.coefficients.cd - moderate.coefficients.cd).toBeGreaterThan(0.02);
    expect(Math.abs(steep.coefficients.cl - moderate.coefficients.cl)).toBeLessThan(0.03);
    expect(codesOf(steep.warnings)).toContain("WING_STALL");
  });

  test("drag peaks near the critical rear slope", () => {
    const cd = (rearWindowAngle: number) =>
      runAnalytical(configFor("hatchback", { rearWindowAngle, rearBumperHeight: 0.7 })).coefficients.cd;
    expect(cd(28)).toBeGreaterThan(cd(16));
    const critical = runAnalytical(configFor("hatchback", { rearWindowAngle: 30, rearBumperHeight: 0.7 }));
    expect(codesOf(critical.warnings)).toContain("CRITICAL_REAR_SLOPE");
  });

  test("a smoother floor and covered wheels reduce drag", () => {
    const rough = runAnalytical(configFor("sedan", { floorFlatness: 0, wheelExposure: 1 }));
    const smooth = runAnalytical(configFor("sedan", { floorFlatness: 1, wheelExposure: 0 }));
    expect(smooth.coefficients.cd).toBeLessThan(rough.coefficients.cd - 0.04);
  });

  test("crosswind produces side force, yaw moment and extra drag, antisymmetric in wind direction", () => {
    const still = runAnalytical(configFor("suv"));
    const fromLeft = runAnalytical(configFor("suv", {}, { environment: { windSpeed: 12, windAngle: 80 } }));
    const fromRight = runAnalytical(configFor("suv", {}, { environment: { windSpeed: 12, windAngle: -80 } }));
    expect(still.coefficients.cs).toBe(0);
    expect(still.forces.yawMoment).toBe(0);
    expect(fromLeft.wind.yawAngleDeg).toBeGreaterThan(5);
    expect(fromLeft.coefficients.cs).toBeGreaterThan(0.1);
    expect(fromLeft.coefficients.cd).toBeGreaterThan(still.coefficients.cd);
    expect(fromRight.coefficients.cs).toBeCloseTo(-fromLeft.coefficients.cs, 12);
    expect(fromRight.coefficients.cd).toBeCloseTo(fromLeft.coefficients.cd, 12);
    expect(fromRight.forces.yawMoment).toBeCloseTo(-fromLeft.forces.yawMoment, 9);
  });

  test("air density from temperature, pressure and humidity scales the forces, not the coefficients", () => {
    const cold = runAnalytical(configFor("sedan", {}, { environment: { temperature: 263.15 } }));
    const hot = runAnalytical(configFor("sedan", {}, { environment: { temperature: 313.15, humidity: 0.9 } }));
    expect(cold.air.density).toBeGreaterThan(hot.air.density * 1.15);
    expect(cold.forces.drag / hot.forces.drag).toBeCloseTo(cold.air.density / hot.air.density, 1);
    const direct = runAnalytical(configFor("sedan", {}, { environment: { airDensityMode: "direct", airDensity: 1.0 } }));
    expect(direct.air.density).toBe(1.0);
  });
});

describe("sanity warnings and error handling", () => {
  test("suspicious configurations are flagged", () => {
    const low = runAnalytical(configFor("sports-coupe", { rideHeight: 0.06, minGroundClearance: 0.08 }));
    expect(codesOf(low.warnings)).toContain("CLEARANCE_BELOW_LIMIT");
    const small = runAnalytical(configFor("hatchback", { width: 1.5, roofHeight: 0.95, hoodHeight: 0.55, rearBumperHeight: 0.55, beltHeight: 0.55, frontBumperHeight: 0.4, rideHeight: 0.06 }));
    expect(codesOf(small.warnings)).toContain("FRONTAL_AREA_SMALL");
    const stalled = runAnalytical(configFor("fastback", { diffuserAngle: 18 }));
    expect(codesOf(stalled.warnings)).toContain("DIFFUSER_STALL");
    const gale = runAnalytical(configFor("sedan", {}, { speed: 20, environment: { windSpeed: 30, windAngle: 90 } }));
    expect(codesOf(gale.warnings)).toContain("YAW_LARGE");
    expect(codesOf(runAnalytical(configFor("sedan", {}, { speed: 110 })).warnings)).toContain("COMPRESSIBILITY");
  });

  test("an invalid geometry raises an error instead of returning numbers", () => {
    const run = () => runAnalytical(configFor("sedan", { hoodLength: 1.9, rearDeckLength: 1.2, windshieldAngle: 18 }));
    expect(run).toThrow(SimulationError);
    try {
      run();
    } catch (error) {
      expect((error as SimulationError).code).toBe("INVALID_GEOMETRY");
      expect((error as SimulationError).message).toMatch(/roof/i);
    }
  });

  test("invalid conditions are rejected", () => {
    expect(() => runAnalytical(configFor("sedan", {}, { speed: -5 }))).toThrow(/speed/i);
    expect(() =>
      runAnalytical(configFor("sedan", {}, { environment: { airDensityMode: "direct", airDensity: -1 } })),
    ).toThrow(/density/i);
  });

  test("modes that need the backend refuse to run locally", () => {
    for (const mode of ["cfd", "ml-surrogate"] as const) {
      try {
        runLocal(configFor("sedan", {}, { mode }), false);
        expect.unreachable();
      } catch (error) {
        expect((error as SimulationError).code).toBe("BACKEND_REQUIRED");
        expect((error as SimulationError).message).toMatch(/Nothing was computed/);
      }
    }
  });
});

describe("deterministic hashing and caching", () => {
  test("the hash depends on content, not on key order or float noise", () => {
    expect(canonicalJson({ b: 1, a: [1, 2] })).toBe(canonicalJson({ a: [1, 2], b: 1 }));
    expect(canonicalJson({ a: 0.1 + 0.2 })).toBe(canonicalJson({ a: 0.3 }));
    expect(hashString("abc")).toBe(hashString("abc"));
    expect(hashString("abc")).not.toBe(hashString("abd"));
    const config = configFor("sedan");
    const reordered = { ...config, geometry: Object.fromEntries(Object.entries(config.geometry).reverse()) } as typeof config;
    expect(hashConfig(reordered)).toBe(hashConfig(config));
    expect(hashConfig(configFor("sedan", { rideHeight: 0.141 }))).not.toBe(hashConfig(config));
    expect(hashConfig(configFor("sedan", {}, { speed: 100 * KMH }))).not.toBe(hashConfig(config));
    expect(hashConfig(configFor("sedan", {}, { mode: "reduced-order" }))).not.toBe(hashConfig(config));
  });

  test("an identical simulation is returned from the cache", () => {
    clearLocalCache();
    const config = configFor("hatchback", { spoilerHeight: 0.05 });
    const first = runLocal(config, false);
    const second = runLocal(config, false);
    expect(first.result.cached).toBe(false);
    expect(second.result.cached).toBe(true);
    expect(second.result.hash).toBe(first.result.hash);
    expect(second.result.aero).toBe(first.result.aero);
    // The road gradient has no aerodynamic effect and does not invalidate the cached aerodynamics.
    expect(runLocal({ ...config, environment: { ...config.environment, gradient: 6 } }, false).result.cached).toBe(true);
    expect(runLocal(configFor("hatchback", { spoilerHeight: 0.06 }), false).result.cached).toBe(false);
  });
});

describe("the 60-second experiment", () => {
  test("fastback at 150 km/h: ride height 100 mm versus 70 mm", () => {
    const baseline = evaluate("fastback", { rideHeight: 0.1 });
    const modified = evaluate("fastback", { rideHeight: 0.07 });
    expect(modified.aero.coefficients.cd).toBeLessThan(baseline.aero.coefficients.cd);
    expect(modified.aero.forces.drag).toBeLessThan(baseline.aero.forces.drag);
    expect(modified.aero.forces.downforce).toBeGreaterThan(baseline.aero.forces.downforce);
    expect(modified.performance.topSpeed).toBeGreaterThan(baseline.performance.topSpeed);
    // Sizes of the effects stay within what such a change plausibly does.
    expect(baseline.aero.coefficients.cd - modified.aero.coefficients.cd).toBeLessThan(0.03);
    expect((modified.performance.topSpeed - baseline.performance.topSpeed) / KMH).toBeLessThan(12);
  });
});
