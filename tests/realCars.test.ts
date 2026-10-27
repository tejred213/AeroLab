import { describe, expect, test } from "vitest";
import realCarData from "@/shared/real-cars.json";
import { clampGeometry, overallLength, PARAM_DEFINITIONS } from "@/lib/geometry/parameters";
import { validateGeometry } from "@/lib/geometry/validate";
import { MODEL } from "@/lib/physics/model";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { makeConfig } from "@/lib/simulation/config";
import { runLocal } from "@/lib/simulation/engine";
import {
  rankCorrelation,
  summarizeValidation,
  validationConfig,
  validationRow,
  type ValidationRow,
} from "@/lib/simulation/validation";
import { STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import type { ParamBasis } from "@/lib/types";
import { BUILT_IN_VEHICLES, findVehicle, getBuiltInVehicle, LIBRARY_VEHICLES, REAL_CARS } from "@/lib/vehicle/library";

const BASES: ParamBasis[] = ["published", "derived", "estimated", "class"];

describe("production-car look-alikes: data", () => {
  test("seventeen cars, each with its own id, alongside the six generic classes", () => {
    expect(REAL_CARS.length).toBe(17);
    expect(BUILT_IN_VEHICLES.length).toBe(6);
    const ids = LIBRARY_VEHICLES.map((vehicle) => vehicle.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(LIBRARY_VEHICLES.slice(0, 6)).toEqual(BUILT_IN_VEHICLES);
    expect(findVehicle("tesla-model-3")?.realCar?.published.cd).toBe(0.219);
    expect(getBuiltInVehicle("porsche-911-carrera-992").realCar?.anchorClassId).toBe("sports-coupe");
    expect(BUILT_IN_VEHICLES.every((vehicle) => vehicle.realCar === undefined)).toBe(true);
  });

  test("every car is anchored to a generic class, not to its own published figure", () => {
    for (const car of REAL_CARS) {
      const info = car.realCar!;
      const anchor = getBuiltInVehicle(info.anchorClassId);
      expect(anchor.realCar).toBeUndefined();
      expect(car.reference).toEqual(anchor.reference);
      expect(car.referenceGeometry).toEqual(anchor.geometry);
      expect(car.geometry).not.toEqual(anchor.geometry);
      expect(car.powertrain.type).toBe(anchor.powertrain.type);
      expect(car.description).toContain("look-alike");
    }
  });

  test("every geometry can be built and lies inside the simulator's parameter ranges", () => {
    for (const car of REAL_CARS) {
      expect(validateGeometry(car.geometry), car.id).toEqual([]);
      expect(clampGeometry(car.geometry), car.id).toEqual(car.geometry);
    }
  });

  test("the look-alike reproduces the published dimensions", () => {
    for (const car of REAL_CARS) {
      const { published } = car.realCar!;
      const g = car.geometry;
      // Each of the three lengths is stored to the nearest 10 mm.
      expect(Math.abs(overallLength(g) - published.length), `${car.id} length`).toBeLessThan(0.0151);
      expect(Math.abs(g.rideHeight + g.roofHeight - published.height), `${car.id} height`).toBeLessThan(0.0031);
      expect(Math.abs(g.wheelbase - published.wheelbase), `${car.id} wheelbase`).toBeLessThan(0.0051);
      expect(Math.abs(g.width - published.width), `${car.id} width`).toBeLessThan(0.0051);
      if (published.groundClearance !== null) {
        expect(g.rideHeight, `${car.id} ride height`).toBeCloseTo(published.groundClearance, 6);
      }
      expect(car.mass).toBe(published.kerbMass);
      expect(g.minGroundClearance).toBeLessThan(g.rideHeight);
    }
  });

  test("the origin of every parameter is recorded, and matches what was published", () => {
    for (const car of REAL_CARS) {
      const { basis, published } = car.realCar!;
      expect(Object.keys(basis).sort()).toEqual(PARAM_DEFINITIONS.map((definition) => definition.id).sort());
      expect(Object.values(basis).every((value) => BASES.includes(value))).toBe(true);
      const anchor = getBuiltInVehicle(car.realCar!.anchorClassId);
      for (const definition of PARAM_DEFINITIONS) {
        if (basis[definition.id] === "class") {
          expect(car.geometry[definition.id], `${car.id} ${definition.id}`).toBe(anchor.geometry[definition.id]);
        }
      }
      expect(basis.wheelbase).toBe("published");
      expect(basis.width).toBe("published");
      // A car with no published clearance cannot claim a published or derived ride and roof height.
      expect(basis.rideHeight).toBe(published.groundClearance === null ? "estimated" : "published");
      expect(basis.roofHeight).toBe(published.groundClearance === null ? "estimated" : "derived");
      // Proportions that manufacturers do not publish are never labelled as published.
      for (const id of ["hoodLength", "windshieldAngle", "rearWindowAngle", "frontTaper", "rearTaper", "cabinWidthRatio"] as const) {
        expect(basis[id], `${car.id} ${id}`).toBe("estimated");
      }
    }
  });

  test("every car names its sources, and a missing published figure is explained rather than filled in", () => {
    const unpublished: string[] = [];
    for (const car of REAL_CARS) {
      const { sources, published } = car.realCar!;
      expect(sources.length, car.id).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source.label.length).toBeGreaterThan(10);
        expect(source.url).toMatch(/^https:\/\//);
      }
      expect(published.cdNote.length, car.id).toBeGreaterThan(20);
      if (published.cd === null) unpublished.push(car.id);
      else expect(published.cd).toBeGreaterThan(0.15);
      if (published.frontalArea !== null) expect(published.frontalArea).toBeGreaterThan(1.5);
    }
    expect(unpublished).toEqual(["chevrolet-corvette-c8", "mazda-mx-5-nd"]);
  });

  test("the data file itself holds no drag coefficient outside the 'published' block", () => {
    for (const record of realCarData.cars) {
      const { published: _published, ...rest } = record;
      expect(JSON.stringify(rest)).not.toMatch(/"cd"\s*:/);
    }
  });
});

describe("production-car look-alikes: prediction", () => {
  test("a simulation of a car is anchored to its class", () => {
    const car = getBuiltInVehicle("bmw-320d-g20");
    const sedan = getBuiltInVehicle("sedan");
    const config = makeConfig(car, car.geometry, STANDARD_ENVIRONMENT, 40, "analytical", "coarse");
    expect(config.vehicleId).toBe("bmw-320d-g20");
    expect(config.reference).toEqual(sedan.reference);
    expect(config.referenceGeometry).toEqual(sedan.geometry);
    expect(config.geometry).toEqual(car.geometry);
    // The unmodified class still reproduces its own reference; the car does not.
    expect(runAnalytical(validationConfig(sedan, "analytical")).coefficients.cd).toBeCloseTo(sedan.reference.cd, 6);
    expect(runAnalytical(validationConfig(car, "analytical")).coefficients.cd).not.toBeCloseTo(sedan.reference.cd, 3);
  });

  test("the published figure cannot influence the prediction", () => {
    const car = getBuiltInVehicle("mercedes-benz-eqs-450");
    const altered = structuredClone(car);
    altered.realCar!.published.cd = 0.99;
    altered.realCar!.published.frontalArea = 9.9;
    expect(runAnalytical(validationConfig(altered, "analytical")).coefficients).toEqual(
      runAnalytical(validationConfig(car, "analytical")).coefficients,
    );
  });

  test("every car runs in Mode A and Mode B, with a larger stated uncertainty than its class", () => {
    for (const car of REAL_CARS) {
      const anchor = getBuiltInVehicle(car.realCar!.anchorClassId);
      const floor = MODEL.uncertainty.analytical.cdRelative * anchor.reference.cd;
      const aero = runAnalytical(validationConfig(car, "analytical"));
      expect(Number.isFinite(aero.coefficients.cd) && Number.isFinite(aero.coefficients.cl), car.id).toBe(true);
      expect(aero.coefficients.cd, car.id).toBeGreaterThan(0.1);
      expect(aero.coefficients.cd, car.id).toBeLessThan(0.9);
      expect(aero.uncertainty.cd, car.id).toBeGreaterThan(floor * 0.99);
      expect(aero.mode).toBe("analytical");
    }
    for (const id of ["tesla-model-3", "volkswagen-golf-8", "mercedes-benz-g-500"]) {
      const { aero } = runLocal(validationConfig(getBuiltInVehicle(id), "reduced-order"), false).result;
      expect(aero.mode).toBe("reduced-order");
      expect(aero.solver?.converged, id).toBe(true);
      expect(aero.coefficients.cd, id).toBeGreaterThan(0.1);
    }
  });

  test("a validation row compares the prediction with the published figure and with the class alone", () => {
    const car = getBuiltInVehicle("volkswagen-golf-8");
    const aero = runAnalytical(validationConfig(car, "analytical"));
    const row = validationRow(car, aero);
    expect(row.anchorClassName).toBe("Hatchback");
    expect(row.anchorCd).toBe(0.31);
    expect(row.publishedCd).toBe(0.275);
    expect(row.predictedCd).toBe(aero.coefficients.cd);
    expect(row.error).toBeCloseTo(aero.coefficients.cd - 0.275, 12);
    expect(row.baselineError).toBeCloseTo(0.31 - 0.275, 12);
    expect(row.publishedArea).toBe(2.22);
    expect(row.areaError).toBeCloseTo((aero.coefficients.frontalArea - 2.22) / 2.22, 12);

    const unpublished = validationRow(getBuiltInVehicle("mazda-mx-5-nd"), runAnalytical(validationConfig(getBuiltInVehicle("mazda-mx-5-nd"), "analytical")));
    expect([unpublished.publishedCd, unpublished.error, unpublished.baselineError, unpublished.areaError]).toEqual([null, null, null, null]);
    expect(() => validationRow(getBuiltInVehicle("sedan"), aero)).toThrowError(/not a production-car look-alike/);
  });
});

describe("validation statistics", () => {
  const row = (name: string, published: number | null, predicted: number, anchor: number, uncertainty: number, areaError: number | null = null): ValidationRow => ({
    id: name,
    name,
    anchorClassName: "Sedan",
    anchorCd: anchor,
    publishedCd: published,
    cdNote: "",
    predictedCd: predicted,
    uncertainty,
    error: published === null ? null : predicted - published,
    baselineError: published === null ? null : anchor - published,
    publishedArea: null,
    computedArea: 2.2,
    areaError,
    mode: "analytical",
    warnings: [],
  });

  test("rank correlation", () => {
    expect(rankCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(rankCorrelation([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 12);
    expect(rankCorrelation([1, 2, 3, 4, 5], [2, 1, 4, 3, 5])).toBeCloseTo(0.8, 12);
    // Ties share the mean rank.
    expect(rankCorrelation([1, 1, 2], [1, 2, 3])).toBeCloseTo(0.8660254, 6);
    expect(rankCorrelation([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(rankCorrelation([1], [1])).toBeNaN();
  });

  test("summary: errors, skill against the class reference, coverage of the stated uncertainty", () => {
    const rows = [
      row("a", 0.2, 0.22, 0.28, 0.03, 0.04), // error +0.02, baseline +0.08, inside 1 sigma
      row("b", 0.3, 0.26, 0.28, 0.03, -0.02), // error -0.04, baseline -0.02, inside 2 sigma only
      row("c", 0.4, 0.31, 0.28, 0.02), // error -0.09, baseline -0.12, outside 2 sigma
      row("d", null, 0.35, 0.31, 0.02), // no published figure: not scored
    ];
    const summary = summarizeValidation(rows)!;
    expect(summary.count).toBe(3);
    expect(summary.meanAbsError).toBeCloseTo((0.02 + 0.04 + 0.09) / 3, 12);
    expect(summary.baselineMeanAbsError).toBeCloseTo((0.08 + 0.02 + 0.12) / 3, 12);
    expect(summary.skill).toBeCloseTo(1 - 0.15 / 0.22, 12);
    expect(summary.bias).toBeCloseTo((0.02 - 0.04 - 0.09) / 3, 12);
    expect(summary.rootMeanSquareError).toBeCloseTo(Math.sqrt((0.0004 + 0.0016 + 0.0081) / 3), 12);
    expect(summary.largest).toEqual({ name: "c", error: expect.closeTo(-0.09, 12) });
    expect([summary.withinOneSigma, summary.withinTwoSigma]).toEqual([1, 2]);
    expect(summary.rankCorrelation).toBeCloseTo(1, 12);
    expect(summary.meanAbsAreaError).toBeCloseTo(0.03, 12);
    expect(summary.areaCount).toBe(2);
  });

  test("a model that is worse than the class reference has negative skill; no published figures gives no summary", () => {
    const worse = summarizeValidation([row("a", 0.3, 0.2, 0.29, 0.01)])!;
    expect(worse.skill).toBeLessThan(0);
    expect(summarizeValidation([row("d", null, 0.35, 0.31, 0.02)])).toBeNull();
    expect(summarizeValidation([])).toBeNull();
  });
});
