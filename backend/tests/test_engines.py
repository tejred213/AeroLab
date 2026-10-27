"""Behaviour of the aerodynamic engines: calibration, trends, validity handling."""

from __future__ import annotations

import base64

import numpy as np
import pytest

from engines.analytical import AnalyticalEngine
from engines.reduced_order import ReducedOrderEngine
from engines.registry import get_engine, simulate
from physics.model import MODEL
from simulation.assemble import SimulationError
from tests.helpers import config_for
from vehicle.library import BUILT_IN_VEHICLES

ANALYTICAL = AnalyticalEngine()
REDUCED = ReducedOrderEngine()
CALIBRATION_SPEED = MODEL["calibration"]["speed"]


@pytest.mark.parametrize("vehicle", BUILT_IN_VEHICLES, ids=[v["id"] for v in BUILT_IN_VEHICLES])
@pytest.mark.parametrize("engine", [ANALYTICAL, REDUCED], ids=["analytical", "reduced-order"])
def test_reference_geometry_reproduces_the_class_reference(vehicle, engine) -> None:
    result = engine.simulate(config_for(vehicle["id"], speed=CALIBRATION_SPEED, mode=engine.mode))
    assert result["coefficients"]["cd"] == pytest.approx(vehicle["reference"]["cd"], abs=1e-6)
    assert result["coefficients"]["cl"] == pytest.approx(vehicle["reference"]["cl"], abs=1e-6)
    assert result["mode"] == engine.mode
    assert result["source"] == "backend"


def test_results_state_their_mode_and_never_claim_cfd() -> None:
    for engine in (ANALYTICAL, REDUCED):
        result = engine.simulate(config_for("sedan", mode=engine.mode))
        assert result["provenance"].startswith("Mode A" if engine.mode == "analytical" else "Mode B")
        assert "not CFD" in result["provenance"] or "No flow field is solved" in result["provenance"]
        assert result["uncertainty"]["cd"] > 0 and result["uncertainty"]["cl"] > 0
        assert len(result["assumptions"]) >= 5


@pytest.mark.parametrize("engine", [ANALYTICAL, REDUCED], ids=["analytical", "reduced-order"])
def test_lower_ride_height_reduces_lift_and_drag(engine) -> None:
    heights = [0.17, 0.14, 0.11, 0.08]
    results = [engine.simulate(config_for("fastback", {"rideHeight": h}, mode=engine.mode)) for h in heights]
    lifts = [r["coefficients"]["cl"] for r in results]
    drags = [r["coefficients"]["cd"] for r in results]
    assert lifts == sorted(lifts, reverse=True), "lift must fall monotonically as the car is lowered"
    assert drags == sorted(drags, reverse=True), "drag must fall monotonically as the car is lowered"


def test_spoiler_and_wing_trade_drag_for_downforce() -> None:
    base = ANALYTICAL.simulate(config_for("fastback", {"spoilerHeight": 0, "wingChord": 0}))
    spoiler = ANALYTICAL.simulate(config_for("fastback", {"spoilerHeight": 0.1, "spoilerAngle": 40, "wingChord": 0}))
    wing = ANALYTICAL.simulate(config_for("fastback", {"spoilerHeight": 0, "wingChord": 0.3, "wingAngle": 10}))
    for modified in (spoiler, wing):
        assert modified["coefficients"]["cl"] < base["coefficients"]["cl"]
        assert modified["coefficients"]["cd"] > base["coefficients"]["cd"]
    # The devices act at the rear.
    assert wing["coefficients"]["clRear"] < base["coefficients"]["clRear"]


def test_drag_peaks_near_the_critical_rear_slope() -> None:
    """Ahmed-body trend: drag rises toward ~30 deg, where the flow is on the verge of separating."""

    def cd(angle: float) -> float:
        return ANALYTICAL.simulate(config_for("hatchback", {"rearWindowAngle": angle, "rearBumperHeight": 0.7}))["coefficients"]["cd"]

    shallow, critical = cd(16), cd(28)
    assert critical > shallow


def test_crosswind_adds_side_force_and_drag() -> None:
    still = ANALYTICAL.simulate(config_for("suv"))
    gust = ANALYTICAL.simulate(config_for("suv", environment={"windSpeed": 12, "windAngle": 80}))
    assert still["coefficients"]["cs"] == 0 and still["forces"]["side"] == 0
    assert gust["wind"]["yawAngleDeg"] > 5
    assert gust["coefficients"]["cs"] > 0 and gust["forces"]["yawMoment"] != 0
    assert gust["coefficients"]["cd"] > still["coefficients"]["cd"]
    opposite = ANALYTICAL.simulate(config_for("suv", environment={"windSpeed": 12, "windAngle": -80}))
    assert opposite["coefficients"]["cs"] == pytest.approx(-gust["coefficients"]["cs"])


def test_forces_follow_from_the_coefficients() -> None:
    result = ANALYTICAL.simulate(config_for("sedan", speed=40.0))
    c, f = result["coefficients"], result["forces"]
    q = 0.5 * result["air"]["density"] * 40.0**2
    assert f["dynamicPressure"] == pytest.approx(q)
    assert f["drag"] == pytest.approx(q * c["cd"] * c["frontalArea"])
    assert f["lift"] == pytest.approx(q * c["cl"] * c["frontalArea"])
    assert f["downforce"] == pytest.approx(-f["lift"])
    assert c["clFront"] + c["clRear"] == pytest.approx(c["cl"])
    total = sum(item["value"] for item in result["breakdown"]["drag"])
    assert total == pytest.approx(c["cd"])


def test_impossible_geometry_is_rejected_not_simulated() -> None:
    with pytest.raises(SimulationError) as caught:
        ANALYTICAL.simulate(config_for("sedan", {"hoodLength": 1.9, "rearDeckLength": 1.2, "windshieldAngle": 18}))
    assert caught.value.code == "INVALID_GEOMETRY"
    assert "roof" in caught.value.message.lower()


def test_suspicious_configurations_raise_warnings() -> None:
    result = ANALYTICAL.simulate(config_for("sports-coupe", {"rideHeight": 0.06, "minGroundClearance": 0.08}))
    assert "CLEARANCE_BELOW_LIMIT" in {warning["code"] for warning in result["warnings"]}
    stalled = ANALYTICAL.simulate(config_for("fastback", {"wingChord": 0.3, "wingAngle": 22, "diffuserAngle": 18}))
    assert {"WING_STALL", "DIFFUSER_STALL"} <= {warning["code"] for warning in stalled["warnings"]}


def test_reduced_order_solver_converges_and_reports_diagnostics() -> None:
    result = REDUCED.simulate(config_for("sedan", mode="reduced-order"))
    solver = result["solver"]
    assert solver["converged"] and solver["residual"] <= 1e-5
    assert solver["fluidCells"] < solver["cells"]
    assert 0 < solver["blockageRatio"] < 0.15
    ids = {item["id"] for item in result["breakdown"]["drag"]}
    assert {"pressure", "base", "friction", "wheels", "calibration"} <= ids


def test_reduced_order_field_is_physical() -> None:
    result = REDUCED.simulate(config_for("fastback", mode="reduced-order"), want_field=True)
    field = result["field"]
    count = field["nx"] * field["ny"] * field["nz"]
    u = np.frombuffer(base64.b64decode(field["u"]), dtype="<f4")
    cp = np.frombuffer(base64.b64decode(field["cp"]), dtype="<f4")
    kind = np.frombuffer(base64.b64decode(field["kind"]), dtype="u1")
    assert len(u) == len(cp) == len(kind) == count
    assert set(np.unique(kind)) == {0, 1, 2}  # fluid, solid and wake cells all exist
    fluid = kind == 0
    assert cp[fluid].max() <= 1.0 + 1e-6  # Bernoulli: stagnation is the highest pressure
    assert cp[fluid].max() > 0.6  # and a stagnation region exists at the nose
    # Far upstream the flow is undisturbed.
    inlet = u.reshape(field["nz"], field["ny"], field["nx"])[:, :, 0]
    assert np.allclose(inlet, 1.0, atol=0.03)
    assert "Not a CFD solution" in field["provenance"]


def test_registry_caches_results_and_dispatches_by_mode() -> None:
    config = config_for("hatchback", mode="reduced-order")
    first = simulate(config)
    second = simulate(config)
    assert not first["cached"] and second["cached"]
    assert second["aero"]["coefficients"] == first["aero"]["coefficients"]
    assert first["hash"] == second["hash"]
    # The gradient has no aerodynamic effect, so it does not invalidate the cached aerodynamics.
    assert simulate({**config, "environment": {**config["environment"], "gradient": 5}})["cached"]
    assert not simulate({**config, "speed": config["speed"] + 5})["cached"]
    with pytest.raises(SimulationError):
        get_engine("wind-tunnel")
