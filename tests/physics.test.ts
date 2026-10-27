import { describe, expect, test } from "vitest";
import {
  dragForce,
  dynamicPressure,
  gradeForce,
  liftForce,
  normalLoad,
  power,
  rollingResistance,
  rollingResistanceFromLoad,
} from "@/lib/physics/forces";
import { airViscosity, moistAirDensity, saturationVapourPressure } from "@/lib/physics/atmosphere";
import { relativeWind } from "@/lib/physics/wind";
import { GRAVITY } from "@/lib/physics/model";

describe("fundamental force relations", () => {
  const rho = 1.225;
  const area = 2.2;

  test("dynamic pressure q = 1/2 rho V^2", () => {
    expect(dynamicPressure(rho, 40)).toBeCloseTo(0.5 * rho * 1600, 9);
    expect(dynamicPressure(rho, 0)).toBe(0);
  });

  test("drag: Fd = 1/2 rho V^2 Cd A and Fd is proportional to V^2", () => {
    expect(dragForce(rho, 30, 0.3, area)).toBeCloseTo(0.5 * rho * 900 * 0.3 * area, 9);
    for (const v of [10, 25, 60]) {
      expect(dragForce(rho, 2 * v, 0.3, area) / dragForce(rho, v, 0.3, area)).toBeCloseTo(4, 12);
      expect(dragForce(rho, 3 * v, 0.3, area) / dragForce(rho, v, 0.3, area)).toBeCloseTo(9, 12);
    }
  });

  test("lift: Fl is proportional to V^2 and negative Cl gives downforce", () => {
    for (const v of [10, 25, 60]) {
      expect(liftForce(rho, 2 * v, 0.1, area) / liftForce(rho, v, 0.1, area)).toBeCloseTo(4, 12);
    }
    expect(liftForce(rho, 40, -0.2, area)).toBeLessThan(0);
    expect(liftForce(rho, 40, 0.2, area)).toBeGreaterThan(0);
  });

  test("aerodynamic power: Pdrag is proportional to V^3", () => {
    const p = (v: number) => power(dragForce(rho, v, 0.3, area), v);
    for (const v of [10, 25, 60]) {
      expect(p(2 * v) / p(v)).toBeCloseTo(8, 12);
      expect(p(3 * v) / p(v)).toBeCloseTo(27, 12);
    }
  });

  test("gradient: Fgrade = m g sin(theta), sign follows the slope", () => {
    const mass = 1500;
    expect(gradeForce(mass, 0)).toBe(0);
    expect(gradeForce(mass, 10)).toBeCloseTo(mass * GRAVITY * Math.sin((10 * Math.PI) / 180), 9);
    expect(gradeForce(mass, 90)).toBeCloseTo(mass * GRAVITY, 9);
    expect(gradeForce(mass, -5)).toBeCloseTo(-gradeForce(mass, 5), 9);
    expect(gradeForce(mass, 5)).toBeGreaterThan(0);
  });

  test("rolling resistance: Frr = Crr m g", () => {
    expect(rollingResistance(0.01, 1500)).toBeCloseTo(0.01 * 1500 * GRAVITY, 9);
    expect(rollingResistance(0.02, 1500) / rollingResistance(0.01, 1500)).toBeCloseTo(2, 12);
    expect(rollingResistance(0.01, 3000) / rollingResistance(0.01, 1500)).toBeCloseTo(2, 12);
  });

  test("load-based rolling resistance reduces to Crr m g on a level road with no lift", () => {
    const load = normalLoad(1500, 0, 0);
    expect(load).toBeCloseTo(1500 * GRAVITY, 9);
    expect(rollingResistanceFromLoad(0.01, load)).toBeCloseTo(rollingResistance(0.01, 1500), 9);
    // Downforce (negative lift) increases the load; a grade reduces it by cos(theta).
    expect(normalLoad(1500, 0, -500)).toBeCloseTo(1500 * GRAVITY + 500, 9);
    expect(normalLoad(1500, 10, 0)).toBeCloseTo(1500 * GRAVITY * Math.cos((10 * Math.PI) / 180), 9);
  });
});

describe("atmosphere", () => {
  test("dry air at ISA sea level has density 1.225 kg/m^3", () => {
    expect(moistAirDensity(288.15, 101325, 0)).toBeCloseTo(1.225, 3);
  });

  test("density follows the ideal-gas law in temperature and pressure", () => {
    expect(moistAirDensity(300, 101325, 0) / moistAirDensity(150, 101325, 0)).toBeCloseTo(0.5, 9);
    expect(moistAirDensity(288.15, 50000, 0) / moistAirDensity(288.15, 100000, 0)).toBeCloseTo(0.5, 9);
  });

  test("humid air is less dense than dry air", () => {
    expect(moistAirDensity(303.15, 101325, 1)).toBeLessThan(moistAirDensity(303.15, 101325, 0));
  });

  test("saturation vapour pressure and viscosity match reference values", () => {
    expect(saturationVapourPressure(293.15)).toBeGreaterThan(2300);
    expect(saturationVapourPressure(293.15)).toBeLessThan(2380);
    expect(airViscosity(288.15)).toBeCloseTo(1.789e-5, 7);
  });
});

describe("relative wind", () => {
  test("still air: relative speed equals vehicle speed, zero yaw", () => {
    const wind = relativeWind(40, 0, 0);
    expect(wind.relativeSpeed).toBeCloseTo(40, 12);
    expect(wind.yawAngleDeg).toBeCloseTo(0, 12);
  });

  test("a headwind adds to the relative speed", () => {
    expect(relativeWind(40, 10, 0).relativeSpeed).toBeCloseTo(50, 12);
  });

  test("a pure crosswind yaws the onset flow", () => {
    const wind = relativeWind(30, 30, 90);
    expect(wind.yawAngleDeg).toBeCloseTo(45, 9);
    expect(wind.relativeSpeed).toBeCloseTo(Math.hypot(30, 30), 9);
    expect(relativeWind(30, 30, -90).yawAngleDeg).toBeCloseTo(-45, 9);
  });
});
