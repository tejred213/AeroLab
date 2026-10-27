/**
 * Air properties. backend/physics/atmosphere.py mirrors this file.
 */
import type { Environment } from "@/lib/types";
import { MODEL } from "@/lib/physics/model";

const AIR = MODEL.air;

/** Saturation vapour pressure of water over liquid (Magnus form), Pa. T in kelvin. */
export function saturationVapourPressure(temperature: number): number {
  const celsius = temperature - 273.15;
  return 610.94 * Math.exp((17.625 * celsius) / (celsius + 243.04));
}

/**
 * Density of moist air from the ideal-gas law applied to dry air and water
 * vapour separately:  rho = p_d / (R_d T) + p_v / (R_v T).
 */
export function moistAirDensity(temperature: number, pressure: number, relativeHumidity: number): number {
  const vapourPressure = Math.min(
    Math.max(relativeHumidity, 0) * saturationVapourPressure(temperature),
    pressure,
  );
  const dryPressure = pressure - vapourPressure;
  return (
    dryPressure / (AIR.gasConstantDryAir * temperature) +
    vapourPressure / (AIR.gasConstantWaterVapour * temperature)
  );
}

/** Dynamic viscosity of air from Sutherland's law, Pa*s. */
export function airViscosity(temperature: number): number {
  const t0 = AIR.sutherlandReferenceTemperature;
  const s = AIR.sutherlandConstant;
  return AIR.sutherlandReferenceViscosity * Math.pow(temperature / t0, 1.5) * ((t0 + s) / (temperature + s));
}

export interface AirState {
  density: number;
  viscosity: number;
}

/** Resolves the air state for an environment, honouring the direct-density override. */
export function resolveAir(environment: Environment): AirState {
  const density =
    environment.airDensityMode === "direct"
      ? environment.airDensity
      : moistAirDensity(environment.temperature, environment.pressure, environment.humidity);
  return { density, viscosity: airViscosity(environment.temperature) };
}

export function reynoldsNumber(density: number, speed: number, length: number, viscosity: number): number {
  return (density * speed * length) / viscosity;
}

export const STANDARD_ENVIRONMENT: Environment = {
  airDensityMode: "computed",
  airDensity: 1.225,
  temperature: 288.15,
  pressure: 101325,
  humidity: 0,
  windSpeed: 0,
  windAngle: 0,
  gradient: 0,
};
