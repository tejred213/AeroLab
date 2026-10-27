"""Cross-language parity: the Python engines must reproduce the TypeScript engines.

shared/golden/*.json is generated from the TypeScript implementation
(`npm run golden`). Every case is recomputed here with the Python
implementation. This is what keeps the two copies of the physics identical.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from engines.analytical import AnalyticalEngine
from engines.reduced_order import ReducedOrderEngine
from geometry.metrics import compute_metrics
from geometry.profile import build_body_shape
from physics.model import MODEL_VERSION
from vehicle.library import get_built_in_vehicle, vehicle_spec_of
from vehicle.performance import make_performance_input, performance_summary

GOLDEN_DIR = Path(__file__).resolve().parents[2] / "shared" / "golden"


def load(name: str) -> dict[str, Any]:
    data = json.loads((GOLDEN_DIR / name).read_text(encoding="utf-8"))
    assert data["modelVersion"] == MODEL_VERSION, "Golden files are stale: run `npm run golden`."
    return data


GEOMETRY_CASES = load("geometry.json")["cases"]
ANALYTICAL_CASES = load("analytical.json")["cases"]
REDUCED_ORDER_CASES = load("reduced-order.json")["cases"]


def assert_close(actual: dict[str, Any], expected: dict[str, Any], rel: float, abs_tol: float, path: str = "") -> None:
    """Compares the numeric leaves that both mappings share."""
    for key, value in expected.items():
        where = f"{path}.{key}" if path else key
        assert key in actual, f"missing {where}"
        if isinstance(value, dict):
            assert_close(actual[key], value, rel, abs_tol, where)
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            assert actual[key] == pytest.approx(value, rel=rel, abs=abs_tol), where
        elif value is None:
            assert actual[key] is None, where


@pytest.mark.parametrize("case", GEOMETRY_CASES, ids=[case["name"] for case in GEOMETRY_CASES])
def test_geometry_matches_typescript(case: dict[str, Any]) -> None:
    shape = build_body_shape(case["geometry"])
    assert_close(compute_metrics(shape).to_json(), case["metrics"], rel=1e-9, abs_tol=1e-9)
    assert shape.length == pytest.approx(case["shape"]["length"], abs=1e-12)
    assert shape.x_roof_start == pytest.approx(case["shape"]["xRoofStart"], abs=1e-12)
    assert shape.x_roof_end == pytest.approx(case["shape"]["xRoofEnd"], abs=1e-12)
    assert shape.tail_height == pytest.approx(case["shape"]["tailHeight"], abs=1e-12)
    assert shape.wheel_centre_y == pytest.approx(case["shape"]["wheelCentreY"], abs=1e-12)
    assert shape.diffuser_exit_height == pytest.approx(case["shape"]["diffuserExitHeight"], abs=1e-12)


def breakdown(result: dict[str, Any], kind: str) -> dict[str, float]:
    return {item["id"]: item["value"] for item in result["breakdown"][kind]}


@pytest.mark.parametrize("case", ANALYTICAL_CASES, ids=[case["name"] for case in ANALYTICAL_CASES])
def test_analytical_matches_typescript(case: dict[str, Any]) -> None:
    result = AnalyticalEngine().simulate(case["config"])
    expected = case["aero"]
    for section in ("coefficients", "uncertainty", "forces", "wind", "air", "calibration", "rearFlow", "metrics"):
        assert_close(result[section], expected[section], rel=1e-9, abs_tol=1e-9, path=section)
    assert_close(breakdown(result, "drag"), expected["drag"], rel=1e-9, abs_tol=1e-10, path="drag")
    assert_close(breakdown(result, "lift"), expected["lift"], rel=1e-9, abs_tol=1e-10, path="lift")
    assert sorted(warning["code"] for warning in result["warnings"]) == expected["warnings"]


@pytest.mark.parametrize("case", ANALYTICAL_CASES, ids=[case["name"] for case in ANALYTICAL_CASES])
def test_performance_matches_typescript(case: dict[str, Any]) -> None:
    config = case["config"]
    vehicle = get_built_in_vehicle(case["vehicleId"])
    result = AnalyticalEngine().simulate(config)
    summary = performance_summary(
        make_performance_input(
            vehicle_spec_of(vehicle),
            vehicle["powertrain"],
            config["geometry"],
            result["coefficients"],
            result["air"]["density"],
            config["environment"],
            config["speed"],
        )
    )
    expected = case["performance"]
    assert summary["topSpeed"] == pytest.approx(expected["topSpeed"], rel=1e-7)
    assert summary["topSpeedLimit"] == expected["topSpeedLimit"]
    assert summary["tractionLimited"] == expected["tractionLimited"]
    assert summary["maxGradeDeg"] == pytest.approx(expected["maxGradeDeg"], rel=1e-7)
    assert summary["power100"] == pytest.approx(expected["power100"], rel=1e-9)
    assert summary["power200"] == pytest.approx(expected["power200"], rel=1e-9)
    assert_close(summary["forcesAtSpeed"], expected["forcesAtSpeed"], rel=1e-9, abs_tol=1e-9)
    for got, want in zip(summary["accelTimes"], expected["accelTimes"]):
        assert got["target"] == want["target"]
        if want["time"] is None:
            assert got["time"] is None
        else:
            assert got["time"] == pytest.approx(want["time"], rel=1e-6)
    if expected["rangeAt100"] is None:
        assert summary["rangeAt100"] is None
    else:
        assert summary["rangeAt100"] == pytest.approx(expected["rangeAt100"], rel=1e-9)


@pytest.mark.parametrize("case", REDUCED_ORDER_CASES, ids=[case["name"] for case in REDUCED_ORDER_CASES])
def test_reduced_order_matches_typescript(case: dict[str, Any]) -> None:
    """The two potential-flow solvers share the discretisation; they differ only by solver round-off."""
    result = ReducedOrderEngine().simulate(case["config"])
    expected = case["aero"]
    assert result["solver"]["gridSize"] == expected["solver"]["gridSize"]
    assert result["solver"]["fluidCells"] == expected["solver"]["fluidCells"]
    assert result["coefficients"]["frontalArea"] == pytest.approx(expected["coefficients"]["frontalArea"], rel=1e-9)
    # Iterative-solver tolerance (1e-5) limits the agreement of the integrated coefficients.
    assert result["calibration"]["cdRaw"] == pytest.approx(expected["calibration"]["cdRaw"], abs=2e-3)
    assert result["calibration"]["clRaw"] == pytest.approx(expected["calibration"]["clRaw"], abs=4e-3)
    assert result["coefficients"]["cd"] == pytest.approx(expected["coefficients"]["cd"], abs=2e-3)
    assert result["coefficients"]["cl"] == pytest.approx(expected["coefficients"]["cl"], abs=4e-3)
    assert result["coefficients"]["cs"] == pytest.approx(expected["coefficients"]["cs"], abs=1e-9)
    assert result["rearFlow"]["basePressureCoefficient"] == pytest.approx(
        expected["rearFlow"]["basePressureCoefficient"], abs=2e-3
    )
