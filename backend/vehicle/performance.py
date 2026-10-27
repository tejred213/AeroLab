"""Longitudinal vehicle-performance model (mirror of lib/vehicle/performance.ts).

Resistances, traction limit, acceleration, top speed and power demand. The
aerodynamic coefficients are an input; this module does not care which engine
produced them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from physics.forces import coefficient_force, dynamic_pressure, grade_force, rolling_resistance_from_load
from physics.model import DEG_TO_RAD, GRAVITY, MODEL
from vehicle.powertrain import Powertrain, ice_wheel_force_in_gear, inertia_factor, wheel_force

V = MODEL["vehicleModel"]
ACCEL_TARGETS_KMH = [60, 100, 160, 200]
KMH = 1 / 3.6


@dataclass(frozen=True)
class PerformanceInput:
    vehicle: dict[str, Any]
    powertrain: Powertrain
    wheel_radius: float
    wheelbase: float
    cd: float
    cl_front: float
    cl_rear: float
    cd_friction: float
    reference_speed: float
    frontal_area: float
    air_density: float
    gradient_deg: float
    headwind: float
    test_speed: float


def make_performance_input(
    spec: dict[str, Any],
    powertrain: Powertrain,
    geometry: dict[str, float],
    coefficients: dict[str, float],
    air_density: float,
    environment: dict[str, Any],
    speed: float,
) -> PerformanceInput:
    return PerformanceInput(
        vehicle=spec,
        powertrain=powertrain,
        wheel_radius=geometry["wheelDiameter"] / 2,
        wheelbase=geometry["wheelbase"],
        cd=coefficients["cd"],
        cl_front=coefficients["clFront"],
        cl_rear=coefficients["clRear"],
        cd_friction=coefficients["cdFriction"],
        reference_speed=coefficients["referenceSpeed"],
        frontal_area=coefficients["frontalArea"],
        air_density=air_density,
        gradient_deg=environment["gradient"],
        headwind=environment["windSpeed"] * math.cos(environment["windAngle"] * DEG_TO_RAD),
        test_speed=speed,
    )


def cd_at_speed(inp: PerformanceInput, air_speed: float) -> float:
    """Only the skin-friction part of Cd is Reynolds dependent (Cf ~ Re^-0.2)."""
    ratio = max(abs(air_speed), 2.0) / max(inp.reference_speed, 2.0)
    return inp.cd - inp.cd_friction + inp.cd_friction * ratio ** MODEL["drag"]["frictionExponent"]


@dataclass(frozen=True)
class Resistances:
    drag: float
    lift: float
    lift_front: float
    lift_rear: float
    rolling: float
    grade: float
    total: float
    cd: float


def resistances(inp: PerformanceInput, speed: float, gradient_deg: float | None = None) -> Resistances:
    gradient = inp.gradient_deg if gradient_deg is None else gradient_deg
    air_speed = speed + inp.headwind
    q = dynamic_pressure(inp.air_density, air_speed)
    cd = cd_at_speed(inp, air_speed)
    # A tailwind faster than the car pushes it forward: drag changes sign with the relative flow.
    drag = math.copysign(1.0, air_speed) * coefficient_force(q, cd, inp.frontal_area) if air_speed != 0 else 0.0
    lift_front = coefficient_force(q, inp.cl_front, inp.frontal_area)
    lift_rear = coefficient_force(q, inp.cl_rear, inp.frontal_area)
    lift = lift_front + lift_rear
    normal = max(inp.vehicle["mass"] * GRAVITY * math.cos(gradient * DEG_TO_RAD) - lift, 0.0)
    rolling = rolling_resistance_from_load(inp.vehicle["crr"], normal)
    grade = grade_force(inp.vehicle["mass"], gradient)
    return Resistances(drag, lift, lift_front, lift_rear, rolling, grade, drag + rolling + grade, cd)


def traction_limit(inp: PerformanceInput, res: Resistances, inertia: float, gradient_deg: float | None = None) -> float:
    """Largest drive force the driven tyres can transmit, with load transfer solved in closed form."""
    gradient = inp.gradient_deg if gradient_deg is None else gradient_deg
    vehicle = inp.vehicle
    theta = gradient * DEG_TO_RAD
    weight = vehicle["mass"] * GRAVITY
    height_ratio = vehicle["cgHeight"] / inp.wheelbase
    front = weight * (vehicle["weightDistFront"] * math.cos(theta) - height_ratio * math.sin(theta)) - res.lift_front
    rear = weight * ((1 - vehicle["weightDistFront"]) * math.cos(theta) + height_ratio * math.sin(theta)) - res.lift_rear
    mu = vehicle["tireMu"]
    transfer = height_ratio / inertia
    if vehicle["drivetrain"] == "RWD":
        limit = mu * (rear - transfer * res.total) / max(1 - mu * transfer, 0.05)
    elif vehicle["drivetrain"] == "FWD":
        limit = mu * (front + transfer * res.total) / (1 + mu * transfer)
    else:
        limit = mu * (front + rear)
    return max(limit, 0.0)


def _available(inp: PerformanceInput, speed: float, gradient_deg: float | None = None) -> tuple[float, float, Resistances]:
    """Returns (usable force, drive force, resistances) with ideal gear selection."""
    res = resistances(inp, speed, gradient_deg)
    drive, gear, _ = wheel_force(inp.powertrain, speed, inp.wheel_radius)
    limit = traction_limit(inp, res, inertia_factor(inp.powertrain, gear), gradient_deg)
    return min(drive, limit), drive, res


def solve_top_speed(inp: PerformanceInput) -> tuple[float, str]:
    """Top speed: the first speed, approached from rest, where net longitudinal force reaches zero."""

    def net(speed: float) -> float:
        force, _, res = _available(inp, speed)
        return force - res.total

    step = 0.5
    if net(1.0) <= 0:
        return 0.0, "power"
    low = 1.0
    high = -1.0
    speed = 1.0 + step
    while speed <= V["maxSpeed"]:
        if net(speed) <= 0:
            high = speed
            break
        low = speed
        speed += step
    if high < 0:
        return float(V["maxSpeed"]), "none"
    for _ in range(40):
        mid = 0.5 * (low + high)
        if net(mid) > 0:
            low = mid
        else:
            high = mid
    top = 0.5 * (low + high)
    beyond = wheel_force(inp.powertrain, top + 0.2, inp.wheel_radius)[0]
    if beyond <= 0:
        return top, "motor-rpm" if inp.powertrain["type"] == "EV" else "redline"
    return top, "power"


def simulate_acceleration(inp: PerformanceInput, stop_after_kmh: float | None = None) -> dict[str, Any]:
    """Full-throttle acceleration from rest, integrated with a fixed time step.

    `stop_after_kmh` ends the run once that speed is passed (used by sweeps that
    only need the lower targets); the times up to it are unaffected.
    """
    powertrain, vehicle = inp.powertrain, inp.vehicle
    dt = V["timeStep"]
    targets = [kmh * KMH for kmh in ACCEL_TARGETS_KMH]
    times: list[float | None] = [None] * len(targets)
    trace: list[dict[str, Any]] = []
    max_target = targets[-1] if stop_after_kmh is None else stop_after_kmh * KMH
    is_ice = powertrain["type"] == "ICE"

    time = 0.0
    speed = 0.0
    distance = 0.0
    gear = 1
    shift_remaining = 0.0
    traction_limited = False
    next_sample = 0.0
    acceleration = 0.0

    while time < V["maxTime"]:
        res = resistances(inp, speed)
        drive = 0.0
        shifting = False
        if not is_ice:
            drive = wheel_force(powertrain, speed, inp.wheel_radius)[0]
        elif shift_remaining > 0:
            shift_remaining -= dt
            shifting = True
        else:
            current = ice_wheel_force_in_gear(powertrain, gear - 1, speed, inp.wheel_radius)[0]
            if gear < len(powertrain["gearRatios"]):
                upshift = ice_wheel_force_in_gear(powertrain, gear, speed, inp.wheel_radius)[0]
                if current <= 0 or upshift > current:
                    gear += 1
                    shift_remaining = powertrain["shiftTime"]
                    shifting = True
                else:
                    drive = current
            else:
                drive = current

        inertia = inertia_factor(powertrain, gear)
        limit = traction_limit(inp, res, inertia)
        limited = drive > limit
        traction_limited = traction_limited or limited
        acceleration = (min(drive, limit) - res.total) / (vehicle["mass"] * inertia)

        if time >= next_sample - 1e-9:
            trace.append(
                {
                    "time": time,
                    "speed": speed,
                    "acceleration": acceleration,
                    "distance": distance,
                    "gear": gear,
                    "tractionLimited": limited,
                }
            )
            next_sample += 0.1

        if speed <= 0 and acceleration <= 0 and not shifting:
            break
        new_speed = max(speed + acceleration * dt, 0.0)
        for i, target in enumerate(targets):
            if times[i] is None and speed < target <= new_speed:
                times[i] = time + dt * (target - speed) / (new_speed - speed)
        distance += 0.5 * (speed + new_speed) * dt
        speed = new_speed
        time += dt

        if speed >= max_target * 1.03:
            break
        if not shifting and time > 1 and acceleration < 0.004:
            break

    trace.append(
        {
            "time": time,
            "speed": speed,
            "acceleration": trace[-1]["acceleration"] if trace else 0.0,
            "distance": distance,
            "gear": gear,
            "tractionLimited": False,
        }
    )
    return {
        "trace": trace,
        "times": [{"target": target, "time": times[i]} for i, target in enumerate(ACCEL_TARGETS_KMH)],
        "tractionLimited": traction_limited,
    }


def max_grade(inp: PerformanceInput) -> float:
    """Steepest gradient that can be held at the reference speed (30 km/h), deg."""
    speed = V["gradeReferenceSpeed"]

    def net(gradient: float) -> float:
        force, _, res = _available(inp, speed, gradient)
        return force - res.total

    low, high = 0.0, 45.0
    if net(low) <= 0:
        return 0.0
    if net(high) > 0:
        return high
    for _ in range(40):
        mid = 0.5 * (low + high)
        if net(mid) > 0:
            low = mid
        else:
            high = mid
    return 0.5 * (low + high)


def performance_summary(inp: PerformanceInput) -> dict[str, Any]:
    """Headline performance figures (the JSON shape of the frontend's PerformanceSummary)."""
    top, limit = solve_top_speed(inp)
    accel = simulate_acceleration(inp)
    at = resistances(inp, inp.test_speed)

    def power_at(kmh: float) -> float:
        v = kmh * KMH
        return resistances(inp, v).total * v

    range_at_100 = None
    if inp.powertrain["type"] == "EV":
        cruise = resistances(inp, 100 * KMH)
        if cruise.total > 0:
            range_at_100 = inp.powertrain["batteryCapacityJ"] * inp.powertrain["drivetrainEfficiency"] / cruise.total

    return {
        "topSpeed": top,
        "topSpeedLimit": limit,
        "accelTimes": accel["times"],
        "tractionLimited": accel["tractionLimited"],
        "maxGradeDeg": max_grade(inp),
        "power100": power_at(100),
        "power200": power_at(200),
        "rangeAt100": range_at_100,
        "forcesAtSpeed": {
            "speed": inp.test_speed,
            "drag": at.drag,
            "rolling": at.rolling,
            "grade": at.grade,
            "total": at.total,
            "powerRequired": at.total * inp.test_speed,
        },
    }
