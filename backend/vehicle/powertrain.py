"""Simplified powertrain models (mirror of lib/vehicle/powertrain.ts).

Powertrains are plain dicts in the JSON shape shared with the frontend
(``type`` is "ICE" or "EV").
"""

from __future__ import annotations

import math
from typing import Any

from physics.model import MODEL

V = MODEL["vehicleModel"]
RPM_TO_RAD = 2 * math.pi / 60

Powertrain = dict[str, Any]


def _interpolate(xs: list[float], ys: list[float], x: float) -> float:
    """Linear interpolation through sorted points, holding the end values outside the range."""
    last = len(xs) - 1
    if x <= xs[0]:
        return ys[0]
    if x >= xs[last]:
        return ys[last]
    for i in range(last):
        if x <= xs[i + 1]:
            span = xs[i + 1] - xs[i]
            if span <= 0:
                return ys[i + 1]
            return ys[i] + (ys[i + 1] - ys[i]) * (x - xs[i]) / span
    return ys[last]


def ice_torque(powertrain: Powertrain, rpm: float) -> float:
    """Engine torque at a crankshaft speed, N*m.

    Simplified curve: torque rises from idle to the peak-torque point, falls
    linearly to the torque implied by peak power, and is capped so that power
    never exceeds the stated peak. A user-defined power curve replaces it.
    """
    if rpm > powertrain["redlineRpm"] or rpm <= 0:
        return 0.0
    omega = rpm * RPM_TO_RAD

    curve = powertrain.get("powerCurve")
    if curve and len(curve) >= 2:
        points = sorted(curve, key=lambda point: point["rpm"])
        power_w = _interpolate([p["rpm"] for p in points], [p["powerW"] for p in points], rpm)
        return max(power_w, 0.0) / omega

    torque_at_peak_power = powertrain["peakPowerW"] / (powertrain["peakPowerRpm"] * RPM_TO_RAD)
    torque_at_redline = V["redlinePowerFraction"] * powertrain["peakPowerW"] / (powertrain["redlineRpm"] * RPM_TO_RAD)
    peak_torque_rpm = min(powertrain["peakTorqueRpm"], powertrain["peakPowerRpm"] - 100)
    xs = [powertrain["idleRpm"], peak_torque_rpm, powertrain["peakPowerRpm"], powertrain["redlineRpm"]]
    ys = [
        V["idleTorqueFraction"] * powertrain["peakTorqueNm"],
        powertrain["peakTorqueNm"],
        torque_at_peak_power,
        torque_at_redline,
    ]
    return min(_interpolate(xs, ys, rpm), powertrain["peakPowerW"] / omega)


def engine_rpm(powertrain: Powertrain, gear_index: int, speed: float, wheel_radius: float) -> float:
    return (speed / wheel_radius) * powertrain["gearRatios"][gear_index] * powertrain["finalDrive"] / RPM_TO_RAD


def ice_wheel_force_in_gear(powertrain: Powertrain, gear_index: int, speed: float, wheel_radius: float) -> tuple[float, int, float]:
    """Wheel force of an ICE powertrain in one gear. Returns (force, gear, rpm); force 0 if unusable."""
    overall = powertrain["gearRatios"][gear_index] * powertrain["finalDrive"]
    rpm = engine_rpm(powertrain, gear_index, speed, wheel_radius)
    if rpm > powertrain["redlineRpm"]:
        return 0.0, gear_index + 1, rpm
    effective_rpm = rpm
    if gear_index == 0:
        # Launch: the clutch slips so the engine can sit near its torque peak.
        launch_rpm = max(
            powertrain["idleRpm"],
            min(powertrain["peakTorqueRpm"], V["launchRpmCapFraction"] * powertrain["redlineRpm"]),
        )
        effective_rpm = max(rpm, launch_rpm)
    elif rpm < powertrain["idleRpm"]:
        return 0.0, gear_index + 1, rpm
    force = ice_torque(powertrain, effective_rpm) * overall * powertrain["drivetrainEfficiency"] / wheel_radius
    return force, gear_index + 1, effective_rpm


def _ev_wheel_force(powertrain: Powertrain, speed: float, wheel_radius: float) -> tuple[float, int, float]:
    rpm = (speed / wheel_radius) * powertrain["gearRatio"] / RPM_TO_RAD
    if rpm > powertrain["maxMotorRpm"]:
        return 0.0, 1, rpm
    # Constant torque up to base speed, then constant power.
    torque_limited = powertrain["peakTorqueNm"] * powertrain["gearRatio"] * powertrain["drivetrainEfficiency"] / wheel_radius
    power_limited = powertrain["peakPowerW"] * powertrain["drivetrainEfficiency"] / max(speed, 0.1)
    return min(torque_limited, power_limited), 1, rpm


def wheel_force(powertrain: Powertrain, speed: float, wheel_radius: float) -> tuple[float, int, float]:
    """Best available wheel force at a road speed. Returns (force, gear, rpm)."""
    if powertrain["type"] == "EV":
        return _ev_wheel_force(powertrain, speed, wheel_radius)
    best = (0.0, 0, 0.0)
    for index in range(len(powertrain["gearRatios"])):
        candidate = ice_wheel_force_in_gear(powertrain, index, speed, wheel_radius)
        if candidate[0] > best[0]:
            best = candidate
    return best


def inertia_factor(powertrain: Powertrain, gear: int) -> float:
    """Rotational-inertia factor: effective mass = mass x factor."""
    if powertrain["type"] == "EV":
        return 1 + V["evInertia"]
    index = min(max(gear - 1, 0), len(powertrain["gearRatios"]) - 1)
    overall = powertrain["gearRatios"][index] * powertrain["finalDrive"]
    return 1 + V["inertiaBase"] + V["inertiaGear"] * overall * overall
