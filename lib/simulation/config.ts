import type {
  AeroCoefficients,
  Environment,
  Fidelity,
  GeometryParams,
  Powertrain,
  SimulationConfig,
  SimulationMode,
  VehicleDefinition,
  VehicleSpec,
} from "@/lib/types";
import { completeGeometry } from "@/lib/geometry/parameters";
import { bodyIdFor } from "@/lib/geometry/sampledBody";
import { DEG_TO_RAD } from "@/lib/physics/model";
import type { PerformanceInput } from "@/lib/vehicle/performance";

/** Builds the configuration of one aerodynamic simulation for a (possibly modified) vehicle. */
export function makeConfig(
  vehicle: VehicleDefinition,
  geometry: GeometryParams,
  environment: Environment,
  speed: number,
  mode: SimulationMode,
  fidelity: Fidelity,
): SimulationConfig {
  const config: SimulationConfig = {
    vehicleId: vehicle.id,
    reference: { ...vehicle.reference },
    // A production-car look-alike is anchored to its generic class, not to itself.
    referenceGeometry: { ...completeGeometry(vehicle.referenceGeometry ?? vehicle.geometry) },
    geometry: { ...completeGeometry(geometry) },
    environment: { ...environment },
    speed,
    mode,
    fidelity,
  };
  // An imported 3D model is solved on its measured envelope for as long as its shape parameters are untouched.
  const bodyId = bodyIdFor(vehicle.importedModel, geometry);
  if (bodyId) config.bodyId = bodyId;
  return config;
}

/** Collects the inputs of the vehicle-performance model from an aerodynamic result. */
export function makePerformanceInput(
  vehicle: VehicleSpec,
  powertrain: Powertrain,
  geometry: GeometryParams,
  coefficients: AeroCoefficients,
  airDensity: number,
  environment: Environment,
  speed: number,
): PerformanceInput {
  return {
    vehicle,
    powertrain,
    wheelRadius: geometry.wheelDiameter / 2,
    wheelbase: geometry.wheelbase,
    aero: coefficients,
    airDensity,
    gradientDeg: environment.gradient,
    headwind: environment.windSpeed * Math.cos(environment.windAngle * DEG_TO_RAD),
    testSpeed: speed,
  };
}

export function vehicleSpecOf(vehicle: VehicleDefinition): VehicleSpec {
  return {
    mass: vehicle.mass,
    cgHeight: vehicle.cgHeight,
    weightDistFront: vehicle.weightDistFront,
    drivetrain: vehicle.drivetrain,
    crr: vehicle.crr,
    tireMu: vehicle.tireMu,
  };
}
