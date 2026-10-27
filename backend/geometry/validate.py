"""Geometry validity rules (mirror of lib/geometry/validate.ts)."""

from __future__ import annotations

import math

from geometry.parameters import PARAM_BY_ID, PARAM_IDS, Geometry, complete_geometry
from geometry.profile import build_body_shape
from physics.model import MODEL


def validate_geometry(params: Geometry) -> list[dict[str, str]]:
    """Returns a list of issues; severity "error" makes the geometry invalid."""
    params = complete_geometry(params)
    issues: list[dict[str, str]] = []

    def error(code: str, message: str) -> None:
        issues.append({"code": code, "severity": "error", "message": message})

    for param in PARAM_IDS:
        definition = PARAM_BY_ID[param]
        value = params.get(param)
        if value is None or not math.isfinite(value):
            error("PARAM_NOT_FINITE", f"{definition['label']} is not a finite number.")
        elif value < definition["min"] - 1e-9 or value > definition["max"] + 1e-9:
            error(
                "PARAM_OUT_OF_RANGE",
                f"{definition['label']} = {value} is outside its allowed range {definition['min']} to {definition['max']}.",
            )
    if issues:
        return issues

    shape = build_body_shape(params)
    roof_length = shape.x_roof_end - shape.x_roof_start
    radius = params["wheelDiameter"] / 2
    min_roof = MODEL["profile"]["minRoofLength"]

    if shape.roof_edge_height < params["hoodHeight"] + 0.15:
        error("ROOF_BELOW_COWL", "Roof height must be at least 0.18 m above the hood (cowl) height.")
    if shape.roof_edge_height < params["rearBumperHeight"] + 0.02:
        error("TAIL_ABOVE_ROOF", "Rear bumper (tail) height must be below the roof.")
    if params["hoodHeight"] < params["frontBumperHeight"] - 0.2:
        error("HOOD_BELOW_NOSE", "Hood (cowl) height is more than 0.2 m below the nose height.")
    if roof_length < min_roof:
        error(
            "ROOF_TOO_SHORT",
            f"Windshield, rear window, hood and deck leave only {roof_length:.2f} m for the roof (minimum {min_roof} m). "
            "Shorten the hood or deck, steepen the windows, or lengthen the wheelbase.",
        )
    if radius <= params["rideHeight"] + 0.03:
        error("WHEEL_TOO_SMALL", "Wheel radius must exceed the ride height so the wheels reach into the body.")
    if params["wheelDiameter"] > params["rideHeight"] + params["beltHeight"] + 0.1:
        error("WHEEL_TOO_LARGE", "Wheel diameter is larger than the lower body can enclose.")
    if params["frontOverhang"] < radius + 0.08:
        error("FRONT_OVERHANG_TOO_SHORT", "Front overhang is too short for the wheel diameter.")
    if params["rearOverhang"] < radius + 0.05:
        error("REAR_OVERHANG_TOO_SHORT", "Rear overhang is too short for the wheel diameter.")
    if params["wheelbase"] < params["wheelDiameter"] + 0.4:
        error("WHEELBASE_TOO_SHORT", "Wheelbase is too short for the wheel diameter.")
    if params["rideHeight"] - params["sideSkirtDepth"] < 0.01:
        error("SKIRT_TOUCHES_GROUND", "Side skirts reach the ground at this ride height.")
    if params["tireWidth"] * 2 > params["width"] * 0.6:
        error("TIRES_TOO_WIDE", "Tyres are too wide for the body width.")
    return issues


def is_geometry_valid(params: Geometry) -> bool:
    return all(issue["severity"] != "error" for issue in validate_geometry(params))
