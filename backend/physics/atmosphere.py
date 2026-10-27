"""Air properties (mirror of lib/physics/atmosphere.ts)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from physics.model import MODEL

AIR = MODEL["air"]


def saturation_vapour_pressure(temperature: float) -> float:
    """Saturation vapour pressure of water over liquid (Magnus form), Pa. T in kelvin."""
    celsius = temperature - 273.15
    return 610.94 * math.exp((17.625 * celsius) / (celsius + 243.04))


def moist_air_density(temperature: float, pressure: float, relative_humidity: float) -> float:
    """rho = p_d / (R_d T) + p_v / (R_v T)"""
    vapour = min(max(relative_humidity, 0.0) * saturation_vapour_pressure(temperature), pressure)
    dry = pressure - vapour
    return dry / (AIR["gasConstantDryAir"] * temperature) + vapour / (AIR["gasConstantWaterVapour"] * temperature)


def air_viscosity(temperature: float) -> float:
    """Dynamic viscosity of air from Sutherland's law, Pa*s."""
    t0 = AIR["sutherlandReferenceTemperature"]
    s = AIR["sutherlandConstant"]
    return AIR["sutherlandReferenceViscosity"] * (temperature / t0) ** 1.5 * ((t0 + s) / (temperature + s))


@dataclass(frozen=True)
class AirState:
    density: float
    viscosity: float


def resolve_air(environment: dict[str, Any]) -> AirState:
    """Air state for an environment, honouring the direct-density override."""
    if environment["airDensityMode"] == "direct":
        density = environment["airDensity"]
    else:
        density = moist_air_density(environment["temperature"], environment["pressure"], environment["humidity"])
    return AirState(density=density, viscosity=air_viscosity(environment["temperature"]))


def reynolds_number(density: float, speed: float, length: float, viscosity: float) -> float:
    return density * speed * length / viscosity
