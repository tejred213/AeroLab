"""ML surrogate (Mode D) and the design optimiser."""

from __future__ import annotations

import pandas as pd
import pytest

import engines.ml_surrogate as ml_surrogate
from engines.analytical import AnalyticalEngine
from engines.ml_surrogate import MLSurrogateEngine, train
from optimization.optimize import constraint_violation, run_optimization
from simulation.assemble import SimulationError
from tests.helpers import config_for, spec_and_powertrain

PARAMETERS = ["rideHeight", "spoilerAngle", "spoilerHeight", "diffuserAngle", "floorFlatness"]


def training_request(samples: int = 220) -> dict:
    return {
        "config": config_for("fastback"),
        "sourceMode": "analytical",
        "samples": samples,
        "parameters": PARAMETERS,
        "spread": 0.4,
        "seed": 3,
    }


def test_untrained_surrogate_refuses_to_predict() -> None:
    engine = MLSurrogateEngine()
    available, detail = engine.availability()
    assert not available and "No surrogate" in detail
    with pytest.raises(SimulationError) as caught:
        engine.simulate(config_for("fastback", mode="ml-surrogate"))
    assert caught.value.code == "SURROGATE_NOT_TRAINED"
    assert "Nothing was predicted" in caught.value.message


def test_training_reports_metrics_and_stores_the_dataset() -> None:
    stages: list[str] = []
    meta = train(training_request(), AnalyticalEngine(), lambda state, _progress, _message: stages.append(state))
    assert meta["trainingSamples"] == 220 and meta["sourceMode"] == "analytical"
    # Both algorithms are scored on the same held-out split; the better one is used and both are reported.
    candidates = meta["candidates"]
    assert [candidate["key"] for candidate in candidates] == ["random-forest", "gradient-boosting"]
    chosen = [candidate for candidate in candidates if candidate["selected"]]
    assert len(chosen) == 1 and chosen[0]["key"] == meta["selected"] and chosen[0]["algorithm"] == meta["algorithm"]
    score = lambda candidate: candidate["validationR2Cd"] + candidate["validationR2Cl"]  # noqa: E731
    assert all(score(chosen[0]) >= score(candidate) for candidate in candidates)
    assert meta["validationRmseCd"] == chosen[0]["validationRmseCd"]
    assert meta["validationSamples"] == 44
    assert 0 < meta["validationRmseCd"] < 0.01
    assert 0 < meta["validationRmseCl"] < 0.03
    assert meta["validationR2Cd"] > 0.8 and meta["validationR2Cl"] > 0.8
    assert meta["inferenceTimeMs"] > 0
    assert "SOLVING" in stages and "POST_PROCESSING" in stages

    dataset = pd.read_csv(ml_surrogate.DATASET_DIR / f"{meta['modelId']}.csv")
    assert len(dataset) == 220
    assert {*PARAMETERS, "airDensity", "relativeSpeed", "cd", "cl", "drag", "downforce"} <= set(dataset.columns)
    # Samples stay inside the stated bounds.
    for param, (low, high) in meta["bounds"].items():
        assert dataset[param].between(low - 1e-9, high + 1e-9).all()
    assert ml_surrogate.list_models()[0]["modelId"] == meta["modelId"]


def test_prediction_tracks_its_training_engine_and_is_labelled() -> None:
    train(training_request(400), AnalyticalEngine())
    engine = MLSurrogateEngine()
    assert engine.availability()[0]
    config = config_for("fastback", {"rideHeight": 0.11, "spoilerAngle": 22}, mode="ml-surrogate")
    predicted = engine.simulate(config)
    truth = AnalyticalEngine().simulate({**config, "mode": "analytical"})

    assert predicted["mode"] == "ml-surrogate"
    assert "not a physical simulation" in predicted["provenance"]
    assert predicted["surrogate"]["trainingSamples"] == 400
    assert predicted["coefficients"]["cd"] == pytest.approx(truth["coefficients"]["cd"], abs=0.01)
    assert predicted["coefficients"]["cl"] == pytest.approx(truth["coefficients"]["cl"], abs=0.04)
    # The stated uncertainty is at least the validation error and covers the actual error here.
    assert predicted["uncertainty"]["cd"] >= predicted["surrogate"]["validationRmseCd"]
    assert abs(predicted["coefficients"]["cd"] - truth["coefficients"]["cd"]) < 3 * predicted["uncertainty"]["cd"]
    q_area = predicted["forces"]["dynamicPressure"] * predicted["coefficients"]["frontalArea"]
    assert predicted["forces"]["drag"] == pytest.approx(q_area * predicted["coefficients"]["cd"])


def test_prediction_warns_outside_its_training_data() -> None:
    train(training_request(), AnalyticalEngine())
    engine = MLSurrogateEngine()
    result = engine.simulate(
        config_for(
            "fastback",
            {"rideHeight": 0.3, "wingChord": 0.3},
            mode="ml-surrogate",
            environment={"windSpeed": 10, "windAngle": 90},
        )
    )
    codes = {warning["code"] for warning in result["warnings"]}
    assert {"SURROGATE_EXTRAPOLATION", "SURROGATE_UNSEEN_PARAMETER", "SURROGATE_NO_YAW"} <= codes
    # A model trained for one vehicle is not used for another.
    with pytest.raises(SimulationError) as caught:
        engine.simulate(config_for("suv", mode="ml-surrogate"))
    assert caught.value.code == "SURROGATE_NOT_TRAINED"


def test_training_fails_when_no_valid_samples_can_be_generated() -> None:
    # A base geometry that is not buildable.
    request = training_request(60)
    request["config"] = config_for("sedan", {"hoodLength": 1.9, "rearDeckLength": 1.2, "windshieldAngle": 18})
    with pytest.raises(SimulationError) as caught:
        train(request, AnalyticalEngine())
    assert caught.value.code == "INVALID_GEOMETRY"


def optimization_request(objective: str, algorithm: str = "differential-evolution", iterations: int = 25, constraints=None) -> dict:
    spec, powertrain = spec_and_powertrain("fastback")
    return {
        "config": config_for("fastback"),
        "spec": spec,
        "powertrain": powertrain,
        "objective": objective,
        "variables": [
            {"param": "rideHeight", "min": 0.08, "max": 0.2},
            {"param": "spoilerAngle", "min": 0, "max": 40},
            {"param": "diffuserAngle", "min": 0, "max": 15},
        ],
        "constraints": constraints or [],
        "algorithm": algorithm,
        "iterations": iterations,
        "seed": 11,
    }


def test_constraint_violation_is_normalised() -> None:
    metrics = {"cd": 0.30, "downforce": 100.0, "topSpeed": 60.0, "cl": 0.0, "drag": 500.0, "efficiency": 0.0}
    assert constraint_violation([{"metric": "downforce", "op": ">=", "value": 150}], metrics) == pytest.approx(50 / 150)
    assert constraint_violation([{"metric": "cd", "op": "<=", "value": 0.31}], metrics) == 0
    assert constraint_violation([{"metric": "cd", "op": "<=", "value": 0.27}], metrics) == pytest.approx(0.03 / 0.27)


def test_differential_evolution_improves_on_the_baseline() -> None:
    result = run_optimization(optimization_request("max-top-speed"))
    assert result["algorithm"].startswith("Differential evolution")
    assert result["best"]["feasible"]
    assert result["best"]["metrics"]["topSpeed"] > result["baseline"]["metrics"]["topSpeed"]
    # The best-so-far never gets worse from one iteration to the next.
    tops = [step["metrics"]["topSpeed"] for step in result["history"]]
    assert all(later >= earlier - 1e-9 for earlier, later in zip(tops, tops[1:]))
    assert len(result["history"]) == 26
    for variable in result["request"]["variables"]:
        value = result["best"]["values"][variable["param"]]
        assert variable["min"] - 1e-9 <= value <= variable["max"] + 1e-9
    assert 1 <= len(result["candidates"]) <= 5
    assert "Mode A" in result["provenance"]


def test_constraints_are_respected() -> None:
    # "Lift must not exceed 100 N" (downforce >= -100 N): reachable with these variables, but not for free.
    constraints = [{"metric": "downforce", "op": ">=", "value": -100.0}]
    result = run_optimization(optimization_request("min-drag", constraints=constraints, iterations=35))
    assert result["best"]["feasible"]
    assert result["best"]["metrics"]["downforce"] >= -100.0
    unconstrained = run_optimization(optimization_request("min-drag", iterations=35))
    assert unconstrained["best"]["metrics"]["downforce"] < -100.0
    # Holding the lift limit costs drag.
    assert result["best"]["metrics"]["drag"] > unconstrained["best"]["metrics"]["drag"]


def test_impossible_targets_are_reported_as_infeasible() -> None:
    constraints = [{"metric": "downforce", "op": ">=", "value": 50000.0}]
    result = run_optimization(optimization_request("meet-targets", constraints=constraints, iterations=8))
    assert not result["best"]["feasible"]
    assert result["best"]["violation"] > 0
    assert not result["history"][-1]["feasible"]


def test_bayesian_optimisation_finds_an_improvement_with_few_evaluations() -> None:
    progress: list[int] = []
    result = run_optimization(
        optimization_request("min-drag", algorithm="bayesian", iterations=12), lambda history: progress.append(len(history))
    )
    assert result["algorithm"].startswith("Bayesian")
    assert result["evaluations"] < 30
    assert result["best"]["metrics"]["drag"] < result["baseline"]["metrics"]["drag"]
    assert progress == list(range(1, 14))
