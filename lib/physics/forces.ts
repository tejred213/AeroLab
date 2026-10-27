/**
 * Fundamental force and power relations. These are the only definitions of
 * these equations in the frontend; every model and chart goes through them.
 * backend/physics/forces.py mirrors this file.
 */
import { DEG_TO_RAD, GRAVITY } from "@/lib/physics/model";

/** q = 1/2 rho V^2  [Pa] */
export function dynamicPressure(density: number, speed: number): number {
  return 0.5 * density * speed * speed;
}

/** Fd = 1/2 rho V^2 Cd A  [N] */
export function dragForce(density: number, speed: number, cd: number, area: number): number {
  return dynamicPressure(density, speed) * cd * area;
}

/** Fl = 1/2 rho V^2 Cl A  [N]. Positive = upward; negative Cl means downforce. */
export function liftForce(density: number, speed: number, cl: number, area: number): number {
  return dynamicPressure(density, speed) * cl * area;
}

/** Generic aerodynamic force from a coefficient: F = q C A  [N] */
export function coefficientForce(q: number, coefficient: number, area: number): number {
  return q * coefficient * area;
}

/** Frr = Crr m g  [N] — rolling resistance on a level road with no aerodynamic load. */
export function rollingResistance(crr: number, mass: number, gravity: number = GRAVITY): number {
  return crr * mass * gravity;
}

/**
 * Rolling resistance for an arbitrary normal load: Frr = Crr N.
 * Reduces to Crr m g when N = m g (level road, no lift).
 */
export function rollingResistanceFromLoad(crr: number, normalLoad: number): number {
  return crr * Math.max(normalLoad, 0);
}

/** Total tyre normal load on a grade with aerodynamic lift: N = m g cos(theta) - Fl. */
export function normalLoad(mass: number, gradientDeg: number, lift: number, gravity: number = GRAVITY): number {
  return Math.max(mass * gravity * Math.cos(gradientDeg * DEG_TO_RAD) - lift, 0);
}

/** Fgrade = m g sin(theta)  [N]. Positive theta = uphill (resists motion). */
export function gradeForce(mass: number, gradientDeg: number, gravity: number = GRAVITY): number {
  return mass * gravity * Math.sin(gradientDeg * DEG_TO_RAD);
}

/** P = F V  [W] */
export function power(force: number, speed: number): number {
  return force * speed;
}
