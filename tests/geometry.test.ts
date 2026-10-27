import { describe, expect, test } from "vitest";
import { buildBodyMesh } from "@/lib/geometry/mesh";
import { computeMetrics } from "@/lib/geometry/metrics";
import {
  clampGeometry,
  diffGeometry,
  overallLength,
  PARAM_DEFINITIONS,
  withOverallHeight,
  withOverallLength,
} from "@/lib/geometry/parameters";
import { buildBodyShape, halfWidth, lowerZ, spoilerGeometry, upperZ, wingGeometry } from "@/lib/geometry/profile";
import { isGeometryValid, validateGeometry } from "@/lib/geometry/validate";
import type { GeometryParams } from "@/lib/types";
import { BUILT_IN_VEHICLES, getBuiltInVehicle } from "@/lib/vehicle/library";

const base = getBuiltInVehicle("fastback").geometry;
const variant = (changes: Partial<GeometryParams>): GeometryParams => ({ ...base, ...changes });
const metricsOf = (geometry: GeometryParams) => computeMetrics(buildBodyShape(geometry));

describe("parameter definitions", () => {
  test("every parameter has a range, a step and an aerodynamic explanation", () => {
    expect(PARAM_DEFINITIONS.length).toBe(34);
    for (const definition of PARAM_DEFINITIONS) {
      expect(definition.max).toBeGreaterThan(definition.min);
      expect(definition.step).toBeGreaterThan(0);
      expect(definition.tooltip.length).toBeGreaterThan(40);
    }
  });

  test("built-in vehicles are valid and inside every range", () => {
    expect(BUILT_IN_VEHICLES.map((vehicle) => vehicle.id)).toEqual([
      "hatchback",
      "sedan",
      "sports-coupe",
      "suv",
      "fastback",
      "generic-ev",
    ]);
    for (const vehicle of BUILT_IN_VEHICLES) {
      expect(validateGeometry(vehicle.geometry)).toEqual([]);
      expect(clampGeometry(vehicle.geometry)).toEqual(vehicle.geometry);
    }
  });
});

describe("parametric geometry responds to its parameters", () => {
  test("roof height changes the roof", () => {
    const low = buildBodyShape(variant({ roofHeight: 1.2 }));
    const high = buildBodyShape(variant({ roofHeight: 1.4 }));
    const mid = 0.5 * (low.xRoofStart + low.xRoofEnd);
    expect(upperZ(high, mid) - upperZ(low, mid)).toBeCloseTo(0.2, 2);
    // The hood is unaffected.
    expect(upperZ(high, 0.6)).toBeCloseTo(upperZ(low, 0.6), 6);
    expect(metricsOf(variant({ roofHeight: 1.4 })).frontalArea).toBeGreaterThan(metricsOf(variant({ roofHeight: 1.2 })).frontalArea);
  });

  test("rear window angle changes the rear body shape", () => {
    const shallow = buildBodyShape(variant({ rearWindowAngle: 15 }));
    const steep = buildBodyShape(variant({ rearWindowAngle: 45 }));
    // A steeper window starts later: the roof runs further back.
    expect(steep.xRoofEnd).toBeGreaterThan(shallow.xRoofEnd + 0.3);
    const x = shallow.xRoofEnd + 0.4;
    expect(upperZ(steep, x)).toBeGreaterThan(upperZ(shallow, x) + 0.05);
    expect(computeMetrics(steep).effectiveSlantDeg).toBeGreaterThan(computeMetrics(shallow).effectiveSlantDeg);
  });

  test("ride height moves the whole body relative to the ground", () => {
    const low = buildBodyMesh(buildBodyShape(variant({ rideHeight: 0.08 })));
    const high = buildBodyMesh(buildBodyShape(variant({ rideHeight: 0.2 })));
    expect(low.positions.length).toBe(high.positions.length);
    for (let i = 0; i < low.positions.length; i += 3) {
      expect(high.positions[i]).toBeCloseTo(low.positions[i], 6);
      expect(high.positions[i + 1]).toBeCloseTo(low.positions[i + 1], 6);
      expect(high.positions[i + 2] - low.positions[i + 2]).toBeCloseTo(0.12, 5);
    }
    expect(metricsOf(variant({ rideHeight: 0.2 })).groundClearance).toBeCloseTo(0.2, 9);
    // Wheels stay on the ground, so more tyre shows below a higher body.
    expect(metricsOf(variant({ rideHeight: 0.2 })).frontalArea).toBeGreaterThan(metricsOf(variant({ rideHeight: 0.08 })).frontalArea);
  });

  test("spoiler angle rotates the blade about the tail edge", () => {
    const flat = spoilerGeometry(buildBodyShape(variant({ spoilerHeight: 0.1, spoilerAngle: 0 })));
    const raised = spoilerGeometry(buildBodyShape(variant({ spoilerHeight: 0.1, spoilerAngle: 60 })));
    expect(flat.rise).toBeCloseTo(0, 9);
    expect(raised.rise).toBeCloseTo(0.1 * Math.sin(Math.PI / 3), 9);
    expect(raised.x1 - raised.x0).toBeCloseTo(0.1 * Math.cos(Math.PI / 3), 9);
    expect(raised.x0).toBeCloseTo(flat.x0, 9);
    expect(spoilerGeometry(buildBodyShape(variant({ spoilerHeight: 0 }))).present).toBe(false);
  });

  test("diffuser angle raises the rear floor", () => {
    const shape = buildBodyShape(variant({ diffuserAngle: 10, diffuserLength: 0.8 }));
    expect(lowerZ(shape, shape.length)).toBeCloseTo(0.8 * Math.tan((10 * Math.PI) / 180), 6);
    expect(lowerZ(shape, shape.length - 1)).toBe(0);
    expect(lowerZ(buildBodyShape(variant({ diffuserAngle: 0 })), shape.length)).toBe(0);
  });

  test("wing, width and taper are reflected in the geometry", () => {
    expect(wingGeometry(buildBodyShape(variant({ wingChord: 0 }))).present).toBe(false);
    const wing = wingGeometry(buildBodyShape(variant({ wingChord: 0.3, wingAngle: 12 })));
    expect(wing.present).toBe(true);
    expect(wing.angleDeg).toBe(12);
    const narrow = buildBodyShape(variant({ width: 1.7 }));
    const wide = buildBodyShape(variant({ width: 2.0 }));
    expect(halfWidth(wide, 2.4, 0.4) - halfWidth(narrow, 2.4, 0.4)).toBeCloseTo(0.15, 6);
    const tapered = buildBodyShape(variant({ rearTaper: 0.3 }));
    const square = buildBodyShape(variant({ rearTaper: 0 }));
    expect(halfWidth(tapered, tapered.length - 0.01, 0.4)).toBeLessThan(halfWidth(square, square.length - 0.01, 0.4) - 0.2);
  });

  test("frontal area matches a hand estimate and the body is symmetric", () => {
    const metrics = metricsOf(base);
    // Width x height x a fill factor typical of a car silhouette.
    const box = base.width * metrics.overallHeight;
    expect(metrics.frontalArea / box).toBeGreaterThan(0.78);
    expect(metrics.frontalArea / box).toBeLessThan(0.95);
    const mesh = buildBodyMesh(buildBodyShape(base));
    let sumY = 0;
    for (let i = 1; i < mesh.positions.length; i += 3) sumY += mesh.positions[i];
    expect(Math.abs(sumY)).toBeLessThan(1e-3);
    expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
  });
});

describe("linked dimensions", () => {
  test("overall length is the sum of wheelbase and overhangs", () => {
    expect(overallLength(base)).toBeCloseTo(base.frontOverhang + base.wheelbase + base.rearOverhang, 12);
    const longer = withOverallLength(base, 5.0);
    expect(overallLength(longer)).toBeCloseTo(5.0, 9);
    expect(longer.frontOverhang).toBe(base.frontOverhang);
    expect(longer.rearOverhang).toBe(base.rearOverhang);
  });

  test("overall height changes the roof and keeps the ride height", () => {
    const taller = withOverallHeight(base, 1.5);
    expect(taller.rideHeight).toBe(base.rideHeight);
    expect(taller.rideHeight + taller.roofHeight).toBeCloseTo(1.5, 9);
  });

  test("diffGeometry lists exactly the changed parameters", () => {
    expect(diffGeometry(base, base)).toEqual([]);
    const changes = diffGeometry(base, variant({ rideHeight: 0.1, spoilerAngle: 23 }));
    expect(changes.map((change) => change.id).sort()).toEqual(["rideHeight", "spoilerAngle"]);
  });
});

describe("geometry validation", () => {
  const codes = (geometry: GeometryParams) => validateGeometry(geometry).map((issue) => issue.code);

  test("impossible combinations are reported with a reason", () => {
    expect(codes(variant({ hoodLength: 1.9, rearDeckLength: 1.2, windshieldAngle: 18 }))).toContain("ROOF_TOO_SHORT");
    expect(codes(variant({ roofHeight: 0.95, hoodHeight: 1.1 }))).toContain("ROOF_BELOW_COWL");
    expect(codes(variant({ roofHeight: 1.0, hoodHeight: 0.6, rearBumperHeight: 1.2 }))).toContain("TAIL_ABOVE_ROOF");
    expect(codes(variant({ rideHeight: 0.31, wheelDiameter: 0.55 }))).toContain("WHEEL_TOO_SMALL");
    expect(codes(variant({ rideHeight: 0.05, sideSkirtDepth: 0.05 }))).toContain("SKIRT_TOUCHES_GROUND");
  });

  test("out-of-range and non-finite values are rejected", () => {
    expect(codes(variant({ rideHeight: 2 }))).toEqual(["PARAM_OUT_OF_RANGE"]);
    expect(codes(variant({ width: Number.NaN }))).toEqual(["PARAM_NOT_FINITE"]);
    expect(isGeometryValid(variant({ rideHeight: 2 }))).toBe(false);
    expect(isGeometryValid(base)).toBe(true);
  });
});
