"""Production-car look-alikes: the Python library builds them as the frontend does, anchored to a generic class."""

from __future__ import annotations

import copy

import pytest

from engines.analytical import AnalyticalEngine
from geometry.parameters import PARAM_BY_ID
from geometry.validate import is_geometry_valid
from physics.model import MODEL, REAL_CAR_DATA
from vehicle.library import BUILT_IN_VEHICLES, LIBRARY_VEHICLES, REAL_CARS, get_built_in_vehicle, make_config

CALIBRATION_SPEED = MODEL["calibration"]["speed"]


def test_the_library_holds_the_classes_then_the_look_alikes() -> None:
    assert len(BUILT_IN_VEHICLES) == 6 and len(REAL_CARS) == 17
    assert LIBRARY_VEHICLES[:6] == BUILT_IN_VEHICLES
    ids = [vehicle["id"] for vehicle in LIBRARY_VEHICLES]
    assert len(set(ids)) == len(ids)
    assert get_built_in_vehicle("tesla-model-3")["realCar"]["published"]["cd"] == 0.219


@pytest.mark.parametrize("car", REAL_CARS, ids=lambda car: car["id"])
def test_a_look_alike_is_anchored_to_its_class_and_can_be_built(car: dict) -> None:
    anchor = get_built_in_vehicle(car["realCar"]["anchorClassId"])
    assert "realCar" not in anchor
    assert car["reference"] == anchor["reference"]
    assert car["referenceGeometry"] == anchor["geometry"]
    assert car["geometry"] != anchor["geometry"]
    assert car["powertrain"]["type"] == anchor["powertrain"]["type"]
    assert is_geometry_valid(car["geometry"])
    for param, value in car["geometry"].items():
        assert PARAM_BY_ID[param]["min"] - 1e-9 <= value <= PARAM_BY_ID[param]["max"] + 1e-9, param
    assert car["realCar"]["sources"] and all(source["url"].startswith("https://") for source in car["realCar"]["sources"])

    config = make_config(car, speed=CALIBRATION_SPEED)
    assert config["reference"] == anchor["reference"]
    assert config["referenceGeometry"] == anchor["geometry"]
    assert config["geometry"] == car["geometry"]
    result = AnalyticalEngine().simulate(config)
    assert 0.1 < result["coefficients"]["cd"] < 0.9
    # The stated uncertainty is never below the floor of a calibrated reference shape.
    assert result["uncertainty"]["cd"] >= 0.99 * MODEL["uncertainty"]["analytical"]["cdRelative"] * anchor["reference"]["cd"]


def test_the_published_figure_is_not_an_input() -> None:
    car = get_built_in_vehicle("mercedes-benz-eqs-450")
    altered = copy.deepcopy(car)
    altered["realCar"]["published"]["cd"] = 0.99
    altered["realCar"]["published"]["frontalArea"] = 9.9
    engine = AnalyticalEngine()
    assert engine.simulate(make_config(altered))["coefficients"] == engine.simulate(make_config(car))["coefficients"]
    # No drag coefficient appears in the data outside the published block.
    for record in REAL_CAR_DATA["cars"]:
        rest = {key: value for key, value in record.items() if key != "published"}
        assert '"cd"' not in __import__("json").dumps(rest)


def test_the_generic_classes_still_reproduce_their_own_reference() -> None:
    engine = AnalyticalEngine()
    for vehicle in BUILT_IN_VEHICLES:
        result = engine.simulate(make_config(vehicle, speed=CALIBRATION_SPEED))
        assert result["coefficients"]["cd"] == pytest.approx(vehicle["reference"]["cd"], abs=1e-6)
