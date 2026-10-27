/**
 * The dressed car: styling data for every library vehicle, and the positions of
 * glazing, doors, arches, lights and mirrors derived from the body shape.
 * All of it is appearance; the last test checks that it cannot reach a result.
 */
import { describe, expect, it } from "vitest";
import { buildBodyShape, upperZ } from "@/lib/geometry/profile";
import { buildTrimLayout, sectionAttribute } from "@/lib/geometry/trim";
import { buildBodyMesh } from "@/lib/geometry/mesh";
import { STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import { makeConfig } from "@/lib/simulation/config";
import { appearanceFor, bodyTypeOf, hasStyling, rimDiameterOf } from "@/lib/vehicle/appearance";
import { getBuiltInVehicle, LIBRARY_VEHICLES } from "@/lib/vehicle/library";
import type { VehicleDefinition } from "@/lib/types";

describe("car appearance", () => {
  it("reads the rim size from a tyre size", () => {
    expect(rimDiameterOf("235/45 R18")).toBeCloseTo(0.4572, 4);
    expect(rimDiameterOf("255/45 R19 / 285/40 R19")).toBeCloseTo(0.4826, 4);
    expect(rimDiameterOf("unknown")).toBeNull();
  });

  it("has a styling entry for every library vehicle", () => {
    expect(LIBRARY_VEHICLES.filter((vehicle) => !hasStyling(vehicle.id)).map((vehicle) => vehicle.id)).toEqual([]);
  });

  it("uses the real rim size of a production car and keeps a tyre wall on every wheel", () => {
    const car = getBuiltInVehicle("tesla-model-3");
    const look = appearanceFor(car);
    expect(look.rimRatio).toBeCloseTo((0.4572 + 0.02) / car.geometry.wheelDiameter, 6);
    for (const vehicle of LIBRARY_VEHICLES) {
      const ratio = appearanceFor(vehicle).rimRatio;
      expect(ratio, vehicle.id).toBeGreaterThanOrEqual(0.45);
      expect(ratio, vehicle.id).toBeLessThanOrEqual(0.85);
    }
  });

  it("dresses a vehicle without a styling entry from its shape", () => {
    const base = getBuiltInVehicle("suv");
    const custom: VehicleDefinition = { ...base, id: "custom-test", custom: true };
    expect(appearanceFor(custom).bodyType).toBe("suv");
    expect(bodyTypeOf(getBuiltInVehicle("sedan").geometry)).toBe("sedan");
    expect(bodyTypeOf(getBuiltInVehicle("hatchback").geometry)).toBe("hatchback");
    // Reshaped in the editor, it is dressed for the shape it has now.
    expect(appearanceFor(custom, { ...base.geometry, rearWindowAngle: 20, rearDeckLength: 0.6, roofHeight: 1.3 }).bodyType).toBe("sedan");
  });
});

describe.each(LIBRARY_VEHICLES.map((vehicle) => [vehicle.id, vehicle] as const))("trim layout of %s", (_id, vehicle) => {
  const shape = buildBodyShape(vehicle.geometry);
  const look = appearanceFor(vehicle);
  const layout = buildTrimLayout(shape, look);
  const wheelRadius = vehicle.geometry.wheelDiameter / 2;

  it("opens the arches around the wheels and under the wings", () => {
    expect(layout.arch.x).toEqual([shape.frontAxleX, shape.rearAxleX]);
    expect(layout.arch.radius).toBeGreaterThan(wheelRadius);
    expect(layout.arch.radius).toBeLessThan(wheelRadius + 0.09);
    for (const x of layout.arch.x) expect(layout.arch.z + layout.arch.radius).toBeLessThan(upperZ(shape, x));
    expect(layout.arch.innerY).toBeGreaterThan(0.3);
    for (const wheel of layout.wheels) {
      expect(wheel.rimRadius).toBeLessThan(wheel.radius - 0.03);
      expect(wheel.rimRadius).toBeGreaterThan(0.4 * wheel.radius);
    }
  });

  it("keeps the side glass inside the greenhouse", () => {
    const glass = layout.sideGlass;
    expect(glass).not.toBeNull();
    if (!glass) return;
    expect(glass.bottom).toBeGreaterThan(vehicle.geometry.beltHeight);
    expect(glass.top).toBeLessThan(shape.roofEdgeHeight);
    expect(glass.front[0]).toBeGreaterThanOrEqual(shape.xCowl);
    expect(glass.rear[0]).toBeLessThan(shape.length);
    expect(glass.rear[0] - glass.front[0]).toBeGreaterThan(0.5);
    expect(glass.pillars.length).toBe((look.doors === 4 ? 1 : 0) + (look.quarterWindow ? 1 : 0));
    for (const [x, halfWidth] of glass.pillars) {
      expect(x - halfWidth).toBeGreaterThan(glass.front[0]);
      expect(x + halfWidth).toBeLessThan(glass.rear[0]);
    }
  });

  it("puts the door cuts between the wheel arches, in order, with a handle on each door", () => {
    expect(layout.doorLines.length).toBe(look.doors === 4 ? 3 : 2);
    expect([...layout.doorLines].sort((a, b) => a - b)).toEqual(layout.doorLines);
    expect(layout.doorLines[0]).toBeGreaterThan(shape.frontAxleX + layout.arch.radius);
    expect(layout.doorLines[layout.doorLines.length - 1]).toBeLessThan(shape.rearAxleX + 0.05);
    expect(layout.handles.length).toBe(look.doors / 2);
    layout.handles.forEach((x, door) => {
      expect(x).toBeGreaterThan(layout.doorLines[door]);
      expect(x).toBeLessThan(layout.doorLines[door + 1]);
    });
    expect(layout.handleZ).toBeLessThan(vehicle.geometry.beltHeight);
  });

  it("places lights, grille and mirrors on the body", () => {
    expect(layout.head.z).toBeGreaterThan(shape.stagnationHeight);
    expect(layout.head.z).toBeLessThan(vehicle.geometry.hoodHeight);
    expect(layout.tail.z + layout.tail.halfHeight).toBeLessThan(shape.tailHeight);
    expect(layout.tail.z - layout.tail.halfHeight).toBeGreaterThan(0);
    if (layout.head.round) {
      expect(upperZ(shape, layout.head.round.x)).toBeCloseTo(layout.head.round.z, 3);
      expect(layout.head.round.y + layout.head.round.radius).toBeLessThan(layout.halfWidth);
    }
    if (layout.grille) expect(layout.grille.high).toBeGreaterThan(layout.grille.low);
    expect(layout.intake.high).toBeGreaterThan(layout.intake.low);
    expect(layout.mirror).not.toBeNull();
    expect(layout.mirror!.x).toBeGreaterThan(shape.xCowl);
    expect(layout.mirror!.x).toBeLessThan(shape.xRoofStart + 0.3);
    expect(layout.mirror!.y).toBeGreaterThan(0.6 * layout.halfWidth);
    expect(layout.mirror!.width).toBe(vehicle.geometry.mirrorWidth);
    expect(layout.plateZ + 0.115).toBeLessThan(shape.tailHeight);
  });
});

describe("appearance and simulation", () => {
  it("gives every vertex of the body mesh the section data of its station", () => {
    const shape = buildBodyShape(getBuiltInVehicle("sedan").geometry);
    const mesh = buildBodyMesh(shape);
    const section = sectionAttribute(shape, mesh.positions);
    expect(section.length).toBe(mesh.positions.length);
    const vertex = 3 * (5 * mesh.ringSize + 3);
    expect(section[vertex]).toBeCloseTo(upperZ(shape, mesh.positions[vertex]), 6);
  });

  it("is not part of a simulation configuration", () => {
    const car = getBuiltInVehicle("porsche-911-carrera-992");
    const config = makeConfig(car, car.geometry, STANDARD_ENVIRONMENT, 40, "reduced-order", "coarse");
    expect(Object.keys(config).sort()).toEqual(
      ["environment", "fidelity", "geometry", "mode", "reference", "referenceGeometry", "speed", "vehicleId"].sort(),
    );
    expect(JSON.stringify(config)).not.toContain(appearanceFor(car).paint);
  });
});
