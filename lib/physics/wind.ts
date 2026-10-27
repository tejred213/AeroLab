/**
 * Relative wind seen by the vehicle. backend/physics/wind.py mirrors this file.
 *
 * Wind angle convention: 0 deg = pure headwind, +/-90 deg = pure crosswind.
 * A positive angle means the ambient wind has a +Y component in vehicle axes.
 */
import { DEG_TO_RAD, RAD_TO_DEG } from "@/lib/physics/model";

export interface RelativeWind {
  /** Magnitude of the air velocity relative to the vehicle, m/s. */
  relativeSpeed: number;
  /** Aerodynamic yaw angle between the relative wind and the vehicle X axis, deg. */
  yawAngleDeg: number;
  /** Longitudinal component of the relative wind, m/s. */
  longitudinal: number;
  /** Lateral component of the relative wind, m/s. */
  lateral: number;
}

export function relativeWind(vehicleSpeed: number, windSpeed: number, windAngleDeg: number): RelativeWind {
  const angle = windAngleDeg * DEG_TO_RAD;
  const longitudinal = vehicleSpeed + windSpeed * Math.cos(angle);
  const lateral = windSpeed * Math.sin(angle);
  const relativeSpeed = Math.hypot(longitudinal, lateral);
  const yawAngleDeg = relativeSpeed > 1e-9 ? Math.atan2(lateral, longitudinal) * RAD_TO_DEG : 0;
  return { relativeSpeed, yawAngleDeg, longitudinal, lateral };
}
