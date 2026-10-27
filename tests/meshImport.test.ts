import { describe, expect, it, test } from "vitest";
import { computeMetrics } from "@/lib/geometry/metrics";
import { buildBodyMesh } from "@/lib/geometry/mesh";
import { fitGeometry, guessOrientation, measureAtScale, measureModel, NoWheelsError, orientMesh, SHAPE_PARAMS } from "@/lib/geometry/meshImport";
import { overallLength } from "@/lib/geometry/parameters";
import { buildBodyShape, halfWidth, lowerZ, planHalfWidth, upperZ, withSampledBody } from "@/lib/geometry/profile";
import { validateGeometry } from "@/lib/geometry/validate";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { asModelFile, parametricSoup } from "./meshSoup";

const CARS = ["fastback", "sedan", "hatchback", "suv", "sports-coupe", "generic-ev"];

describe("orienting a model file", () => {
  const geometry = getBuiltInVehicle("sedan").geometry;
  const soup = parametricSoup(geometry);
  const file = asModelFile(soup, 39.37, [12, -3, 40]); // inches, Y-up, off-centre

  test("the orientation is guessed: Y up, length along Z, nose at the high end", () => {
    const guess = guessOrientation(file, true);
    expect(guess).toEqual({ upAxis: 1, lengthAxis: 2, reverse: true });
    // Without the Y-up hint the shortest extent is taken as up.
    expect(guessOrientation(file, false).upAxis).toBe(1);
  });

  test("the model is returned to tunnel coordinates at the requested length", () => {
    const oriented = orientMesh(file, guessOrientation(file, true), overallLength(geometry));
    expect(oriented.length).toBeCloseTo(overallLength(geometry), 6);
    expect(oriented.scale).toBeCloseTo(1 / 39.37, 6);
    let worst = 0;
    for (let i = 0; i < soup.length; i++) worst = Math.max(worst, Math.abs(oriented.positions[i] - soup[i]));
    expect(worst).toBeLessThan(2e-4);
    // The matrix reproduces the same map and is a rotation with uniform scale, not a mirror image.
    const m = oriented.matrix;
    const p = [file[0], file[1], file[2]];
    for (let r = 0; r < 3; r++) {
      expect(m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]).toBeCloseTo(oriented.positions[r], 4);
    }
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    expect(det).toBeCloseTo(oriented.scale ** 3, 9);
  });

  test("a wrong axis choice is refused", () => {
    expect(() => orientMesh(file, { upAxis: 1, lengthAxis: 1, reverse: false })).toThrowError(/different axes/);
  });
});

describe.each(CARS)("measuring the %s written out as a mesh", (id) => {
  const geometry = getBuiltInVehicle(id).geometry;
  const shape = buildBodyShape(geometry);
  const measured = measureModel(parametricSoup(geometry), `test-${id}`);
  const h = measured.resolution;

  test("overall dimensions, floor height and wheels are recovered", () => {
    expect(measured.length).toBeCloseTo(shape.length, 2);
    expect(measured.height).toBeCloseTo(geometry.rideHeight + geometry.roofHeight, 2);
    expect(Math.abs(measured.width - geometry.width)).toBeLessThan(2 * h);
    expect(Math.abs(measured.rideHeight - geometry.rideHeight)).toBeLessThan(1.5 * h);
    const wheels = measured.wheels!;
    expect(wheels).not.toBeNull();
    expect(Math.abs(wheels.frontAxleX - shape.frontAxleX)).toBeLessThan(1.5 * h);
    expect(Math.abs(wheels.rearAxleX - shape.rearAxleX)).toBeLessThan(1.5 * h);
    expect(Math.abs(wheels.diameter - geometry.wheelDiameter)).toBeLessThan(0.03);
    expect(Math.abs(wheels.tireWidth - geometry.tireWidth)).toBeLessThan(0.012);
  });

  test("the measured envelope follows the surface it was sampled from", () => {
    const sampled = withSampledBody(shape, measured.body);
    let upperError = 0;
    let planError = 0;
    let count = 0;
    for (let x = 0.3; x < shape.length - 0.15; x += 0.07) {
      upperError += Math.abs(upperZ(sampled, x) - upperZ(shape, x));
      planError += Math.abs(planHalfWidth(sampled, x) - planHalfWidth(shape, x));
      count++;
    }
    // The measured floor plane can sit up to a cell away from the true one, which shifts every body-frame height.
    expect(upperError / count).toBeLessThan(1.6 * h);
    expect(planError / count).toBeLessThan(1.0 * h);
    const mid = 0.5 * shape.length;
    expect(Math.abs(halfWidth(sampled, mid, 0.5 * geometry.roofHeight) - halfWidth(shape, mid, 0.5 * geometry.roofHeight))).toBeLessThan(1.5 * h);
    expect(lowerZ(sampled, mid)).toBeLessThan(1.5 * h);
    // Above the roof and below the floor there is no body.
    expect(halfWidth(sampled, mid, geometry.roofHeight + 0.1)).toBe(0);
  });

  test("frontal area from the envelope and from the silhouette both match the parametric car", () => {
    const exact = computeMetrics(shape).frontalArea;
    const sampled = computeMetrics(withSampledBody(shape, measured.body)).frontalArea;
    expect(Math.abs(sampled - exact) / exact).toBeLessThan(0.03);
    expect(Math.abs(measured.silhouetteArea - exact) / exact).toBeLessThan(0.04);
  });

  test("the fitted parameters describe the same car and can be built", () => {
    const anchor = getBuiltInVehicle(id).geometry;
    const { geometry: fitted, basis, notes } = fitGeometry(measured, anchor);
    expect(validateGeometry(fitted).filter((issue) => issue.severity === "error")).toEqual([]);
    expect(Math.abs(overallLength(fitted) - shape.length)).toBeLessThan(0.021);
    expect(Math.abs(fitted.wheelbase - geometry.wheelbase)).toBeLessThan(0.05);
    expect(Math.abs(fitted.frontOverhang - geometry.frontOverhang)).toBeLessThan(0.04);
    expect(Math.abs(fitted.roofHeight - geometry.roofHeight)).toBeLessThan(0.04);
    expect(Math.abs(fitted.rideHeight - geometry.rideHeight)).toBeLessThan(0.03);
    expect(Math.abs(fitted.width - geometry.width)).toBeLessThan(0.05);
    expect(Math.abs(fitted.hoodLength - geometry.hoodLength)).toBeLessThan(0.25);
    expect(Math.abs(fitted.windshieldAngle - geometry.windshieldAngle)).toBeLessThan(6);
    expect(Math.abs(fitted.hoodHeight - geometry.hoodHeight)).toBeLessThan(0.08);
    expect(Math.abs(fitted.rearBumperHeight - geometry.rearBumperHeight)).toBeLessThan(0.1);
    if (geometry.rearDeckLength === 0) expect(Math.abs(fitted.rearWindowAngle - geometry.rearWindowAngle)).toBeLessThan(8);
    expect(Math.abs(fitted.wheelDiameter - geometry.wheelDiameter)).toBeLessThan(0.03);
    // What a surface cannot tell stays with the class, and separate devices start switched off.
    expect(fitted.floorFlatness).toBe(anchor.floorFlatness);
    expect(fitted.wheelExposure).toBe(anchor.wheelExposure);
    expect([fitted.spoilerHeight, fitted.wingChord, fitted.splitterExtension, fitted.sideSkirtDepth]).toEqual([0, 0, 0, 0]);
    for (const param of SHAPE_PARAMS) expect(basis[param], param).toBe("measured");
    expect(basis.floorFlatness).toBe("class");
    expect(Array.isArray(notes)).toBe(true);
  });
});

describe("models that are not clean", () => {
  const geometry = getBuiltInVehicle("fastback").geometry;
  const soup = parametricSoup(geometry);

  test("mirrors and an antenna are not mistaken for bodywork", () => {
    const extras: number[] = [];
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
      // Two faces are enough for a point-sampled envelope.
      extras.push(x0, y0, z0, x1, y0, z0, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z1);
      extras.push(x0, y1, z0, x1, y1, z0, x1, y0, z1, x0, y1, z0, x1, y0, z1, x0, y0, z1);
    };
    const half = geometry.width / 2;
    box(1.5, 1.68, half - 0.02, half + 0.2, 1.0, 1.12); // left mirror
    box(1.5, 1.68, -half - 0.2, -half + 0.02, 1.0, 1.12); // right mirror
    box(3.4, 3.5, -0.02, 0.02, 1.38, 1.52); // roof antenna
    const withExtras = new Float32Array([...soup, ...extras]);
    const clean = measureModel(soup, "clean");
    const dressed = measureModel(withExtras, "dressed");
    expect(Math.abs(dressed.width - clean.width)).toBeLessThan(0.021);
    expect(Math.abs(Math.max(...dressed.body.upper) - Math.max(...clean.body.upper))).toBeLessThan(0.021);
    // The silhouette, which is reported for reference, does include them.
    expect(dressed.silhouetteArea).toBeGreaterThan(clean.silhouetteArea + 0.03);
  });

  test("a model without wheels on the ground is measured, and says so", () => {
    // Lift the whole car off the ground: there are no contact patches to find.
    const floating = new Float32Array(soup);
    for (let i = 2; i < floating.length; i += 3) floating[i] += 0.5;
    const measured = measureModel(floating, "floating");
    expect(measured.wheels).toBeNull();
    const fitted = fitGeometry(measured, geometry);
    expect(fitted.notes.some((note) => note.includes("No tyre contact patches"))).toBe(true);
  });

  test("an empty or tiny model is rejected with a reason", () => {
    expect(() => measureModel(new Float32Array(0), "empty")).toThrowError(/no triangles/);
    const tiny = new Float32Array(soup.length);
    for (let i = 0; i < soup.length; i++) tiny[i] = soup[i] * 0.01;
    expect(() => measureModel(tiny, "tiny")).toThrowError(/too small/);
  });
});

describe("real-model cases", () => {
  /** A box behind the tail, the size of a spare wheel on its carrier. */
  function withSpareWheel(soup: Float32Array, length: number, ride: number, depth: number): Float32Array {
    const [x0, x1, y, z0, z1] = [length, length + depth, 0.39, ride + 0.42, ride + 1.2];
    const corners = [
      [x0, -y, z0], [x1, -y, z0], [x1, y, z0], [x0, y, z0],
      [x0, -y, z1], [x1, -y, z1], [x1, y, z1], [x0, y, z1],
    ];
    const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const box = faces.flatMap((corner) => corners[corner]);
    const out = new Float32Array(soup.length + box.length);
    out.set(soup);
    out.set(box, soup.length);
    return out;
  }

  it("leaves a rear-mounted spare wheel out of the body the solver uses", () => {
    const geometry = getBuiltInVehicle("suv").geometry;
    const length = overallLength(geometry);
    const plain = measureModel(parametricSoup(geometry), "plain");
    const measured = measureModel(withSpareWheel(parametricSoup(geometry), length, geometry.rideHeight, 0.28), "spare");
    expect(plain.rearAttachment).toBe(0);
    expect(measured.overallLength).toBeCloseTo(length + 0.28, 2);
    expect(Math.abs(measured.rearAttachment - 0.28)).toBeLessThan(0.03);
    expect(Math.abs(measured.length - length)).toBeLessThan(0.03);
    expect(Math.abs(measured.body.length - plain.body.length)).toBeLessThan(0.03);
    // The tail of the body is the car's, not the wheel's.
    const last = measured.body.nx - 1;
    expect(measured.body.plan[last]).toBeGreaterThan(0.8 * (geometry.width / 2));
    // (One 20 mm station on this car's 62 degree rear window is 38 mm of height.)
    expect(Math.abs(measured.body.upper[last] - plain.body.upper[plain.body.nx - 1])).toBeLessThan(0.05);
    // The fitted car is the same with and without the wheel.
    const fitted = fitGeometry(measured, geometry).geometry;
    const reference = fitGeometry(plain, geometry).geometry;
    expect(Math.abs(fitted.rearOverhang - reference.rearOverhang)).toBeLessThan(0.03);
    expect(Math.abs(fitted.rearWindowAngle - reference.rearWindowAngle)).toBeLessThan(4);
  });

  it("scales a model in arbitrary units by its wheelbase, spare wheel or not", () => {
    const geometry = getBuiltInVehicle("suv").geometry;
    const length = overallLength(geometry);
    const soup = withSpareWheel(parametricSoup(geometry), length, geometry.rideHeight, 0.28);
    const file = asModelFile(soup, 0.1076, [0.02, 0.01, -0.3]);
    const orientation = guessOrientation(file, true);
    const { measured, oriented } = measureAtScale(file, orientation, { targetWheelbase: geometry.wheelbase }, "by-wheelbase");
    expect(Math.abs(measured.wheels!.rearAxleX - measured.wheels!.frontAxleX - geometry.wheelbase)).toBeLessThan(0.03);
    expect(Math.abs(measured.length - length)).toBeLessThan(0.04);
    expect(Math.abs(measured.width - geometry.width)).toBeLessThan(0.03);
    expect(oriented.scale).toBeGreaterThan(9);
    // Scaled by the overall length instead, the spare wheel makes the whole car about 6 % too small.
    const byLength = measureAtScale(file, orientation, { targetLength: length }, "by-length").measured;
    expect(byLength.width).toBeLessThan(0.96 * geometry.width);
  });

  it("refuses to scale by wheelbase when the model has no wheels on the ground", () => {
    const geometry = getBuiltInVehicle("sedan").geometry;
    const shape = buildBodyShape(geometry);
    const mesh = buildBodyMesh(shape);
    const body: number[] = [];
    for (let i = 0; i < mesh.indices.length; i++) {
      const v = mesh.indices[i] * 3;
      body.push(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]);
    }
    const file = asModelFile(new Float32Array(body), 1, [0, 0, 0]);
    expect(() => measureAtScale(file, guessOrientation(file, true), { targetWheelbase: 2.8 }, "no-wheels")).toThrow(NoWheelsError);
  });

  it("reads an upright rear end when the roof only dips a little before a vertical tail", () => {
    // A van-like body: the roof runs almost level to a tail that is nearly as high.
    const base = getBuiltInVehicle("suv").geometry;
    const geometry = { ...base, rearWindowAngle: 80, rearBumperHeight: base.roofHeight - 0.09, rearDeckLength: 0 };
    const fitted = fitGeometry(measureModel(parametricSoup(geometry), "van"), base).geometry;
    expect(fitted.rearWindowAngle).toBe(85);
    expect(fitted.rearDeckLength).toBe(0);
  });
});
