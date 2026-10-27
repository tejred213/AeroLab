"""Integral properties of the generated geometry (mirror of lib/geometry/metrics.ts)."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

from geometry.profile import (
    BodyShape,
    lower_z,
    plan_half_width,
    section_half_width,
    mirror_geometry,
    skirt_geometry,
    splitter_geometry,
    spoiler_geometry,
    upper_z,
    wheel_geometry,
    wing_geometry,
)
from physics.model import DEG_TO_RAD, MODEL, RAD_TO_DEG

STATION_COUNT = 96
ROW_HEIGHT = 0.004


@dataclass(frozen=True)
class GeometryMetrics:
    length: float
    overall_height: float
    frontal_area: float
    side_area: float
    side_area_centroid_x: float
    wetted_area: float
    ground_clearance: float
    roof_length: float
    track_width: float
    effective_slant_deg: float

    def to_json(self) -> dict[str, float]:
        data = asdict(self)
        return {
            "length": data["length"],
            "overallHeight": data["overall_height"],
            "frontalArea": data["frontal_area"],
            "sideArea": data["side_area"],
            "sideAreaCentroidX": data["side_area_centroid_x"],
            "wettedArea": data["wetted_area"],
            "groundClearance": data["ground_clearance"],
            "roofLength": data["roof_length"],
            "trackWidth": data["track_width"],
            "effectiveSlantDeg": data["effective_slant_deg"],
        }


def _union_length(intervals: list[tuple[float, float]]) -> float:
    """Total length of the union of [start, end] intervals."""
    if not intervals:
        return 0.0
    intervals.sort(key=lambda interval: interval[0])
    total = 0.0
    current_start, current_end = intervals[0]
    for start, end in intervals[1:]:
        if start > current_end:
            total += current_end - current_start
            current_start, current_end = start, end
        elif end > current_end:
            current_end = end
    return total + (current_end - current_start)


def effective_slant_deg(shape: BodyShape) -> float:
    """Effective rear slope: roof trailing edge to the tail edge, in degrees."""
    drop = max(shape.roof_edge_height - shape.deck_height, 0.0)
    run = shape.length - shape.x_roof_end
    if run <= 1e-6:
        return 90.0
    return math.atan2(drop, run) * RAD_TO_DEG


def compute_metrics(shape: BodyShape) -> GeometryMetrics:
    params, length = shape.params, shape.length
    ride = params["rideHeight"]

    xs = length * np.arange(STATION_COUNT + 1) / STATION_COUNT
    z_low = lower_z(shape, xs)
    z_up = upper_z(shape, xs)
    plan = plan_half_width(shape, xs)

    spoiler = spoiler_geometry(shape)
    wing = wing_geometry(shape)
    splitter = splitter_geometry(shape)
    skirt = skirt_geometry(shape)
    mirror = mirror_geometry(shape)
    wheel = wheel_geometry(shape)[0]

    # --- Frontal area: project every solid onto the Y-Z plane, row by row. ---
    wing_angle = wing.angle_deg * DEG_TO_RAD
    wing_projected = wing.chord * abs(math.sin(wing_angle)) + wing.thickness * math.cos(wing_angle)
    top = ride + params["roofHeight"]
    if spoiler.present:
        top = max(top, ride + spoiler.z1 + spoiler.thickness)
    if wing.present:
        top = max(top, ride + wing.zc + wing_projected / 2)

    rows = math.ceil(top / ROW_HEIGHT)
    z_rows = (np.arange(rows) + 0.5) * ROW_HEIGHT
    zb_rows = z_rows - ride
    # Body half-width per row: the widest section over all stations.
    widths = section_half_width(params, z_low[None, :], z_up[None, :], plan[None, :], zb_rows[:, None])
    body_half_width = widths.max(axis=1)

    frontal_area = 0.0
    for r in range(rows):
        z = float(z_rows[r])
        zb = float(zb_rows[r])
        intervals: list[tuple[float, float]] = []
        if body_half_width[r] > 0:
            intervals.append((0.0, float(body_half_width[r])))
        if z <= 2 * wheel.radius:
            intervals.append((wheel.y - wheel.width / 2, wheel.y + wheel.width / 2))
        if spoiler.present and spoiler.z0 <= zb <= spoiler.z1 + spoiler.thickness:
            intervals.append((0.0, spoiler.half_width))
        if wing.present and abs(zb - wing.zc) <= wing_projected / 2:
            intervals.append((0.0, wing.span / 2))
        if skirt.present and -skirt.depth <= zb <= 0:
            intervals.append((skirt.y_outer - skirt.thickness, skirt.y_outer))
        if splitter.present and 0 <= zb <= splitter.thickness:
            intervals.append((0.0, splitter.half_width))
        if mirror.present and mirror.z0 <= zb <= mirror.z1:
            intervals.append((mirror.y0, mirror.y1))
        frontal_area += _union_length(intervals) * ROW_HEIGHT
    frontal_area *= 2

    # --- Side area, its centroid, and wetted area (upper surface and flanks). ---
    dx = length / STATION_COUNT
    weights = np.ones(STATION_COUNT + 1)
    weights[0] = weights[-1] = 0.5
    height = np.maximum(z_up - z_low, 0.0)
    side_area = float(np.sum(weights * height * dx))
    side_moment = float(np.sum(weights * height * dx * xs))
    wetted = float(np.sum(weights * (2 * height + 2 * plan) * dx))
    # Tyre segments visible below the floor (two wheels per side view).
    radius = params["wheelDiameter"] / 2
    exposed = min(ride, radius)
    segment = radius * radius * math.acos((radius - exposed) / radius) - (radius - exposed) * math.sqrt(
        max(2 * radius * exposed - exposed * exposed, 0.0)
    )
    side_area += 2 * segment
    side_moment += segment * (shape.front_axle_x + shape.rear_axle_x)

    return GeometryMetrics(
        length=length,
        overall_height=top,
        frontal_area=frontal_area,
        side_area=side_area,
        side_area_centroid_x=side_moment / side_area,
        wetted_area=MODEL["drag"]["wettedAreaFactor"] * wetted,
        ground_clearance=ride - (skirt.depth if skirt.present else 0.0),
        roof_length=shape.x_roof_end - shape.x_roof_start,
        track_width=2 * shape.wheel_centre_y,
        effective_slant_deg=effective_slant_deg(shape),
    )
