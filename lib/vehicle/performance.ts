/**
 * Longitudinal vehicle-performance model: resistances, traction limit,
 * acceleration, top speed and power demand.
 *
 * The aerodynamic coefficients are an input; this module is independent of how
 * they were obtained (analytical, reduced-order, CFD or surrogate).
 *
 * backend/vehicle/performance.py mirrors this file.
 */
import type {
  AccelSample,
  AeroCoefficients,
  PerformanceResult,
  Powertrain,
  SpeedSample,
  TopSpeedLimit,
  VehicleSpec,
} from "@/lib/types";
import { DEG_TO_RAD, GRAVITY, MODEL, RAD_TO_DEG } from "@/lib/physics/model";
import { coefficientForce, dynamicPressure, gradeForce, rollingResistanceFromLoad } from "@/lib/physics/forces";
import { iceWheelForceInGear, inertiaFactor, wheelForce } from "@/lib/vehicle/powertrain";

const V = MODEL.vehicleModel;

export const ACCEL_TARGETS_KMH = [60, 100, 160, 200];
const KMH = 1 / 3.6;

export interface PerformanceInput {
  vehicle: VehicleSpec;
  powertrain: Powertrain;
  wheelRadius: number;
  wheelbase: number;
  aero: Pick<
    AeroCoefficients,
    "cd" | "cl" | "clFront" | "clRear" | "cdFriction" | "referenceSpeed" | "frontalArea"
  >;
  airDensity: number;
  /** Road gradient, deg (positive uphill). */
  gradientDeg: number;
  /** Headwind component of the ambient wind, m/s (negative = tailwind). */
  headwind: number;
  /** Speed at which the headline force breakdown is reported, m/s. */
  testSpeed: number;
}

/**
 * Drag coefficient at another air speed. Only the skin-friction part of Cd is
 * Reynolds dependent (Cf ~ Re^-0.2); the pressure part is held constant.
 */
export function cdAtSpeed(aero: PerformanceInput["aero"], airSpeed: number): number {
  const ratio = Math.max(Math.abs(airSpeed), 2) / Math.max(aero.referenceSpeed, 2);
  return aero.cd - aero.cdFriction + aero.cdFriction * Math.pow(ratio, MODEL.drag.frictionExponent);
}

export interface Resistances {
  drag: number;
  lift: number;
  liftFront: number;
  liftRear: number;
  rolling: number;
  grade: number;
  /** Ftotal = Fdrag + Frolling + Fgrade */
  total: number;
  cd: number;
}

export function resistances(input: PerformanceInput, speed: number, gradientDeg = input.gradientDeg): Resistances {
  const { vehicle, aero } = input;
  const airSpeed = speed + input.headwind;
  const q = dynamicPressure(input.airDensity, airSpeed);
  const cd = cdAtSpeed(aero, airSpeed);
  // A tailwind faster than the car pushes it forward: drag changes sign with the relative flow.
  const drag = Math.sign(airSpeed) * coefficientForce(q, cd, aero.frontalArea);
  const liftFront = coefficientForce(q, aero.clFront, aero.frontalArea);
  const liftRear = coefficientForce(q, aero.clRear, aero.frontalArea);
  const lift = liftFront + liftRear;
  const normal = Math.max(vehicle.mass * GRAVITY * Math.cos(gradientDeg * DEG_TO_RAD) - lift, 0);
  const rolling = rollingResistanceFromLoad(vehicle.crr, normal);
  const grade = gradeForce(vehicle.mass, gradientDeg);
  return { drag, lift, liftFront, liftRear, rolling, grade, total: drag + rolling + grade, cd };
}

/**
 * Largest drive force the driven tyres can transmit, including static weight
 * distribution, the grade, aerodynamic lift per axle and the longitudinal load
 * transfer caused by the acceleration itself (solved in closed form).
 */
export function tractionLimit(
  input: PerformanceInput,
  res: Resistances,
  inertia: number,
  gradientDeg = input.gradientDeg,
): number {
  const { vehicle } = input;
  const theta = gradientDeg * DEG_TO_RAD;
  const weight = vehicle.mass * GRAVITY;
  const heightRatio = vehicle.cgHeight / input.wheelbase;
  const front =
    weight * (vehicle.weightDistFront * Math.cos(theta) - heightRatio * Math.sin(theta)) - res.liftFront;
  const rear =
    weight * ((1 - vehicle.weightDistFront) * Math.cos(theta) + heightRatio * Math.sin(theta)) - res.liftRear;
  const mu = vehicle.tireMu;
  // Load transfer = m a h / L with a = (F - R) / (m k)  ->  (h / (L k)) (F - R)
  const transfer = heightRatio / inertia;
  let limit: number;
  if (vehicle.drivetrain === "RWD") {
    limit = (mu * (rear - transfer * res.total)) / Math.max(1 - mu * transfer, 0.05);
  } else if (vehicle.drivetrain === "FWD") {
    limit = (mu * (front + transfer * res.total)) / (1 + mu * transfer);
  } else {
    limit = mu * (front + rear);
  }
  return Math.max(limit, 0);
}

interface Available {
  force: number;
  drive: number;
  tractionLimited: boolean;
  gear: number;
  res: Resistances;
}

/** Usable drive force at a steady speed with ideal gear selection. */
function availableForce(input: PerformanceInput, speed: number, gradientDeg = input.gradientDeg): Available {
  const res = resistances(input, speed, gradientDeg);
  const drive = wheelForce(input.powertrain, speed, input.wheelRadius);
  const limit = tractionLimit(input, res, inertiaFactor(input.powertrain, drive.gear), gradientDeg);
  return {
    force: Math.min(drive.force, limit),
    drive: drive.force,
    tractionLimited: drive.force > limit,
    gear: drive.gear,
    res,
  };
}

/** Top speed: the first speed, approached from rest, where net longitudinal force reaches zero. */
export function solveTopSpeed(input: PerformanceInput): { topSpeed: number; limit: TopSpeedLimit } {
  const net = (speed: number) => {
    const available = availableForce(input, speed);
    return available.force - available.res.total;
  };
  const step = 0.5;
  if (net(1) <= 0) return { topSpeed: 0, limit: "power" };
  let low = 1;
  let high = -1;
  for (let speed = 1 + step; speed <= V.maxSpeed; speed += step) {
    if (net(speed) <= 0) {
      high = speed;
      break;
    }
    low = speed;
  }
  if (high < 0) return { topSpeed: V.maxSpeed, limit: "none" };
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (low + high);
    if (net(mid) > 0) low = mid;
    else high = mid;
  }
  const topSpeed = 0.5 * (low + high);
  const beyond = wheelForce(input.powertrain, topSpeed + 0.2, input.wheelRadius);
  const limit: TopSpeedLimit =
    beyond.force <= 0 ? (input.powertrain.type === "EV" ? "motor-rpm" : "redline") : "power";
  return { topSpeed, limit };
}

interface AccelerationRun {
  trace: AccelSample[];
  times: { target: number; time: number | null }[];
  tractionLimited: boolean;
}

/** Full-throttle acceleration from rest, integrated with a fixed time step. */
export function simulateAcceleration(input: PerformanceInput): AccelerationRun {
  const { powertrain, vehicle } = input;
  const dt = V.timeStep;
  const targets = ACCEL_TARGETS_KMH.map((kmh) => kmh * KMH);
  const times: (number | null)[] = targets.map(() => null);
  const trace: AccelSample[] = [];
  const maxTarget = targets[targets.length - 1];

  let time = 0;
  let speed = 0;
  let distance = 0;
  let gear = 1;
  let shiftRemaining = 0;
  let tractionLimited = false;
  let nextSample = 0;
  const sampleInterval = 0.1;

  while (time < V.maxTime) {
    const res = resistances(input, speed);
    let drive = 0;
    // True while drive is interrupted by a gear change (this step included).
    let shifting = false;
    if (powertrain.type === "EV") {
      drive = wheelForce(powertrain, speed, input.wheelRadius).force;
    } else if (shiftRemaining > 0) {
      shiftRemaining -= dt;
      shifting = true;
    } else {
      const current = iceWheelForceInGear(powertrain, gear - 1, speed, input.wheelRadius);
      const hasNext = gear < powertrain.gearRatios.length;
      const next = hasNext ? iceWheelForceInGear(powertrain, gear, speed, input.wheelRadius) : null;
      if (next && (current.force <= 0 || next.force > current.force)) {
        gear += 1;
        shiftRemaining = powertrain.shiftTime;
        shifting = true;
      } else {
        drive = current.force;
      }
    }

    const inertia = inertiaFactor(powertrain, gear);
    const limit = tractionLimit(input, res, inertia);
    const limited = drive > limit;
    if (limited) tractionLimited = true;
    const acceleration = (Math.min(drive, limit) - res.total) / (vehicle.mass * inertia);

    if (time >= nextSample - 1e-9) {
      trace.push({ time, speed, acceleration, distance, gear, tractionLimited: limited });
      nextSample += sampleInterval;
    }

    if (speed <= 0 && acceleration <= 0 && !shifting) break;
    const newSpeed = Math.max(speed + acceleration * dt, 0);
    for (let i = 0; i < targets.length; i++) {
      if (times[i] === null && speed < targets[i] && newSpeed >= targets[i]) {
        times[i] = time + (dt * (targets[i] - speed)) / (newSpeed - speed);
      }
    }
    distance += 0.5 * (speed + newSpeed) * dt;
    speed = newSpeed;
    time += dt;

    if (speed >= maxTarget * 1.03) break;
    // Converged on top speed (not mid-shift).
    if (!shifting && time > 1 && acceleration < 0.004) break;
  }
  trace.push({
    time,
    speed,
    acceleration: trace.length > 0 ? trace[trace.length - 1].acceleration : 0,
    distance,
    gear,
    tractionLimited: false,
  });
  return {
    trace,
    times: ACCEL_TARGETS_KMH.map((target, i) => ({ target, time: times[i] })),
    tractionLimited,
  };
}

/** Forces and power as a function of steady speed. */
export function speedSweep(input: PerformanceInput, maxSpeed: number, samples = 80): SpeedSample[] {
  const sweep: SpeedSample[] = [];
  for (let i = 0; i <= samples; i++) {
    const speed = (maxSpeed * i) / samples;
    const available = availableForce(input, speed);
    const { res } = available;
    sweep.push({
      speed,
      drag: res.drag,
      downforce: -res.lift,
      rolling: res.rolling,
      grade: res.grade,
      cd: res.cd,
      powerRequired: res.total * speed,
      powerAero: res.drag * speed,
      powerRolling: res.rolling * speed,
      powerGrade: res.grade * speed,
      powerAvailable: available.drive * speed,
      tractionForce: available.force,
    });
  }
  return sweep;
}

/** Steepest gradient that can be held at the reference speed (30 km/h), deg. */
export function maxGrade(input: PerformanceInput): number {
  const speed = V.gradeReferenceSpeed;
  const net = (gradientDeg: number) => {
    const available = availableForce(input, speed, gradientDeg);
    return available.force - available.res.total;
  };
  let low = 0;
  let high = 45;
  if (net(low) <= 0) return 0;
  if (net(high) > 0) return high;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (low + high);
    if (net(mid) > 0) low = mid;
    else high = mid;
  }
  return 0.5 * (low + high);
}

export const PERFORMANCE_ASSUMPTIONS = [
  "Straight-line motion on a uniform gradient; rigid body, no suspension travel or pitch.",
  "Aerodynamic coefficients are constant with speed except for the Reynolds dependence of skin friction.",
  "Only the headwind component of ambient wind enters the performance calculation.",
  "Tyres: constant friction coefficient and constant rolling-resistance coefficient; rolling radius = half the wheel diameter.",
  "Rolling resistance acts on the tyre normal load N = m g cos(theta) - lift (equals Crr m g on a level road with no lift).",
  "Traction limit includes static weight distribution, grade, per-axle aerodynamic lift and acceleration load transfer.",
  "Simplified torque curve (or the user-defined power curve), constant drivetrain efficiency, ideal shift points.",
  "ICE gear changes interrupt drive for the configured shift time; launch holds the engine near its torque peak.",
  "Rotating inertia is lumped into an effective-mass factor that depends on the overall gear ratio.",
];

export function computePerformance(input: PerformanceInput): PerformanceResult {
  const top = solveTopSpeed(input);
  const accel = simulateAcceleration(input);
  const sweepMax = Math.min(Math.max(top.topSpeed * 1.08, 70), V.maxSpeed);
  const at = resistances(input, input.testSpeed);

  let rangeAt100: number | null = null;
  if (input.powertrain.type === "EV") {
    const cruise = resistances(input, 100 * KMH);
    rangeAt100 =
      cruise.total > 0
        ? (input.powertrain.batteryCapacityJ * input.powertrain.drivetrainEfficiency) / cruise.total
        : null;
  }

  return {
    topSpeed: top.topSpeed,
    topSpeedLimit: top.limit,
    accelTimes: accel.times,
    accelTrace: accel.trace,
    speedSweep: speedSweep(input, sweepMax),
    tractionLimited: accel.tractionLimited,
    maxGradeDeg: maxGrade(input),
    forcesAtSpeed: {
      speed: input.testSpeed,
      drag: at.drag,
      rolling: at.rolling,
      grade: at.grade,
      total: at.total,
      powerRequired: at.total * input.testSpeed,
    },
    rangeAt100,
    assumptions: PERFORMANCE_ASSUMPTIONS,
  };
}

/** Convenience: gradient in percent for display. */
export function gradientPercent(gradientDeg: number): number {
  return Math.tan(gradientDeg * DEG_TO_RAD) * 100;
}

export function gradientFromPercent(percent: number): number {
  return Math.atan(percent / 100) * RAD_TO_DEG;
}
