import { describe, expect, test } from "vitest";
import { GRAVITY } from "@/lib/physics/model";
import { makePerformanceInput, vehicleSpecOf } from "@/lib/simulation/config";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import type { IcePowertrain, VehicleSpec } from "@/lib/types";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import {
  cdAtSpeed,
  computePerformance,
  type PerformanceInput,
  resistances,
  simulateAcceleration,
  solveTopSpeed,
  tractionLimit,
} from "@/lib/vehicle/performance";
import { iceTorque, inertiaFactor, powertrainCurve, revLimitedSpeed, wheelForce } from "@/lib/vehicle/powertrain";
import { configFor, evaluate, KMH } from "./helpers";

function inputFor(vehicleId: string, overrides: { spec?: Partial<VehicleSpec>; gradient?: number; windSpeed?: number } = {}): PerformanceInput {
  const vehicle = getBuiltInVehicle(vehicleId);
  const config = configFor(vehicleId, {}, { environment: { gradient: overrides.gradient ?? 0, windSpeed: overrides.windSpeed ?? 0 } });
  const aero = runAnalytical(config);
  return makePerformanceInput(
    { ...vehicleSpecOf(vehicle), ...overrides.spec },
    vehicle.powertrain,
    config.geometry,
    aero.coefficients,
    aero.air.density,
    config.environment,
    config.speed,
  );
}

describe("resistances", () => {
  test("F_total = F_drag + F_rolling + F_grade", () => {
    const input = inputFor("sedan", { gradient: 4 });
    for (const speed of [0, 15, 40, 70]) {
      const res = resistances(input, speed);
      expect(res.total).toBeCloseTo(res.drag + res.rolling + res.grade, 9);
      expect(res.grade).toBeCloseTo(input.vehicle.mass * GRAVITY * Math.sin((4 * Math.PI) / 180), 9);
    }
  });

  test("aerodynamic drag is proportional to V^2 once the friction correction is removed", () => {
    const input = inputFor("sedan");
    const frozen = { ...input, aero: { ...input.aero, cdFriction: 0 } };
    expect(resistances(frozen, 60).drag / resistances(frozen, 30).drag).toBeCloseTo(4, 9);
    expect((resistances(frozen, 60).drag * 60) / (resistances(frozen, 30).drag * 30)).toBeCloseTo(8, 9);
    // With it, Cd falls slowly with speed.
    expect(cdAtSpeed(input.aero, 70)).toBeLessThan(cdAtSpeed(input.aero, 20));
    expect(cdAtSpeed(input.aero, input.aero.referenceSpeed)).toBeCloseTo(input.aero.cd, 12);
  });

  test("rolling resistance equals Crr m g at rest on a level road, and rises with downforce", () => {
    const input = inputFor("sedan");
    expect(resistances(input, 0).rolling).toBeCloseTo(input.vehicle.crr * input.vehicle.mass * GRAVITY, 9);
    const downforce = { ...input, aero: { ...input.aero, clFront: -0.2, clRear: -0.3, cl: -0.5 } };
    expect(resistances(downforce, 60).rolling).toBeGreaterThan(resistances(downforce, 0).rolling);
  });

  test("a headwind raises drag and a tailwind lowers it", () => {
    const still = resistances(inputFor("sedan"), 30).drag;
    expect(resistances(inputFor("sedan", { windSpeed: 10 }), 30).drag).toBeGreaterThan(still * 1.6);
    const tailwind = { ...inputFor("sedan"), headwind: -10 };
    expect(resistances(tailwind, 30).drag).toBeLessThan(still * 0.5);
    // Slower than the tailwind: the air pushes the car forward.
    expect(resistances(tailwind, 5).drag).toBeLessThan(0);
  });
});

describe("powertrain", () => {
  const ice = getBuiltInVehicle("hatchback").powertrain as IcePowertrain;

  test("the simplified torque curve honours the stated peaks", () => {
    expect(iceTorque(ice, ice.peakTorqueRpm)).toBeCloseTo(ice.peakTorqueNm, 6);
    const curve = powertrainCurve(ice, 200);
    const peakPower = Math.max(...curve.map((point) => point.powerW));
    expect(peakPower).toBeLessThanOrEqual(ice.peakPowerW * 1.0001);
    expect(peakPower).toBeGreaterThan(ice.peakPowerW * 0.99);
    expect(iceTorque(ice, ice.redlineRpm + 1)).toBe(0);
  });

  test("a user-defined power curve replaces the simplified one", () => {
    const custom: IcePowertrain = {
      ...ice,
      powerCurve: [
        { rpm: 1000, powerW: 10000 },
        { rpm: 3000, powerW: 60000 },
        { rpm: 6000, powerW: 90000 },
      ],
    };
    const omega = (rpm: number) => (rpm * 2 * Math.PI) / 60;
    expect(iceTorque(custom, 3000) * omega(3000)).toBeCloseTo(60000, 6);
    expect(iceTorque(custom, 4500) * omega(4500)).toBeCloseTo(75000, 6);
  });

  test("wheel force falls with speed and stops at the rev limit", () => {
    const radius = 0.315;
    expect(wheelForce(ice, 5, radius).force).toBeGreaterThan(wheelForce(ice, 40, radius).force);
    const limit = revLimitedSpeed(ice, radius);
    expect(wheelForce(ice, limit * 0.99, radius).force).toBeGreaterThan(0);
    expect(wheelForce(ice, limit * 1.01, radius).force).toBe(0);
    expect(inertiaFactor(ice, 1)).toBeGreaterThan(inertiaFactor(ice, 6));
  });

  test("an electric motor gives constant torque, then constant power", () => {
    const ev = getBuiltInVehicle("generic-ev").powertrain;
    const radius = 0.345;
    expect(wheelForce(ev, 2, radius).force).toBeCloseTo(wheelForce(ev, 10, radius).force, 6);
    const p40 = wheelForce(ev, 40, radius).force * 40;
    const p55 = wheelForce(ev, 55, radius).force * 55;
    expect(p40).toBeCloseTo(p55, 3);
  });
});

describe("traction limit", () => {
  test("load transfer helps rear-wheel drive and hurts front-wheel drive", () => {
    const base = inputFor("sedan", { spec: { weightDistFront: 0.5 } });
    const res = resistances(base, 5);
    const limitOf = (drivetrain: VehicleSpec["drivetrain"]) =>
      tractionLimit({ ...base, vehicle: { ...base.vehicle, drivetrain } }, res, 1.2);
    const staticAxle = base.vehicle.tireMu * 0.5 * base.vehicle.mass * GRAVITY;
    expect(limitOf("RWD")).toBeGreaterThan(staticAxle);
    expect(limitOf("FWD")).toBeLessThan(staticAxle);
    expect(limitOf("AWD")).toBeGreaterThan(limitOf("RWD"));
  });

  test("downforce raises the traction limit at speed", () => {
    const base = inputFor("sports-coupe");
    const lifting = { ...base, aero: { ...base.aero, clFront: 0.1, clRear: 0.15, cl: 0.25 } };
    const planted = { ...base, aero: { ...base.aero, clFront: -0.2, clRear: -0.4, cl: -0.6 } };
    expect(tractionLimit(planted, resistances(planted, 60), 1.1)).toBeGreaterThan(
      tractionLimit(lifting, resistances(lifting, 60), 1.1),
    );
  });

  test("a powerful rear-drive car is reported as traction-limited off the line", () => {
    expect(evaluate("sports-coupe").performance.tractionLimited).toBe(true);
    const grippy = computePerformance(inputFor("hatchback", { spec: { tireMu: 1.6, drivetrain: "AWD" } }));
    expect(grippy.tractionLimited).toBe(false);
  });
});

describe("top speed", () => {
  test("is where available wheel force equals total resistance", () => {
    const input = inputFor("sedan");
    const { topSpeed, limit } = solveTopSpeed(input);
    expect(limit).toBe("power");
    const res = resistances(input, topSpeed);
    const drive = wheelForce(input.powertrain, topSpeed, input.wheelRadius).force;
    expect(drive).toBeCloseTo(res.total, 0);
    expect(res.total * topSpeed).toBeLessThanOrEqual(input.powertrain.peakPowerW * 1.0001);
  });

  test("responds to drag, gradient and gearing", () => {
    const flat = solveTopSpeed(inputFor("hatchback")).topSpeed;
    expect(solveTopSpeed(inputFor("hatchback", { gradient: 6 })).topSpeed).toBeLessThan(flat);
    expect(solveTopSpeed(inputFor("hatchback", { gradient: -4 })).topSpeed).toBeGreaterThan(flat);
    const draggy = { ...inputFor("hatchback") };
    draggy.aero = { ...draggy.aero, cd: draggy.aero.cd + 0.1 };
    expect(solveTopSpeed(draggy).topSpeed).toBeLessThan(flat - 5);
    const ev = solveTopSpeed(inputFor("generic-ev"));
    expect(ev.limit).toBe("motor-rpm");
    expect(ev.topSpeed).toBeCloseTo(revLimitedSpeed(getBuiltInVehicle("generic-ev").powertrain, 0.345), 2);
  });

  test("a grade too steep to climb gives zero top speed rather than a made-up value", () => {
    const hill = { ...inputFor("hatchback"), gradientDeg: 44, vehicle: { ...inputFor("hatchback").vehicle, tireMu: 0.5 } };
    expect(solveTopSpeed(hill).topSpeed).toBe(0);
    const run = simulateAcceleration(hill);
    expect(run.times.every((entry) => entry.time === null)).toBe(true);
  });
});

describe("acceleration", () => {
  test("speed rises monotonically between gear changes and targets are reached in order", () => {
    const { performance } = evaluate("fastback");
    const times = performance.accelTimes.map((entry) => entry.time);
    expect(times.every((time) => time !== null)).toBe(true);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    const zeroToHundred = performance.accelTimes.find((entry) => entry.target === 100)!.time!;
    expect(zeroToHundred).toBeGreaterThan(4);
    expect(zeroToHundred).toBeLessThan(11);
    const trace = performance.accelTrace;
    expect(trace[0].speed).toBe(0);
    expect(trace[trace.length - 1].speed).toBeGreaterThan(200 * KMH);
    expect(trace.every((sample, i) => i === 0 || sample.time > trace[i - 1].time)).toBe(true);
    expect(trace.every((sample, i) => i === 0 || sample.distance >= trace[i - 1].distance)).toBe(true);
    expect(Math.max(...trace.map((sample) => sample.gear))).toBeGreaterThan(3);
  });

  test("more mass means slower acceleration; unreachable targets are reported as such", () => {
    const light = computePerformance(inputFor("hatchback", { spec: { mass: 1000 } }));
    const heavy = computePerformance(inputFor("hatchback", { spec: { mass: 1900 } }));
    const t100 = (performance: typeof light) => performance.accelTimes.find((entry) => entry.target === 100)!.time!;
    expect(t100(heavy)).toBeGreaterThan(t100(light) * 1.4);
    const uphill = computePerformance(inputFor("hatchback", { gradient: 12 }));
    expect(uphill.accelTimes.find((entry) => entry.target === 200)!.time).toBeNull();
  });

  test("the speed sweep and summary figures are consistent", () => {
    const { performance, aero } = evaluate("sedan");
    const sweep = performance.speedSweep;
    expect(sweep[0].speed).toBe(0);
    for (const sample of sweep) {
      expect(sample.powerRequired).toBeCloseTo(sample.powerAero + sample.powerRolling + sample.powerGrade, 6);
    }
    expect(performance.forcesAtSpeed.drag).toBeCloseTo(aero.forces.drag, 6);
    expect(performance.forcesAtSpeed.total).toBeCloseTo(
      performance.forcesAtSpeed.drag + performance.forcesAtSpeed.rolling + performance.forcesAtSpeed.grade,
      9,
    );
    expect(performance.maxGradeDeg).toBeGreaterThan(15);
    expect(performance.rangeAt100).toBeNull();
    expect(evaluate("generic-ev").performance.rangeAt100).toBeGreaterThan(200000);
  });
});
