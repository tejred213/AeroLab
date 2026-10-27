"""Relative wind seen by the vehicle (mirror of lib/physics/wind.ts).

Wind angle convention: 0 deg = pure headwind, +/-90 deg = pure crosswind.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from physics.model import DEG_TO_RAD, RAD_TO_DEG


@dataclass(frozen=True)
class RelativeWind:
    relative_speed: float
    yaw_angle_deg: float
    longitudinal: float
    lateral: float


def relative_wind(vehicle_speed: float, wind_speed: float, wind_angle_deg: float) -> RelativeWind:
    angle = wind_angle_deg * DEG_TO_RAD
    longitudinal = vehicle_speed + wind_speed * math.cos(angle)
    lateral = wind_speed * math.sin(angle)
    speed = math.hypot(longitudinal, lateral)
    yaw = math.atan2(lateral, longitudinal) * RAD_TO_DEG if speed > 1e-9 else 0.0
    return RelativeWind(relative_speed=speed, yaw_angle_deg=yaw, longitudinal=longitudinal, lateral=lateral)
