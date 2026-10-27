import type { GeometryParams, SimWarning } from "@/lib/types";
import { completeGeometry, PARAM_BY_ID, PARAM_IDS } from "@/lib/geometry/parameters";
import { MODEL } from "@/lib/physics/model";
import { buildBodyShape } from "@/lib/geometry/profile";

/**
 * Checks that a parameter set describes a buildable body.
 * Errors (severity "error") make the geometry invalid: the simulation must not run.
 * backend/geometry/validate.py mirrors these rules.
 */
export function validateGeometry(geometry: GeometryParams): SimWarning[] {
  const params = completeGeometry(geometry);
  const issues: SimWarning[] = [];
  const error = (code: string, message: string) => issues.push({ code, severity: "error", message });

  for (const id of PARAM_IDS) {
    const value = params[id];
    const definition = PARAM_BY_ID[id];
    if (!Number.isFinite(value)) {
      error("PARAM_NOT_FINITE", `${definition.label} is not a finite number.`);
    } else if (value < definition.min - 1e-9 || value > definition.max + 1e-9) {
      error(
        "PARAM_OUT_OF_RANGE",
        `${definition.label} = ${value} is outside its allowed range ${definition.min} to ${definition.max}.`,
      );
    }
  }
  if (issues.length > 0) return issues;

  const shape = buildBodyShape(params);
  const roofLength = shape.xRoofEnd - shape.xRoofStart;
  const radius = params.wheelDiameter / 2;

  if (shape.roofEdgeHeight < params.hoodHeight + 0.15) {
    error("ROOF_BELOW_COWL", "Roof height must be at least 0.18 m above the hood (cowl) height.");
  }
  if (shape.roofEdgeHeight < params.rearBumperHeight + 0.02) {
    error("TAIL_ABOVE_ROOF", "Rear bumper (tail) height must be below the roof.");
  }
  if (params.hoodHeight < params.frontBumperHeight - 0.2) {
    error("HOOD_BELOW_NOSE", "Hood (cowl) height is more than 0.2 m below the nose height.");
  }
  if (roofLength < MODEL.profile.minRoofLength) {
    error(
      "ROOF_TOO_SHORT",
      `Windshield, rear window, hood and deck leave only ${roofLength.toFixed(2)} m for the roof (minimum ${MODEL.profile.minRoofLength} m). ` +
        "Shorten the hood or deck, steepen the windows, or lengthen the wheelbase.",
    );
  }
  if (radius <= params.rideHeight + 0.03) {
    error("WHEEL_TOO_SMALL", "Wheel radius must exceed the ride height so the wheels reach into the body.");
  }
  if (params.wheelDiameter > params.rideHeight + params.beltHeight + 0.1) {
    error("WHEEL_TOO_LARGE", "Wheel diameter is larger than the lower body can enclose.");
  }
  if (params.frontOverhang < radius + 0.08) {
    error("FRONT_OVERHANG_TOO_SHORT", "Front overhang is too short for the wheel diameter.");
  }
  if (params.rearOverhang < radius + 0.05) {
    error("REAR_OVERHANG_TOO_SHORT", "Rear overhang is too short for the wheel diameter.");
  }
  if (params.wheelbase < params.wheelDiameter + 0.4) {
    error("WHEELBASE_TOO_SHORT", "Wheelbase is too short for the wheel diameter.");
  }
  if (params.rideHeight - params.sideSkirtDepth < 0.01) {
    error("SKIRT_TOUCHES_GROUND", "Side skirts reach the ground at this ride height.");
  }
  if (params.tireWidth * 2 > params.width * 0.6) {
    error("TIRES_TOO_WIDE", "Tyres are too wide for the body width.");
  }
  return issues;
}

export function isGeometryValid(params: GeometryParams): boolean {
  return validateGeometry(params).every((issue) => issue.severity !== "error");
}
