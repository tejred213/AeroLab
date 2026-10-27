/**
 * The details that carry drag and are part of the calculation: door mirrors,
 * rim openness and the cooling intake. Each must move the result in the
 * direction and by roughly the amount the literature gives, in both modes.
 */
import { describe, expect, it } from "vitest";
import { completeGeometry, PARAM_BY_ID } from "@/lib/geometry/parameters";
import { computeMetrics } from "@/lib/geometry/metrics";
import { buildBodyShape, mirrorGeometry, planHalfWidth } from "@/lib/geometry/profile";
import { buildSolidModel, insideBody } from "@/lib/geometry/solids";
import { MODEL } from "@/lib/physics/model";
import { computeRearFlow } from "@/lib/physics/rearFlow";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { runReducedOrder } from "@/lib/simulation/reducedOrderEngine";
import type { AeroResult, GeometryParams } from "@/lib/types";
import { BUILT_IN_VEHICLES, getBuiltInVehicle, LIBRARY_VEHICLES } from "@/lib/vehicle/library";
import { configFor } from "./helpers";

const CLASSES = BUILT_IN_VEHICLES.map((vehicle) => vehicle.id);

function solve(vehicle: string, changes: Partial<GeometryParams>, mode: "analytical" | "reduced-order"): AeroResult {
  const config = configFor(vehicle, changes, { mode });
  return mode === "analytical" ? runAnalytical(config) : runReducedOrder(config).aero;
}

const item = (aero: AeroResult, id: string) => aero.breakdown.drag.find((entry) => entry.id === id)?.value ?? Number.NaN;
const dragArea = (aero: AeroResult) => aero.coefficients.cd * aero.metrics.frontalArea;

describe("detail parameters", () => {
  it("are defined with defaults, and every library vehicle has them", () => {
    for (const id of ["mirrorWidth", "rimOpenness", "grilleOpening"] as const) {
      expect(PARAM_BY_ID[id].group).toBe("details");
      expect(PARAM_BY_ID[id].default).toBeGreaterThanOrEqual(PARAM_BY_ID[id].min);
      for (const vehicle of LIBRARY_VEHICLES) {
        expect(vehicle.geometry[id], `${vehicle.id} ${id}`).toBeGreaterThanOrEqual(PARAM_BY_ID[id].min);
        expect(vehicle.geometry[id], `${vehicle.id} ${id}`).toBeLessThanOrEqual(PARAM_BY_ID[id].max);
      }
    }
  });

  it("are filled in for a geometry stored before they existed", () => {
    const { mirrorWidth: _m, rimOpenness: _r, grilleOpening: _g, ...old } = getBuiltInVehicle("sedan").geometry;
    const stored = old as GeometryParams;
    const complete = completeGeometry(stored);
    expect(complete.mirrorWidth).toBe(PARAM_BY_ID.mirrorWidth.default);
    expect(complete.rimOpenness).toBe(PARAM_BY_ID.rimOpenness.default);
    expect(complete.grilleOpening).toBe(PARAM_BY_ID.grilleOpening.default);
    // A complete geometry is returned as it is.
    expect(completeGeometry(complete)).toBe(complete);
    // The engines accept the old geometry and give a finite, plausible answer.
    const config = { ...configFor("sedan"), geometry: stored };
    const cd = runAnalytical(config).coefficients.cd;
    expect(cd).toBeGreaterThan(0.2);
    expect(cd).toBeLessThan(0.4);
  });

  it.each(CLASSES)("leave the %s class at its reference coefficients", (vehicle) => {
    const reference = getBuiltInVehicle(vehicle).reference;
    const speed = MODEL.calibration.speed;
    const config = { ...configFor(vehicle), speed };
    expect(runAnalytical(config).coefficients.cd).toBeCloseTo(reference.cd, 6);
    expect(runAnalytical(config).coefficients.cl).toBeCloseTo(reference.cl, 6);
  });
});

describe("door mirrors", () => {
  it("sit at the base of the A-pillar, above the belt and outside the body side", () => {
    for (const vehicle of LIBRARY_VEHICLES) {
      const shape = buildBodyShape(vehicle.geometry);
      const mirror = mirrorGeometry(shape);
      expect(mirror.present, vehicle.id).toBe(true);
      expect(mirror.x0).toBeGreaterThan(shape.xCowl);
      expect(mirror.x1).toBeLessThan(shape.xRoofStart + 0.4);
      expect(mirror.z0).toBeGreaterThan(vehicle.geometry.beltHeight);
      expect(mirror.y1 - planHalfWidth(shape, 0.5 * (mirror.x0 + mirror.x1))).toBeCloseTo(vehicle.geometry.mirrorWidth, 6);
      expect(mirror.area).toBeCloseTo(MODEL.profile.mirrorAspect * vehicle.geometry.mirrorWidth ** 2, 9);
    }
    expect(mirrorGeometry(buildBodyShape({ ...getBuiltInVehicle("sedan").geometry, mirrorWidth: 0 })).present).toBe(false);
  });

  it("add their own area to the frontal area", () => {
    for (const vehicle of CLASSES) {
      const geometry = getBuiltInVehicle(vehicle).geometry;
      const withMirrors = computeMetrics(buildBodyShape(geometry)).frontalArea;
      const without = computeMetrics(buildBodyShape({ ...geometry, mirrorWidth: 0 })).frontalArea;
      const expected = 2 * mirrorGeometry(buildBodyShape(geometry)).area;
      // The housing overlaps nothing but a sliver of the leaning side glass.
      expect(withMirrors - without).toBeGreaterThan(0.95 * expected);
      expect(withMirrors - without).toBeLessThan(1.35 * expected);
    }
  });

  it("are solid in the flow solver", () => {
    const geometry = getBuiltInVehicle("sedan").geometry;
    const scratch = new Float64Array(16);
    const model = (params: GeometryParams) => {
      const shape = buildBodyShape(params);
      return { shape, model: buildSolidModel(shape, computeRearFlow(shape, computeMetrics(shape).frontalArea), { x: 0.12, y: 0.1 }) };
    };
    const dressed = model(geometry);
    const bare = model({ ...geometry, mirrorWidth: 0 });
    const mirror = mirrorGeometry(dressed.shape);
    const point: [number, number, number] = [0.5 * (mirror.x0 + mirror.x1), mirror.y1 - 0.03, geometry.rideHeight + 0.5 * (mirror.z0 + mirror.z1)];
    expect(insideBody(dressed.model, ...point, scratch)).toBe(true);
    expect(insideBody(bare.model, ...point, scratch)).toBe(false);
    // Just above and just outboard of the housing the air is free.
    expect(insideBody(dressed.model, point[0], mirror.y1 + 0.03, point[2], scratch)).toBe(false);
    expect(insideBody(dressed.model, point[0], point[1], geometry.rideHeight + mirror.z1 + 0.03, scratch)).toBe(false);
    expect(dressed.model.yMax).toBeGreaterThan(mirror.y1);
  });

  it.each(["analytical", "reduced-order"] as const)("cost a few per cent of the drag in the %s mode", (mode) => {
    for (const vehicle of ["sedan", "suv", "generic-ev"]) {
      const withMirrors = solve(vehicle, {}, mode);
      const without = solve(vehicle, { mirrorWidth: 0 }, mode);
      expect(item(withMirrors, "mirrors")).toBeGreaterThan(0.008);
      expect(item(withMirrors, "mirrors")).toBeLessThan(0.02);
      expect(item(without, "mirrors")).toBe(0);
      // Removing the mirrors lowers the drag force by 2 to 7 %, part of it through the smaller frontal area.
      const saving = 1 - dragArea(without) / dragArea(withMirrors);
      expect(saving, `${vehicle} ${mode}`).toBeGreaterThan(0.02);
      expect(saving, `${vehicle} ${mode}`).toBeLessThan(0.07);
    }
  });

  it("grow with their size", () => {
    const small = solve("sedan", { mirrorWidth: 0.12 }, "analytical");
    const large = solve("sedan", { mirrorWidth: 0.28 }, "analytical");
    expect(dragArea(large)).toBeGreaterThan(dragArea(small));
    expect(item(large, "mirrors") / item(small, "mirrors")).toBeGreaterThan(4);
  });
});

describe("rims and cooling intake", () => {
  it.each(["analytical", "reduced-order"] as const)("open rims add wheelhouse ventilation drag (%s)", (mode) => {
    for (const vehicle of ["sedan", "suv"]) {
      const closed = solve(vehicle, { rimOpenness: 0 }, mode);
      const half = solve(vehicle, { rimOpenness: 0.5 }, mode);
      const open = solve(vehicle, { rimOpenness: 1 }, mode);
      expect(half.coefficients.cd).toBeGreaterThan(closed.coefficients.cd);
      expect(open.coefficients.cd).toBeGreaterThan(half.coefficients.cd);
      // Published savings of closed wheel covers are of this size.
      const spread = open.coefficients.cd - closed.coefficients.cd;
      expect(spread).toBeGreaterThan(0.006);
      expect(spread).toBeLessThan(0.016);
      expect(item(open, "wheels") - item(closed, "wheels")).toBeCloseTo(spread, 6);
      expect(open.coefficients.cl).toBeCloseTo(closed.coefficients.cl, 9);
    }
  });

  it.each(["analytical", "reduced-order"] as const)("cooling drag follows the intake area (%s)", (mode) => {
    const sealed = solve("sedan", { grilleOpening: 0 }, mode);
    const typical = solve("sedan", { grilleOpening: 0.045 }, mode);
    const large = solve("sedan", { grilleOpening: 0.09 }, mode);
    expect(item(sealed, "cooling")).toBe(0);
    expect(item(typical, "cooling")).toBeCloseTo(MODEL.drag.coolingLoss * 0.045, 9);
    // Linear in the area, and about 0.02 for a typical combustion car.
    expect(large.coefficients.cd - typical.coefficients.cd).toBeCloseTo(typical.coefficients.cd - sealed.coefficients.cd, 6);
    expect(typical.coefficients.cd - sealed.coefficients.cd).toBeGreaterThan(0.015);
    expect(typical.coefficients.cd - sealed.coefficients.cd).toBeLessThan(0.03);
  });

  it("gives an electric car's small intake less cooling drag than a combustion car's", () => {
    const electric = runAnalytical(configFor("generic-ev"));
    const combustion = runAnalytical(configFor("sedan"));
    expect(item(electric, "cooling")).toBeLessThan(0.5 * item(combustion, "cooling"));
  });
});
