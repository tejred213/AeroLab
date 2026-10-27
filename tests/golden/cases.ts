/**
 * The fixed cases behind the cross-language golden files in shared/golden/.
 *
 * generate.golden.ts writes them to JSON; tests/golden.test.ts checks that the
 * stored files still match the TypeScript engines; backend/tests/test_parity.py
 * recomputes every case with the Python engines and requires them to agree.
 */
import { computeMetrics } from "@/lib/geometry/metrics";
import { buildBodyShape } from "@/lib/geometry/profile";
import { MODEL_VERSION } from "@/lib/physics/model";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { makePerformanceInput, vehicleSpecOf } from "@/lib/simulation/config";
import { runReducedOrder } from "@/lib/simulation/reducedOrderEngine";
import { summarizePerformance } from "@/lib/state/experimentStore";
import type { AeroResult, Environment, GeometryParams, SimulationConfig } from "@/lib/types";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { computePerformance } from "@/lib/vehicle/performance";
import { configFor, KMH } from "../helpers";

interface CaseSpec {
  name: string;
  vehicle: string;
  changes?: Partial<GeometryParams>;
  speed?: number;
  environment?: Partial<Environment>;
}

const ANALYTICAL_CASES: CaseSpec[] = [
  { name: "hatchback default", vehicle: "hatchback" },
  { name: "sedan default", vehicle: "sedan" },
  { name: "sports coupe default", vehicle: "sports-coupe" },
  { name: "suv default", vehicle: "suv" },
  { name: "fastback default", vehicle: "fastback" },
  { name: "generic ev default", vehicle: "generic-ev" },
  { name: "fastback low ride", vehicle: "fastback", changes: { rideHeight: 0.07 } },
  { name: "fastback spoiler and wing", vehicle: "fastback", changes: { spoilerAngle: 35, spoilerHeight: 0.09, wingChord: 0.28, wingAngle: 11 } },
  { name: "sedan steep rear window", vehicle: "sedan", changes: { rearWindowAngle: 52 } },
  { name: "sedan near-critical slope", vehicle: "sedan", changes: { rearWindowAngle: 36, rearDeckLength: 0.2 } },
  { name: "coupe aero package", vehicle: "sports-coupe", changes: { splitterExtension: 0.09, sideSkirtDepth: 0.05, diffuserAngle: 11, floorFlatness: 0.95 } },
  { name: "suv tall and wide", vehicle: "suv", changes: { roofHeight: 1.6, width: 2.05, wheelExposure: 0.9 } },
  { name: "hatchback crosswind", vehicle: "hatchback", environment: { windSpeed: 12, windAngle: 70 } },
  { name: "ev hot humid uphill", vehicle: "generic-ev", speed: 110 * KMH, environment: { temperature: 308.15, pressure: 96000, humidity: 0.8, gradient: 4 } },
  { name: "sedan direct density headwind", vehicle: "sedan", speed: 90 * KMH, environment: { airDensityMode: "direct", airDensity: 1.1, windSpeed: 8, windAngle: 0, gradient: -3 } },
  // Production-car look-alikes: anchored to their generic class, so both languages must build the same vehicle.
  { name: "look-alike tesla model 3", vehicle: "tesla-model-3" },
  { name: "look-alike volkswagen golf", vehicle: "volkswagen-golf-8" },
  { name: "look-alike porsche 911", vehicle: "porsche-911-carrera-992" },
  { name: "look-alike mercedes g 500", vehicle: "mercedes-benz-g-500", speed: 120 * KMH },
  // Details that carry drag: mirrors, rim openness and the cooling intake, at both ends of their ranges.
  { name: "sedan without mirrors, closed rims, sealed grille", vehicle: "sedan", changes: { mirrorWidth: 0, rimOpenness: 0, grilleOpening: 0 } },
  { name: "suv wide mirrors, open rims, large grille", vehicle: "suv", changes: { mirrorWidth: 0.28, rimOpenness: 1, grilleOpening: 0.1 } },
];

const REDUCED_ORDER_CASES: CaseSpec[] = [
  { name: "fastback default", vehicle: "fastback" },
  { name: "fastback low ride", vehicle: "fastback", changes: { rideHeight: 0.09 } },
  { name: "sedan bubble", vehicle: "sedan", changes: { rearWindowAngle: 50 } },
  { name: "hatchback spoiler", vehicle: "hatchback", changes: { spoilerHeight: 0.08, spoilerAngle: 30 } },
  { name: "coupe skirts wing", vehicle: "sports-coupe", changes: { sideSkirtDepth: 0.04, wingChord: 0.25, wingAngle: 8 } },
  { name: "suv crosswind", vehicle: "suv", environment: { windSpeed: 10, windAngle: 60 } },
  { name: "look-alike hyundai ioniq 6", vehicle: "hyundai-ioniq-6" },
  { name: "look-alike jeep wrangler", vehicle: "jeep-wrangler-jl" },
  // Mirrors are solids in the flow solver: none, and the widest allowed.
  { name: "sedan without mirrors", vehicle: "sedan", changes: { mirrorWidth: 0 } },
  { name: "ev wide mirrors, open rims", vehicle: "generic-ev", changes: { mirrorWidth: 0.28, rimOpenness: 1 } },
];

function aeroRecord(aero: AeroResult) {
  return {
    coefficients: aero.coefficients,
    uncertainty: aero.uncertainty,
    forces: aero.forces,
    wind: aero.wind,
    air: aero.air,
    calibration: aero.calibration,
    rearFlow: aero.rearFlow,
    metrics: aero.metrics,
    drag: Object.fromEntries(aero.breakdown.drag.map((item) => [item.id, item.value])),
    lift: Object.fromEntries(aero.breakdown.lift.map((item) => [item.id, item.value])),
    warnings: aero.warnings.map((warning) => warning.code).sort(),
    solver: aero.solver ?? null,
  };
}

function performanceRecord(config: SimulationConfig, vehicleId: string, aero: AeroResult) {
  const vehicle = getBuiltInVehicle(vehicleId);
  const input = makePerformanceInput(
    vehicleSpecOf(vehicle),
    vehicle.powertrain,
    config.geometry,
    aero.coefficients,
    aero.air.density,
    config.environment,
    config.speed,
  );
  return summarizePerformance(computePerformance(input), input);
}

export function geometryGolden() {
  const cases = ANALYTICAL_CASES.map((spec) => {
    const config = configFor(spec.vehicle, spec.changes);
    const shape = buildBodyShape(config.geometry);
    return {
      name: spec.name,
      geometry: config.geometry,
      metrics: computeMetrics(shape),
      shape: {
        length: shape.length,
        xRoofStart: shape.xRoofStart,
        xRoofEnd: shape.xRoofEnd,
        tailHeight: shape.tailHeight,
        wheelCentreY: shape.wheelCentreY,
        diffuserExitHeight: shape.diffuserExitHeight,
      },
    };
  });
  return { modelVersion: MODEL_VERSION, cases };
}

export function analyticalGolden() {
  const cases = ANALYTICAL_CASES.map((spec) => {
    const config = configFor(spec.vehicle, spec.changes, { speed: spec.speed, environment: spec.environment });
    const aero = runAnalytical(config);
    return { name: spec.name, vehicleId: spec.vehicle, config, aero: aeroRecord(aero), performance: performanceRecord(config, spec.vehicle, aero) };
  });
  return { modelVersion: MODEL_VERSION, cases };
}

export function reducedOrderGolden() {
  const cases = REDUCED_ORDER_CASES.map((spec) => {
    const config = configFor(spec.vehicle, spec.changes, { speed: spec.speed, environment: spec.environment, mode: "reduced-order" });
    const { aero } = runReducedOrder(config);
    return { name: spec.name, vehicleId: spec.vehicle, config, aero: aeroRecord(aero) };
  });
  return { modelVersion: MODEL_VERSION, cases };
}

/** The exact text written to disk, so the freshness test compares like with like. */
export function serializeGolden(data: unknown): string {
  return `${JSON.stringify(data, null, 1)}\n`;
}
