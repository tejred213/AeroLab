"""Details that carry drag: door mirrors, rim openness and the cooling intake (mirrors tests/details.test.ts)."""

from __future__ import annotations

import pytest

from engines.analytical import AnalyticalEngine
from engines.reduced_order import ReducedOrderEngine
from geometry.metrics import compute_metrics
from geometry.parameters import PARAM_BY_ID, complete_geometry
from geometry.profile import build_body_shape, mirror_geometry
from physics.model import MODEL
from vehicle.library import get_built_in_vehicle, make_config


def _solve(engine, vehicle_id: str, **changes: float) -> dict:
    vehicle = get_built_in_vehicle(vehicle_id)
    config = make_config(vehicle)
    config["geometry"] = {**config["geometry"], **changes}
    return engine.simulate(config)


def _item(result: dict, name: str) -> float:
    return next(entry["value"] for entry in result["breakdown"]["drag"] if entry["id"] == name)


def test_a_geometry_stored_before_the_detail_parameters_is_completed() -> None:
    geometry = dict(get_built_in_vehicle("sedan")["geometry"])
    for param in ("mirrorWidth", "rimOpenness", "grilleOpening"):
        del geometry[param]
    complete = complete_geometry(geometry)
    for param in ("mirrorWidth", "rimOpenness", "grilleOpening"):
        assert complete[param] == PARAM_BY_ID[param]["default"]
    assert complete_geometry(complete) is complete
    config = make_config(get_built_in_vehicle("sedan"))
    config["geometry"] = geometry
    assert 0.2 < AnalyticalEngine().simulate(config)["coefficients"]["cd"] < 0.4


def test_mirrors_add_their_area_and_a_few_per_cent_of_drag() -> None:
    geometry = get_built_in_vehicle("sedan")["geometry"]
    mirror = mirror_geometry(build_body_shape(geometry))
    assert mirror.present and mirror.area == pytest.approx(MODEL["profile"]["mirrorAspect"] * geometry["mirrorWidth"] ** 2)
    with_mirrors = compute_metrics(build_body_shape(geometry)).frontal_area
    without = compute_metrics(build_body_shape({**geometry, "mirrorWidth": 0.0})).frontal_area
    assert 0.95 * 2 * mirror.area < with_mirrors - without < 1.35 * 2 * mirror.area

    for engine in (AnalyticalEngine(), ReducedOrderEngine()):
        dressed = _solve(engine, "sedan")
        bare = _solve(engine, "sedan", mirrorWidth=0.0)
        assert 0.008 < _item(dressed, "mirrors") < 0.02 and _item(bare, "mirrors") == 0
        area = lambda result: result["coefficients"]["cd"] * result["metrics"]["frontalArea"]  # noqa: E731
        assert 0.02 < 1 - area(bare) / area(dressed) < 0.07


def test_open_rims_and_a_larger_intake_add_drag() -> None:
    engine = AnalyticalEngine()
    closed = _solve(engine, "sedan", rimOpenness=0.0)["coefficients"]["cd"]
    opened = _solve(engine, "sedan", rimOpenness=1.0)["coefficients"]["cd"]
    assert 0.006 < opened - closed < 0.016
    sealed = _solve(engine, "sedan", grilleOpening=0.0)
    typical = _solve(engine, "sedan", grilleOpening=0.045)
    assert _item(sealed, "cooling") == 0
    assert _item(typical, "cooling") == pytest.approx(MODEL["drag"]["coolingLoss"] * 0.045)
    assert 0.015 < typical["coefficients"]["cd"] - sealed["coefficients"]["cd"] < 0.03
