"""HTTP API: validation, the job lifecycle, and explicit failures."""

from __future__ import annotations

import shutil
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient

from main import app
from tests.helpers import config_for, spec_and_powertrain
from tests.test_openfoam import coefficient_file
from vehicle.library import get_built_in_vehicle

client = TestClient(app)


def wait_for(path: str, timeout: float = 120.0) -> dict[str, Any]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(path).json()
        if status["state"] in ("COMPLETE", "FAILED"):
            return status
        time.sleep(0.02)
    raise AssertionError(f"job at {path} did not finish")


def run_simulation(config: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    created = client.post("/api/simulations", json={"config": config})
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]
    assert created.json()["state"] == "QUEUED"
    assert client.post(f"/api/simulations/{job_id}/run").status_code == 200
    return job_id, wait_for(f"/api/simulations/{job_id}")


def test_health_reports_engine_availability() -> None:
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["engines"]["analytical"]["available"] and body["engines"]["reduced-order"]["available"]
    assert set(body["engines"]) == {"analytical", "reduced-order", "cfd", "ml-surrogate"}
    assert not body["engines"]["ml-surrogate"]["available"]


@pytest.mark.parametrize("mode", ["analytical", "reduced-order"])
def test_simulation_job_lifecycle(mode: str) -> None:
    job_id, status = run_simulation(config_for("fastback", mode=mode))
    assert status["state"] == "COMPLETE" and status["progress"] == 1 and status["error"] is None
    result = client.get(f"/api/simulations/{job_id}/results").json()
    assert result["aero"]["mode"] == mode and result["aero"]["source"] == "backend"
    assert 0.2 < result["aero"]["coefficients"]["cd"] < 0.35
    assert result["cached"] is False and len(result["hash"]) > 8
    # The same configuration again is served from the cache.
    second_id, _ = run_simulation(config_for("fastback", mode=mode))
    assert client.get(f"/api/simulations/{second_id}/results").json()["cached"] is True


def test_results_are_not_available_before_the_job_has_run() -> None:
    created = client.post("/api/simulations", json={"config": config_for("sedan")}).json()
    response = client.get(f"/api/simulations/{created['id']}/results")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "NOT_COMPLETE"
    assert client.get("/api/simulations/unknown-id").status_code == 404


def test_out_of_range_input_is_rejected_with_field_detail() -> None:
    config = config_for("sedan")
    config["geometry"]["rideHeight"] = 2.5
    response = client.post("/api/simulations", json={"config": config})
    assert response.status_code == 422
    assert any("rideHeight" in str(item["loc"]) for item in response.json()["detail"])

    config = config_for("sedan")
    config["environment"]["airDensity"] = -1
    assert client.post("/api/simulations", json={"config": config}).status_code == 422
    config = config_for("sedan")
    config["mode"] = "wind-tunnel"
    assert client.post("/api/simulations", json={"config": config}).status_code == 422
    config = config_for("sedan")
    config["unexpected"] = 1
    assert client.post("/api/simulations", json={"config": config}).status_code == 422


def test_unbuildable_geometry_is_rejected_before_a_job_exists() -> None:
    config = config_for("sedan", {"hoodLength": 1.9, "rearDeckLength": 1.2, "windshieldAngle": 18})
    response = client.post("/api/simulations", json={"config": config})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "INVALID_GEOMETRY"


def test_cfd_mode_fails_explicitly_when_the_solver_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    job_id, status = run_simulation(config_for("sedan", mode="cfd"))
    assert status["state"] == "FAILED"
    assert status["error"]["code"] == "CFD_SOLVER_UNAVAILABLE"
    response = client.get(f"/api/simulations/{job_id}/results")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "CFD_SOLVER_UNAVAILABLE"


def test_surrogate_mode_fails_explicitly_when_untrained() -> None:
    _, status = run_simulation(config_for("sedan", mode="ml-surrogate"))
    assert status["state"] == "FAILED" and status["error"]["code"] == "SURROGATE_NOT_TRAINED"
    response = client.post("/api/surrogate/predict", json={"config": config_for("sedan")})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "SURROGATE_NOT_TRAINED"


def test_flow_field_endpoint() -> None:
    job_id, _ = run_simulation(config_for("hatchback", mode="reduced-order"))
    field = client.get(f"/api/simulations/{job_id}/field").json()
    assert field["nx"] * field["ny"] * field["nz"] > 10000
    assert field["symmetric"] is True
    assert "Not a CFD solution" in field["provenance"]


def test_parameter_sweep_job() -> None:
    spec, powertrain = spec_and_powertrain("fastback")
    body = {
        "config": config_for("fastback"),
        "spec": spec,
        "powertrain": powertrain,
        "paramX": "spoilerAngle",
        "valuesX": [0, 10, 20, 30],
        "paramY": None,
        "valuesY": [],
    }
    response = client.post("/api/parameter-sweep", json=body)
    assert response.status_code == 202
    status = wait_for(f"/api/jobs/{response.json()['jobId']}")
    assert status["state"] == "COMPLETE"
    rows = status["result"]["rows"]
    assert [row["x"] for row in rows] == [0, 10, 20, 30]
    assert all(row["valid"] for row in rows)
    lifts = [row["cl"] for row in rows]
    assert lifts == sorted(lifts, reverse=True)  # more spoiler angle, less lift
    assert rows[0]["accel100"] is not None and rows[0]["topSpeed"] > 50
    assert "Mode A" in status["result"]["provenance"]

    body["paramX"] = "notAParameter"
    assert client.post("/api/parameter-sweep", json=body).status_code == 422


def test_design_space_marks_points_that_cannot_be_built() -> None:
    spec, powertrain = spec_and_powertrain("sedan")
    body = {
        "config": config_for("sedan"),
        "spec": spec,
        "powertrain": powertrain,
        "paramX": "hoodLength",
        "valuesX": [1.15, 1.9],
        "paramY": "rearDeckLength",
        "valuesY": [0.55, 1.2],
    }
    status = wait_for(f"/api/jobs/{client.post('/api/parameter-sweep', json=body).json()['jobId']}")
    rows = status["result"]["rows"]
    assert len(rows) == 4
    assert rows[0]["valid"] and rows[0]["cd"] is not None
    impossible = rows[3]
    assert not impossible["valid"] and impossible["cd"] is None and "roof" in impossible["error"].lower()


def test_optimization_job_streams_progress() -> None:
    spec, powertrain = spec_and_powertrain("fastback")
    body = {
        "config": config_for("fastback"),
        "spec": spec,
        "powertrain": powertrain,
        "objective": "max-top-speed",
        "variables": [{"param": "rideHeight", "min": 0.08, "max": 0.2}, {"param": "spoilerAngle", "min": 0, "max": 30}],
        "constraints": [{"metric": "downforce", "op": ">=", "value": -400}],
        "algorithm": "differential-evolution",
        "iterations": 10,
        "seed": 5,
    }
    response = client.post("/api/optimization", json=body)
    assert response.status_code == 202
    status = wait_for(f"/api/jobs/{response.json()['jobId']}")
    assert status["state"] == "COMPLETE"
    assert len(status["partial"]) == 11  # iteration 0 .. 10
    assert status["result"]["best"]["metrics"]["topSpeed"] >= status["result"]["baseline"]["metrics"]["topSpeed"]

    body["variables"] = [{"param": "rideHeight", "min": 0.0, "max": 0.2}]
    assert client.post("/api/optimization", json=body).status_code == 422


def test_surrogate_training_job_then_prediction() -> None:
    body = {
        "config": config_for("fastback"),
        "sourceMode": "analytical",
        "samples": 120,
        "parameters": ["rideHeight", "spoilerAngle", "diffuserAngle"],
        "spread": 0.4,
        "seed": 1,
    }
    response = client.post("/api/surrogate/train", json=body)
    assert response.status_code == 202
    status = wait_for(f"/api/jobs/{response.json()['jobId']}")
    assert status["state"] == "COMPLETE", status
    assert status["result"]["trainingSamples"] == 120
    assert len(client.get("/api/surrogate").json()) == 1
    assert client.get("/api/health").json()["engines"]["ml-surrogate"]["available"]

    prediction = client.post("/api/surrogate/predict", json={"config": config_for("fastback")})
    assert prediction.status_code == 200
    assert prediction.json()["aero"]["mode"] == "ml-surrogate"
    assert prediction.json()["aero"]["surrogate"]["trainingSamples"] == 120


def test_vehicle_library_and_custom_vehicles() -> None:
    vehicles = client.get("/api/vehicles").json()
    assert [vehicle["id"] for vehicle in vehicles[:6]] == ["hatchback", "sedan", "sports-coupe", "suv", "fastback", "generic-ev"]
    # The production-car look-alikes follow the generic classes.
    look_alikes = vehicles[6:]
    assert len(look_alikes) == 17 and all("realCar" in vehicle for vehicle in look_alikes)
    assert not any("realCar" in vehicle for vehicle in vehicles[:6])

    custom = {**get_built_in_vehicle("sedan"), "id": "my-sedan", "name": "My sedan"}
    created = client.post("/api/vehicles", json=custom)
    assert created.status_code == 201 and created.json()["custom"] is True
    assert client.get("/api/vehicles").json()[-1]["id"] == "my-sedan"

    assert client.post("/api/vehicles", json={**custom, "id": "sedan"}).status_code == 409
    assert client.post("/api/vehicles", json={**custom, "id": "Bad Id!"}).status_code == 422
    assert client.post("/api/vehicles", json={**custom, "mass": -5}).status_code == 422


def test_cfd_case_generation_download_and_import() -> None:
    config = config_for("fastback")
    case = client.post("/api/cfd/case", json={"config": config}).json()
    assert "system/controlDict" in case["files"] and case["cellEstimate"] > 100000
    assert isinstance(case["solverAvailable"], bool)
    download = client.get(f"/api/cfd/case/{case['caseId']}/download")
    assert download.status_code == 200 and download.headers["content-type"] == "application/zip"
    assert client.get("/api/cfd/case/..%2F..%2Fsecret/download").status_code == 404

    imported = client.post("/api/cfd/import", json={"config": config, "coefficientFile": coefficient_file()})
    assert imported.status_code == 200
    aero = imported.json()["aero"]
    assert aero["mode"] == "cfd" and "did not run" in aero["provenance"]
    # Imported numbers are never presented as computed by this backend.
    assert aero["source"] == "imported"
    assert aero["coefficients"]["cd"] == pytest.approx(0.3012, abs=2e-3)

    bad = client.post("/api/cfd/import", json={"config": config, "coefficientFile": "not a coefficient file"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "CFD_PARSE_ERROR"
