/**
 * Solving on the measured envelope of an imported model.
 *
 * The test model is one of the simulator's own cars written out as a mesh, so
 * the right answer is known: the solver on the re-imported car must agree with
 * the solver on the original parametric car.
 */
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fitGeometry, guessOrientation, measureModel, orientMesh, SHAPE_PARAMS } from "@/lib/geometry/meshImport";
import { bodyIdFor, registerSampledBody, removeSampledBody, studyConfig } from "@/lib/geometry/sampledBody";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { runLocal } from "@/lib/simulation/engine";
import { hashConfig } from "@/lib/simulation/hash";
import { runReducedOrder } from "@/lib/simulation/reducedOrderEngine";
import { runSweep } from "@/lib/simulation/sweep";
import type { AeroResult, GeometryParams, ImportedModelInfo, ParamId, SimulationConfig } from "@/lib/types";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { vehicleSpecOf } from "@/lib/simulation/config";
import { configFor } from "./helpers";
import { asModelFile, parametricSoup } from "./meshSoup";

const NO_DEVICES = { spoilerHeight: 0, wingChord: 0, splitterExtension: 0, sideSkirtDepth: 0 };

interface Imported {
  config: SimulationConfig;
  parametric: SimulationConfig;
  fitted: GeometryParams;
}

/** Imports the parametric car `vehicleId` as a mesh and builds the configurations with and without its envelope. */
function importCar(vehicleId: string, mode: "analytical" | "reduced-order"): Imported {
  const original = getBuiltInVehicle(vehicleId).geometry;
  const file = asModelFile(parametricSoup(original), 1, [0.4, -0.2, 1.3]);
  const oriented = orientMesh(file, guessOrientation(file, true));
  const measured = measureModel(oriented.positions, `test-${vehicleId}`);
  registerSampledBody(measured.body);
  const fitted = fitGeometry(measured, original).geometry;
  // The mesh holds the body and the wheels only, so the car to compare with has its separate devices removed.
  const parametric = configFor(vehicleId, NO_DEVICES, { mode });
  return { config: { ...parametric, geometry: fitted, bodyId: measured.body.id }, parametric, fitted };
}

const log: string[] = [];
function record(vehicleId: string, mode: string, onParams: AeroResult, onModel: AeroResult): void {
  log.push(
    `${vehicleId} ${mode}: Cd ${onParams.coefficients.cd.toFixed(4)} -> ${onModel.coefficients.cd.toFixed(4)}  ` +
      `Cl ${onParams.coefficients.cl.toFixed(4)} -> ${onModel.coefficients.cl.toFixed(4)}`,
  );
}
// Set REIMPORT_LOG to a file path to keep the comparison table of a run.
afterAll(() => {
  if (process.env.REIMPORT_LOG) writeFileSync(process.env.REIMPORT_LOG, `${log.join("\n")}\n`);
});

describe("solving on an imported model", () => {
  describe.each(["fastback", "sedan", "suv", "hatchback", "sports-coupe", "generic-ev"])("%s re-imported as a mesh", (vehicleId) => {
    let imported: Imported;
    beforeAll(() => {
      imported = importCar(vehicleId, "reduced-order");
    });

    it("gives Mode B coefficients close to those of the parametric car", () => {
      const onModel = runReducedOrder(imported.config).aero;
      const onParams = runReducedOrder(imported.parametric).aero;
      record(vehicleId, "B", onParams, onModel);
      expect(Math.abs(onModel.coefficients.cd - onParams.coefficients.cd)).toBeLessThan(0.02);
      expect(Math.abs(onModel.coefficients.cl - onParams.coefficients.cl)).toBeLessThan(0.08);
      expect(Math.abs(onModel.metrics.frontalArea / onParams.metrics.frontalArea - 1)).toBeLessThan(0.01);
      expect(onModel.warnings.map((warning) => warning.code)).toContain("IMPORTED_GEOMETRY");
      expect(onParams.warnings.map((warning) => warning.code)).not.toContain("IMPORTED_GEOMETRY");
      expect(onModel.assumptions.some((line) => line.includes("imported 3D model"))).toBe(true);
    });

    it("gives Mode A coefficients close to those of the parametric car", () => {
      const onModel = runAnalytical({ ...imported.config, mode: "analytical" });
      const onParams = runAnalytical({ ...imported.parametric, mode: "analytical" });
      record(vehicleId, "A", onParams, onModel);
      expect(Math.abs(onModel.coefficients.cd - onParams.coefficients.cd)).toBeLessThan(0.02);
      expect(Math.abs(onModel.coefficients.cl - onParams.coefficients.cl)).toBeLessThan(0.08);
    });
  });

  it("reports a missing or mismatched body instead of silently using another shape", () => {
    const imported = importCar("hatchback", "analytical");
    expect(() => runLocal({ ...imported.config, bodyId: "not-loaded" }, false)).toThrowError(/not loaded/);
    const stretched = { ...imported.config, geometry: { ...imported.fitted, wheelbase: imported.fitted.wheelbase + 0.3 } };
    expect(() => runLocal(stretched, false)).toThrowError(/no longer match/);
    removeSampledBody(imported.config.bodyId!);
    expect(() => runLocal(imported.config, false)).toThrowError(/not loaded/);
  });

  it("makes the body part of the configuration hash", () => {
    const imported = importCar("hatchback", "analytical");
    const { bodyId: _omitted, ...withoutBody } = imported.config;
    expect(hashConfig(imported.config)).not.toBe(hashConfig(withoutBody));
  });

  it("uses the envelope only while the shape parameters are the fitted ones", () => {
    const imported = importCar("sedan", "analytical");
    const model = {
      bodyId: imported.config.bodyId!,
      shapeParams: Object.fromEntries(SHAPE_PARAMS.map((param) => [param, imported.fitted[param]])),
    } as ImportedModelInfo;
    expect(bodyIdFor(model, imported.fitted)).toBe(model.bodyId);
    expect(bodyIdFor(model, { ...imported.fitted, rideHeight: 0.1, spoilerHeight: 0.05, wheelExposure: 0.2 })).toBe(model.bodyId);
    expect(bodyIdFor(model, { ...imported.fitted, roofHeight: imported.fitted.roofHeight + 0.01 })).toBeUndefined();
    expect(bodyIdFor(undefined, imported.fitted)).toBeUndefined();
  });

  it("keeps the envelope in a ride-height sweep and drops it when a shape parameter is swept", () => {
    const imported = importCar("fastback", "analytical");
    expect(studyConfig(imported.config, ["rideHeight", null]).bodyId).toBe(imported.config.bodyId);
    expect(studyConfig(imported.config, ["spoilerAngle", "roofHeight"]).bodyId).toBeUndefined();

    const vehicle = getBuiltInVehicle("fastback");
    const base = { config: imported.config, spec: vehicleSpecOf(vehicle), powertrain: vehicle.powertrain, paramY: null, valuesY: [] };
    const ride = runSweep({ ...base, paramX: "rideHeight" as ParamId, valuesX: [0.1, 0.14, 0.18] });
    expect(ride.rows.every((row) => row.valid)).toBe(true);
    expect(ride.provenance).toContain("measured envelope");
    const roof = runSweep({ ...base, paramX: "roofHeight" as ParamId, valuesX: [1.2, 1.25, 1.3] });
    expect(roof.rows.every((row) => row.valid)).toBe(true);
    expect(roof.provenance).toContain("parametric fit");
  });
});
