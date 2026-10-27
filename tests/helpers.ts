import type { Environment, GeometryParams, SimulationConfig, SimulationMode } from "@/lib/types";
import { STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import { makeConfig, makePerformanceInput, vehicleSpecOf } from "@/lib/simulation/config";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { computePerformance } from "@/lib/vehicle/performance";

export const KMH = 1 / 3.6;

export function configFor(
  vehicleId: string,
  changes: Partial<GeometryParams> = {},
  options: { speed?: number; environment?: Partial<Environment>; mode?: SimulationMode } = {},
): SimulationConfig {
  const vehicle = getBuiltInVehicle(vehicleId);
  return makeConfig(
    vehicle,
    { ...vehicle.geometry, ...changes },
    { ...STANDARD_ENVIRONMENT, ...options.environment },
    options.speed ?? 150 * KMH,
    options.mode ?? "analytical",
    "coarse",
  );
}

/** Analytical aero + performance for a built-in vehicle with optional geometry changes. */
export function evaluate(
  vehicleId: string,
  changes: Partial<GeometryParams> = {},
  options: { speed?: number; environment?: Partial<Environment> } = {},
) {
  const vehicle = getBuiltInVehicle(vehicleId);
  const config = configFor(vehicleId, changes, options);
  const aero = runAnalytical(config);
  const performance = computePerformance(
    makePerformanceInput(
      vehicleSpecOf(vehicle),
      vehicle.powertrain,
      config.geometry,
      aero.coefficients,
      aero.air.density,
      config.environment,
      config.speed,
    ),
  );
  return { vehicle, config, aero, performance };
}
