"""Geometry parameter definitions, loaded from shared/parameters.json."""

from __future__ import annotations

import math
from typing import Any

from physics.model import PARAMETER_DATA

Geometry = dict[str, float]

PARAM_DEFINITIONS: list[dict[str, Any]] = PARAMETER_DATA["parameters"]
PARAM_BY_ID: dict[str, dict[str, Any]] = {definition["id"]: definition for definition in PARAM_DEFINITIONS}
PARAM_IDS: list[str] = [definition["id"] for definition in PARAM_DEFINITIONS]


# Parameters added after the first release, with the value a geometry stored before them is given.
LATER_PARAMS: list[tuple[str, float]] = [
    (definition["id"], definition["default"]) for definition in PARAM_DEFINITIONS if "default" in definition
]


def complete_geometry(geometry: Geometry) -> Geometry:
    """A geometry with every parameter present (mirrors completeGeometry in lib/geometry/parameters.ts).

    Vehicles and requests written for an older version lack the parameters added since; they get the
    documented default. Returns the same object when nothing is missing.
    """
    complete = geometry
    for param, value in LATER_PARAMS:
        current = complete.get(param)
        if current is None or not math.isfinite(current):
            if complete is geometry:
                complete = dict(geometry)
            complete[param] = value
    return complete


def clamp_param(param: str, value: float) -> float:
    definition = PARAM_BY_ID[param]
    if not math.isfinite(value):
        return definition["min"]
    return min(definition["max"], max(definition["min"], value))


def overall_length(geometry: Geometry) -> float:
    """Overall length is a linked quantity: front overhang + wheelbase + rear overhang."""
    return geometry["frontOverhang"] + geometry["wheelbase"] + geometry["rearOverhang"]
