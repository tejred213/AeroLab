"""Physics validation: the fundamental relations the whole simulator rests on."""

from __future__ import annotations

import math

import pytest

from physics.atmosphere import air_viscosity, moist_air_density, saturation_vapour_pressure
from physics.forces import (
    drag_force,
    dynamic_pressure,
    grade_force,
    lift_force,
    normal_load,
    power,
    rolling_resistance,
    rolling_resistance_from_load,
)
from physics.model import GRAVITY
from physics.wind import relative_wind
from tests.helpers import config_for, spec_and_powertrain
from engines.analytical import AnalyticalEngine
from vehicle.performance import make_performance_input, performance_summary, resistances, solve_top_speed

RHO = 1.225
AREA = 2.2


def test_dynamic_pressure() -> None:
    assert dynamic_pressure(RHO, 40) == pytest.approx(0.5 * RHO * 1600)
    assert dynamic_pressure(RHO, 0) == 0


@pytest.mark.parametrize("speed", [10, 25, 60])
def test_drag_is_proportional_to_speed_squared(speed: float) -> None:
    assert drag_force(RHO, speed, 0.3, AREA) == pytest.approx(0.5 * RHO * speed**2 * 0.3 * AREA)
    assert drag_force(RHO, 2 * speed, 0.3, AREA) / drag_force(RHO, speed, 0.3, AREA) == pytest.approx(4)
    assert drag_force(RHO, 3 * speed, 0.3, AREA) / drag_force(RHO, speed, 0.3, AREA) == pytest.approx(9)


@pytest.mark.parametrize("speed", [10, 25, 60])
def test_lift_is_proportional_to_speed_squared(speed: float) -> None:
    assert lift_force(RHO, 2 * speed, 0.1, AREA) / lift_force(RHO, speed, 0.1, AREA) == pytest.approx(4)
    assert lift_force(RHO, speed, -0.2, AREA) < 0  # negative Cl is downforce
    assert lift_force(RHO, speed, 0.2, AREA) > 0


@pytest.mark.parametrize("speed", [10, 25, 60])
def test_aerodynamic_power_is_proportional_to_speed_cubed(speed: float) -> None:
    def aero_power(v: float) -> float:
        return power(drag_force(RHO, v, 0.3, AREA), v)

    assert aero_power(2 * speed) / aero_power(speed) == pytest.approx(8)
    assert aero_power(3 * speed) / aero_power(speed) == pytest.approx(27)


def test_grade_force_is_m_g_sin_theta() -> None:
    mass = 1500
    assert grade_force(mass, 0) == 0
    assert grade_force(mass, 10) == pytest.approx(mass * GRAVITY * math.sin(math.radians(10)))
    assert grade_force(mass, 90) == pytest.approx(mass * GRAVITY)
    assert grade_force(mass, -5) == pytest.approx(-grade_force(mass, 5))
    assert grade_force(mass, 5) > 0  # uphill resists motion


def test_rolling_resistance_is_crr_m_g() -> None:
    assert rolling_resistance(0.01, 1500) == pytest.approx(0.01 * 1500 * GRAVITY)
    assert rolling_resistance(0.02, 1500) / rolling_resistance(0.01, 1500) == pytest.approx(2)
    assert rolling_resistance(0.01, 3000) / rolling_resistance(0.01, 1500) == pytest.approx(2)
    # The load-based form reduces to Crr m g on a level road with no lift.
    assert rolling_resistance_from_load(0.01, normal_load(1500, 0, 0)) == pytest.approx(rolling_resistance(0.01, 1500))
    assert normal_load(1500, 0, -500) == pytest.approx(1500 * GRAVITY + 500)
    assert normal_load(1500, 10, 0) == pytest.approx(1500 * GRAVITY * math.cos(math.radians(10)))


def test_air_density_and_viscosity() -> None:
    assert moist_air_density(288.15, 101325, 0) == pytest.approx(1.225, abs=1e-3)
    assert moist_air_density(300, 101325, 0) / moist_air_density(150, 101325, 0) == pytest.approx(0.5)
    assert moist_air_density(303.15, 101325, 1) < moist_air_density(303.15, 101325, 0)
    assert 2300 < saturation_vapour_pressure(293.15) < 2380
    assert air_viscosity(288.15) == pytest.approx(1.789e-5, abs=1e-7)


def test_relative_wind() -> None:
    still = relative_wind(40, 0, 0)
    assert still.relative_speed == pytest.approx(40) and still.yaw_angle_deg == pytest.approx(0)
    assert relative_wind(40, 10, 0).relative_speed == pytest.approx(50)
    cross = relative_wind(30, 30, 90)
    assert cross.yaw_angle_deg == pytest.approx(45)
    assert relative_wind(30, 30, -90).yaw_angle_deg == pytest.approx(-45)


def performance_input(vehicle_id: str, **config_options):
    config = config_for(vehicle_id, **config_options)
    aero = AnalyticalEngine().simulate(config)
    spec, powertrain = spec_and_powertrain(vehicle_id)
    return make_performance_input(
        spec, powertrain, config["geometry"], aero["coefficients"], aero["air"]["density"], config["environment"], config["speed"]
    )


def test_total_resistance_is_the_sum_of_its_parts() -> None:
    inp = performance_input("sedan", environment={"gradient": 3})
    res = resistances(inp, 30)
    assert res.total == pytest.approx(res.drag + res.rolling + res.grade)
    assert res.grade == pytest.approx(grade_force(inp.vehicle["mass"], 3))


def test_top_speed_is_where_available_power_meets_demand() -> None:
    inp = performance_input("sedan")
    top, limit = solve_top_speed(inp)
    assert limit == "power"
    res = resistances(inp, top)
    wheel_power = inp.powertrain["peakPowerW"] * inp.powertrain["drivetrainEfficiency"]
    # At the top speed the resisting power cannot exceed what the powertrain delivers to the wheels.
    assert res.total * top <= wheel_power * 1.001
    assert res.total * top > 0.8 * wheel_power


def test_gradient_and_drag_reduce_top_speed() -> None:
    flat, _ = solve_top_speed(performance_input("hatchback"))
    uphill, _ = solve_top_speed(performance_input("hatchback", environment={"gradient": 6}))
    downhill, _ = solve_top_speed(performance_input("hatchback", environment={"gradient": -4}))
    assert uphill < flat < downhill


def test_performance_summary_is_plausible() -> None:
    summary = performance_summary(performance_input("generic-ev"))
    assert summary["topSpeedLimit"] == "motor-rpm"
    times = {entry["target"]: entry["time"] for entry in summary["accelTimes"]}
    assert 3 < times[100] < 9
    assert times[60] < times[100] < times[160]
    assert summary["rangeAt100"] > 200_000
    assert summary["power200"] > 4 * summary["power100"]  # aero power dominates and grows with V^3
