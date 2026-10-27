/**
 * Simplified powertrain models: wheel force available at a given road speed.
 * backend/vehicle/powertrain.py mirrors this file.
 */
import type { EvPowertrain, IcePowertrain, Powertrain } from "@/lib/types";
import { MODEL } from "@/lib/physics/model";

const V = MODEL.vehicleModel;
const RPM_TO_RAD = (2 * Math.PI) / 60;

/** Linear interpolation through sorted (x, y) points, holding the end values outside the range. */
function interpolate(xs: number[], ys: number[], x: number): number {
  const last = xs.length - 1;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[last]) return ys[last];
  for (let i = 0; i < last; i++) {
    if (x <= xs[i + 1]) {
      const span = xs[i + 1] - xs[i];
      if (span <= 0) return ys[i + 1];
      return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / span;
    }
  }
  return ys[last];
}

/**
 * Engine torque at a crankshaft speed, N*m.
 *
 * Simplified curve: torque rises from idle to the peak-torque point, then falls
 * linearly to the torque implied by peak power, and is capped so that power
 * never exceeds the stated peak. A user-defined power curve replaces it.
 */
export function iceTorque(powertrain: IcePowertrain, rpm: number): number {
  if (rpm > powertrain.redlineRpm || rpm <= 0) return 0;
  const omega = rpm * RPM_TO_RAD;

  if (powertrain.powerCurve && powertrain.powerCurve.length >= 2) {
    const points = [...powertrain.powerCurve].sort((a, b) => a.rpm - b.rpm);
    const powerW = interpolate(
      points.map((point) => point.rpm),
      points.map((point) => point.powerW),
      rpm,
    );
    return Math.max(powerW, 0) / omega;
  }

  const torqueAtPeakPower = powertrain.peakPowerW / (powertrain.peakPowerRpm * RPM_TO_RAD);
  const torqueAtRedline =
    (V.redlinePowerFraction * powertrain.peakPowerW) / (powertrain.redlineRpm * RPM_TO_RAD);
  const peakTorqueRpm = Math.min(powertrain.peakTorqueRpm, powertrain.peakPowerRpm - 100);
  const xs = [powertrain.idleRpm, peakTorqueRpm, powertrain.peakPowerRpm, powertrain.redlineRpm];
  const ys = [
    V.idleTorqueFraction * powertrain.peakTorqueNm,
    powertrain.peakTorqueNm,
    torqueAtPeakPower,
    torqueAtRedline,
  ];
  const torque = interpolate(xs, ys, rpm);
  return Math.min(torque, powertrain.peakPowerW / omega);
}

export function icePower(powertrain: IcePowertrain, rpm: number): number {
  return iceTorque(powertrain, rpm) * rpm * RPM_TO_RAD;
}

export interface WheelForce {
  /** Drive force at the tyre contact patches, N (before any traction limit). */
  force: number;
  /** 1-based gear number (always 1 for an EV); 0 when no gear can be used. */
  gear: number;
  /** Engine / motor speed, rpm. */
  rpm: number;
}

/** Engine speed in a given gear at a road speed. */
export function engineRpm(powertrain: IcePowertrain, gearIndex: number, speed: number, wheelRadius: number): number {
  return ((speed / wheelRadius) * powertrain.gearRatios[gearIndex] * powertrain.finalDrive) / RPM_TO_RAD;
}

/** Wheel force of an ICE powertrain in one specific gear (0 if the gear cannot be used). */
export function iceWheelForceInGear(
  powertrain: IcePowertrain,
  gearIndex: number,
  speed: number,
  wheelRadius: number,
): WheelForce {
  const overall = powertrain.gearRatios[gearIndex] * powertrain.finalDrive;
  const rpm = engineRpm(powertrain, gearIndex, speed, wheelRadius);
  if (rpm > powertrain.redlineRpm) return { force: 0, gear: gearIndex + 1, rpm };
  let effectiveRpm = rpm;
  if (gearIndex === 0) {
    // Launch: the clutch slips so the engine can sit near its torque peak.
    const launchRpm = Math.max(
      powertrain.idleRpm,
      Math.min(powertrain.peakTorqueRpm, V.launchRpmCapFraction * powertrain.redlineRpm),
    );
    effectiveRpm = Math.max(rpm, launchRpm);
  } else if (rpm < powertrain.idleRpm) {
    return { force: 0, gear: gearIndex + 1, rpm };
  }
  const force =
    (iceTorque(powertrain, effectiveRpm) * overall * powertrain.drivetrainEfficiency) / wheelRadius;
  return { force, gear: gearIndex + 1, rpm: effectiveRpm };
}

function evWheelForce(powertrain: EvPowertrain, speed: number, wheelRadius: number): WheelForce {
  const rpm = ((speed / wheelRadius) * powertrain.gearRatio) / RPM_TO_RAD;
  if (rpm > powertrain.maxMotorRpm) return { force: 0, gear: 1, rpm };
  // Constant torque up to base speed, then constant power.
  const torqueLimited =
    (powertrain.peakTorqueNm * powertrain.gearRatio * powertrain.drivetrainEfficiency) / wheelRadius;
  const powerLimited = (powertrain.peakPowerW * powertrain.drivetrainEfficiency) / Math.max(speed, 0.1);
  return { force: Math.min(torqueLimited, powerLimited), gear: 1, rpm };
}

/** Best available wheel force at a road speed (ideal gear selection for an ICE). */
export function wheelForce(powertrain: Powertrain, speed: number, wheelRadius: number): WheelForce {
  if (powertrain.type === "EV") return evWheelForce(powertrain, speed, wheelRadius);
  let best: WheelForce = { force: 0, gear: 0, rpm: 0 };
  for (let i = 0; i < powertrain.gearRatios.length; i++) {
    const candidate = iceWheelForceInGear(powertrain, i, speed, wheelRadius);
    if (candidate.force > best.force) best = candidate;
  }
  return best;
}

/** Rotational-inertia factor: effective mass = mass x factor. */
export function inertiaFactor(powertrain: Powertrain, gear: number): number {
  if (powertrain.type === "EV") return 1 + V.evInertia;
  const index = Math.min(Math.max(gear - 1, 0), powertrain.gearRatios.length - 1);
  const overall = powertrain.gearRatios[index] * powertrain.finalDrive;
  return 1 + V.inertiaBase + V.inertiaGear * overall * overall;
}

/** Highest road speed permitted by the rev limit, m/s. */
export function revLimitedSpeed(powertrain: Powertrain, wheelRadius: number): number {
  if (powertrain.type === "EV") {
    return ((powertrain.maxMotorRpm * RPM_TO_RAD) / powertrain.gearRatio) * wheelRadius;
  }
  const tallest = Math.min(...powertrain.gearRatios) * powertrain.finalDrive;
  return ((powertrain.redlineRpm * RPM_TO_RAD) / tallest) * wheelRadius;
}

/** Samples the engine / motor output for plotting: power and torque vs shaft speed. */
export function powertrainCurve(powertrain: Powertrain, samples = 60): { rpm: number; powerW: number; torqueNm: number }[] {
  const curve: { rpm: number; powerW: number; torqueNm: number }[] = [];
  if (powertrain.type === "EV") {
    for (let i = 1; i <= samples; i++) {
      const rpm = (powertrain.maxMotorRpm * i) / samples;
      const omega = rpm * RPM_TO_RAD;
      const torqueNm = Math.min(powertrain.peakTorqueNm, powertrain.peakPowerW / omega);
      curve.push({ rpm, powerW: torqueNm * omega, torqueNm });
    }
    return curve;
  }
  for (let i = 0; i <= samples; i++) {
    const rpm = powertrain.idleRpm + ((powertrain.redlineRpm - powertrain.idleRpm) * i) / samples;
    const torqueNm = iceTorque(powertrain, rpm);
    curve.push({ rpm, powerW: torqueNm * rpm * RPM_TO_RAD, torqueNm });
  }
  return curve;
}
