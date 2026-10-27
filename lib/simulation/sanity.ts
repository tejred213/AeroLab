/**
 * Sanity checks: warnings for physically suspicious configurations or results.
 * These never alter the numbers; they tell the user when to distrust them.
 * backend/simulation/sanity.py mirrors this file.
 */
import type { GeometryMetrics, GeometryParams, RearFlowState, SimWarning } from "@/lib/types";
import { MODEL } from "@/lib/physics/model";

export const EXPECTED_CD_RANGE: [number, number] = [0.15, 0.6];
export const EXPECTED_CL_RANGE: [number, number] = [-1.0, 0.6];
const SPEED_OF_SOUND = 340;

export interface SanityInput {
  geometry: GeometryParams;
  metrics: GeometryMetrics;
  rearFlow: RearFlowState;
  cd: number;
  cl: number;
  referenceCd: number;
  relativeSpeed: number;
  yawAngleDeg: number;
}

export function sanityWarnings(input: SanityInput): SimWarning[] {
  const { geometry, metrics, rearFlow, cd, cl } = input;
  const warnings: SimWarning[] = [];
  const warn = (code: string, message: string) => warnings.push({ code, severity: "warning", message });
  const info = (code: string, message: string) => warnings.push({ code, severity: "info", message });

  if (metrics.frontalArea < 1.5) {
    warn("FRONTAL_AREA_SMALL", `Frontal area is unusually small (${metrics.frontalArea.toFixed(2)} m^2).`);
  } else if (metrics.frontalArea > 3.6) {
    warn("FRONTAL_AREA_LARGE", `Frontal area is unusually large (${metrics.frontalArea.toFixed(2)} m^2).`);
  }
  if (metrics.groundClearance < geometry.minGroundClearance) {
    warn(
      "CLEARANCE_BELOW_LIMIT",
      `Ride height is below the configured minimum: lowest point ${(metrics.groundClearance * 1000).toFixed(0)} mm, ` +
        `limit ${(geometry.minGroundClearance * 1000).toFixed(0)} mm.`,
    );
  }
  if (cd < EXPECTED_CD_RANGE[0] || cd > EXPECTED_CD_RANGE[1]) {
    warn(
      "CD_OUT_OF_RANGE",
      `Predicted Cd (${cd.toFixed(3)}) is outside the expected range for a road car ` +
        `(${EXPECTED_CD_RANGE[0]} to ${EXPECTED_CD_RANGE[1]}).`,
    );
  }
  if (cl < EXPECTED_CL_RANGE[0] || cl > EXPECTED_CL_RANGE[1]) {
    warn("CL_OUT_OF_RANGE", `Predicted Cl (${cl.toFixed(3)}) is outside the expected range for a road car.`);
  }
  if (Math.abs(cd - input.referenceCd) > 0.35 * input.referenceCd) {
    warn(
      "FAR_FROM_REFERENCE",
      "The geometry is far from the class reference shape; the model is extrapolating and the uncertainty is large.",
    );
  }
  if (rearFlow.separationFraction > 0.08 && rearFlow.separationFraction < 0.92) {
    warn(
      "CRITICAL_REAR_SLOPE",
      `Effective rear slope (${rearFlow.effectiveSlantDeg.toFixed(1)} deg) is near the critical angle. ` +
        "Real flows switch abruptly between attached and separated states here; results are especially uncertain.",
    );
  }
  if (geometry.diffuserLength > 0.05 && geometry.diffuserAngle > 14) {
    warn("DIFFUSER_STALL", "Diffuser angle exceeds about 14 deg; the diffuser flow is likely separated.");
  }
  if (geometry.wingChord > 1e-4 && geometry.wingAngle > MODEL.wing.stallOnsetDeg) {
    warn("WING_STALL", "Rear wing angle is beyond the stall onset; downforce saturates while drag rises steeply.");
  }
  if (Math.abs(input.yawAngleDeg) > 20) {
    warn("YAW_LARGE", "Aerodynamic yaw angle exceeds 20 deg; the crosswind correlations are outside their intended range.");
  }
  if (input.relativeSpeed / SPEED_OF_SOUND > 0.3) {
    warn("COMPRESSIBILITY", "Relative air speed exceeds Mach 0.3; compressibility is not modelled.");
  }
  if (input.relativeSpeed < 5) {
    info("LOW_SPEED", "Relative air speed is very low; forces are small and Reynolds-number effects are not well represented.");
  }
  return warnings;
}
