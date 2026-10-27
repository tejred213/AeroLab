"""Rear-end flow closure shared by Mode A and Mode B (mirror of lib/physics/rearFlow.ts).

For effective slants below about 30 deg the flow stays attached and trailing
vortices add drag; above it the flow separates at the roof trailing edge. The
real transition is abrupt and can be bistable; it is represented by a smooth blend.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

from geometry.metrics import effective_slant_deg
from geometry.profile import BodyShape, plan_half_width, spoiler_geometry
from physics.model import MODEL

R = MODEL["rearFlow"]


@dataclass(frozen=True)
class RearFlow:
    separation_fraction: float
    effective_slant_deg: float
    separation_x: float
    base_area: float
    base_pressure_coefficient: float
    wake_length: float
    vortex_drag: float
    tail_area: float
    slant_area: float
    slant_plan_area: float
    base_height: float
    bubble_fraction: float
    slant_separated: float

    def with_base_pressure(self, value: float) -> "RearFlow":
        return replace(self, base_pressure_coefficient=value)

    def to_json(self) -> dict[str, float]:
        return {
            "separationFraction": self.separation_fraction,
            "effectiveSlantDeg": self.effective_slant_deg,
            "separationX": self.separation_x,
            "baseArea": self.base_area,
            "basePressureCoefficient": self.base_pressure_coefficient,
            "wakeLength": self.wake_length,
            "vortexDrag": self.vortex_drag,
        }


def _logistic(value: float) -> float:
    return 1.0 / (1.0 + math.exp(-value))


def compute_rear_flow(shape: BodyShape, frontal_area: float) -> RearFlow:
    params, length = shape.params, shape.length
    tail_width = 2 * float(plan_half_width(shape, length))
    roof_width = tail_width * (1 + params["cabinWidthRatio"]) / 2
    slant_height = max(shape.roof_edge_height - shape.deck_height, 0.0)
    tail_face_height = max(shape.tail_height - shape.diffuser_exit_height, 0.0)

    tail_area = R["baseShapeFactor"] * tail_width * tail_face_height
    slant_area = roof_width * slant_height
    slant_plan_area = roof_width * max(shape.x_deck_start - shape.x_roof_end, 0.0)

    slant = effective_slant_deg(shape)
    separation = _logistic((slant - R["separationCenterDeg"]) / R["separationWidthDeg"])

    # A locally steep rear window separates at the roof edge even when the deck lets the
    # flow re-attach (effective slope still shallow): a closed bubble sits on the window.
    local = _logistic((params["rearWindowAngle"] - R["separationCenterDeg"]) / R["separationWidthDeg"])
    bubble = (1 - separation) * local
    slant_separated = separation + bubble

    base_area = tail_area + slant_separated * slant_area
    base_pressure = (R["cpBaseAttached"] + (R["cpBaseSeparated"] - R["cpBaseAttached"]) * separation) * (
        1 - R["boatTailRelief"] * params["rearTaper"]
    )

    onset = min(max((slant - R["vortexOnsetDeg"]) / (R["separationCenterDeg"] - R["vortexOnsetDeg"]), 0.0), 1.2)
    vortex_drag = R["vortexDragCoefficient"] * (slant_area / frontal_area) * (1 - slant_separated) * onset**1.5

    spoiler = spoiler_geometry(shape)
    base_height = (
        tail_face_height + separation * slant_height + (1 - separation) * (spoiler.rise if spoiler.present else 0.0)
    )

    return RearFlow(
        separation_fraction=separation,
        effective_slant_deg=slant,
        separation_x=length - separation * (length - shape.x_roof_end),
        base_area=base_area,
        base_pressure_coefficient=base_pressure,
        wake_length=R["wakeLengthFactor"] * base_height,
        vortex_drag=vortex_drag,
        tail_area=tail_area,
        slant_area=slant_area,
        slant_plan_area=slant_plan_area,
        base_height=base_height,
        bubble_fraction=bubble,
        slant_separated=slant_separated,
    )
