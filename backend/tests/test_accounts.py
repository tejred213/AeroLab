"""Accounts, saved runs, usage limits, retention and the origin check."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import engines.openfoam as openfoam
import geometry.surface as surface_module
from accounts.cleanup import purge
from accounts.store import get_store
from api.auth import SESSION_COOKIE
from main import app
from simulation.jobs import jobs
from tests.helpers import TEST_PASSWORD, config_for, sign_in, spec_and_powertrain
from tests.test_api import client, run_simulation, wait_for

DAY = 86400.0


def anonymous() -> TestClient:
    return TestClient(app)


def cfd_config(fidelity: str = "coarse") -> dict:
    return {**config_for("fastback", mode="cfd"), "fidelity": fidelity}


# ---------------------------------------------------------------------------
# Signing up, in and out
# ---------------------------------------------------------------------------


def test_an_account_is_created_signed_in_and_out() -> None:
    browser = anonymous()
    assert browser.get("/api/auth/me").json()["user"] is None

    created = browser.post("/api/auth/register", json={"email": " Ada@Example.com ", "password": "long enough", "name": "Ada"})
    assert created.status_code == 201, created.text
    assert created.json()["user"]["email"] == "ada@example.com"
    cookie = created.headers["set-cookie"].lower()
    assert SESSION_COOKIE in cookie and "httponly" in cookie and "samesite=lax" in cookie
    me = browser.get("/api/auth/me").json()
    assert me["user"]["name"] == "Ada" and me["cfdQuota"] == {"limit": 2, "windowMinutes": 10, "used": 0, "retryAfterS": 0}
    assert me["retentionDays"] == 10

    browser.post("/api/auth/logout")
    assert browser.get("/api/auth/me").json()["user"] is None
    # The old token no longer works even if a client kept it.
    signed_in = browser.post("/api/auth/login", json={"email": "ADA@example.com", "password": "long enough"})
    assert signed_in.status_code == 200 and signed_in.json()["user"]["email"] == "ada@example.com"


def test_sign_up_and_sign_in_refuse_bad_input() -> None:
    browser = anonymous()
    assert browser.post("/api/auth/register", json={"email": "no-at-sign", "password": "long enough"}).json()["detail"]["code"] == "INVALID_EMAIL"
    assert browser.post("/api/auth/register", json={"email": "a@b.co", "password": "short"}).status_code == 422
    assert browser.post("/api/auth/register", json={"email": "a@b.co", "password": "long enough"}).status_code == 201
    taken = anonymous().post("/api/auth/register", json={"email": "A@B.co", "password": "another one"})
    assert taken.status_code == 409 and taken.json()["detail"]["code"] == "EMAIL_TAKEN"
    wrong = anonymous().post("/api/auth/login", json={"email": "a@b.co", "password": "not the password"})
    unknown = anonymous().post("/api/auth/login", json={"email": "nobody@b.co", "password": "long enough"})
    # Wrong password and unknown email look the same.
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()


def test_guessing_passwords_is_rate_limited() -> None:
    anonymous().post("/api/auth/register", json={"email": "target@example.com", "password": "long enough"})
    codes = [anonymous().post("/api/auth/login", json={"email": "target@example.com", "password": f"guess {i}"}).status_code for i in range(9)]
    assert codes[:8] == [401] * 8
    assert codes[8] == 429
    refused = anonymous().post("/api/auth/login", json={"email": "target@example.com", "password": "long enough"})
    assert refused.status_code == 429 and int(refused.headers["retry-after"]) > 0


def test_deleting_an_account_needs_its_password_and_removes_its_runs() -> None:
    browser = anonymous()
    user = sign_in(browser)
    created = browser.post("/api/simulations", json={"config": config_for("fastback", mode="analytical")})
    assert created.status_code == 201
    assert browser.post("/api/auth/account/delete", json={"password": "wrong"}).status_code == 401
    assert browser.post("/api/auth/account/delete", json={"password": TEST_PASSWORD}).status_code == 200
    assert browser.get("/api/auth/me").json()["user"] is None
    assert get_store().runs_of(user.id) == []


# ---------------------------------------------------------------------------
# What needs an account
# ---------------------------------------------------------------------------


def test_computing_needs_an_account_but_reading_the_library_does_not() -> None:
    browser = anonymous()
    assert browser.get("/api/health").status_code == 200
    assert browser.get("/api/vehicles").status_code == 200
    refused = browser.post("/api/simulations", json={"config": config_for("fastback", mode="analytical")})
    assert refused.status_code == 401 and refused.json()["detail"]["code"] == "AUTH_REQUIRED"
    for path in ("/api/cfd/case", "/api/surrogate/predict"):
        assert browser.post(path, json={"config": config_for("fastback", mode="cfd")}).status_code == 401
    assert browser.get("/api/runs").status_code == 401


def test_a_job_is_visible_only_to_the_account_that_created_it() -> None:
    job_id, status = run_simulation(config_for("sedan", mode="analytical"))
    assert status["state"] == "COMPLETE"
    other = anonymous()
    sign_in(other)
    for path in (f"/api/simulations/{job_id}", f"/api/simulations/{job_id}/results", f"/api/jobs/{job_id}"):
        assert other.get(path).status_code == 404
    assert other.post(f"/api/simulations/{job_id}/run").status_code == 404
    assert other.get(f"/api/runs/{job_id}").status_code == 404


# ---------------------------------------------------------------------------
# Saved runs
# ---------------------------------------------------------------------------


def test_every_backend_simulation_is_saved_as_a_run() -> None:
    job_id, _ = run_simulation(config_for("hatchback", mode="reduced-order"))
    listed = client.get("/api/runs").json()
    assert [run["id"] for run in listed] == [job_id]
    run = listed[0]
    assert run["state"] == "COMPLETE" and run["mode"] == "reduced-order" and run["vehicleId"] == "hatchback"
    assert run["expiresAt"] == pytest.approx(run["createdAt"] + 10 * DAY)
    assert 0.2 < run["coefficients"]["cd"] < 0.4
    detail = client.get(f"/api/runs/{job_id}").json()
    assert detail["config"]["mode"] == "reduced-order"
    assert detail["result"]["aero"]["coefficients"] == run["coefficients"]

    assert client.delete(f"/api/runs/{job_id}").json() == {"deleted": True}
    assert client.get("/api/runs").json() == []
    assert client.delete(f"/api/runs/{job_id}").status_code == 404


def test_a_failed_run_is_saved_with_its_error() -> None:
    # No OpenFOAM in the tests: the run fails, and says why.
    job_id, status = run_simulation(cfd_config())
    assert status["state"] == "FAILED"
    run = client.get(f"/api/runs/{job_id}").json()
    assert run["state"] == "FAILED" and run["error"]["code"] == "CFD_SOLVER_UNAVAILABLE" and run["result"] is None


def test_runs_cut_off_by_a_restart_are_marked_failed() -> None:
    # Created but never started: after a restart its job would be gone.
    created = client.post("/api/simulations", json={"config": config_for("fastback", mode="analytical")}).json()
    assert get_store().fail_unfinished("SERVER_RESTARTED", "restarted") == 1
    run = client.get(f"/api/runs/{created['id']}").json()
    assert run["state"] == "FAILED" and run["error"]["code"] == "SERVER_RESTARTED"


# ---------------------------------------------------------------------------
# Mode C limits
# ---------------------------------------------------------------------------


def test_mode_c_runs_are_limited_per_account_and_window(monkeypatch: pytest.MonkeyPatch) -> None:
    for _ in range(2):
        assert client.post("/api/simulations", json={"config": cfd_config()}).status_code == 201
    refused = client.post("/api/simulations", json={"config": cfd_config("medium")})
    assert refused.status_code == 429
    detail = refused.json()["detail"]
    assert detail["code"] == "CFD_RATE_LIMITED" and "2 CFD runs every 10 minutes" in detail["message"]
    assert 590 <= int(refused.headers["retry-after"]) <= 600
    quota = client.get("/api/auth/me").json()["cfdQuota"]
    assert quota["used"] == 2 and quota["retryAfterS"] > 0

    # Other modes, and other accounts, are not affected.
    assert client.post("/api/simulations", json={"config": config_for("fastback", mode="analytical")}).status_code == 201
    other = anonymous()
    sign_in(other)
    assert other.post("/api/simulations", json={"config": cfd_config()}).status_code == 201

    # Once the window has passed, the account can start CFD runs again.
    real_time = time.time
    monkeypatch.setattr(time, "time", lambda: real_time() + 601)
    assert client.post("/api/simulations", json={"config": cfd_config()}).status_code == 201


def test_the_limit_is_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AEROLAB_CFD_RUNS_PER_WINDOW", "1")
    monkeypatch.setenv("AEROLAB_CFD_WINDOW_MINUTES", "30")
    assert client.post("/api/simulations", json={"config": cfd_config()}).status_code == 201
    refused = client.post("/api/simulations", json={"config": cfd_config()})
    assert refused.status_code == 429 and "1 CFD runs every 30 minutes" in refused.json()["detail"]["message"]


def test_mode_c_runs_on_the_coarse_and_medium_grids_only() -> None:
    refused = client.post("/api/simulations", json={"config": cfd_config("fine")})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "CFD_FIDELITY_NOT_OFFERED"
    # A refused request does not use the quota.
    assert client.get("/api/auth/me").json()["cfdQuota"]["used"] == 0
    # A fine case can still be generated, to run elsewhere.
    assert client.post("/api/cfd/case", json={"config": cfd_config("fine")}).json()["meshSetting"] == "fine"
    # And Modes A and B keep their fine grid.
    assert client.post("/api/simulations", json={"config": {**config_for("fastback", mode="reduced-order"), "fidelity": "fine"}}).status_code == 201


def test_the_engine_refuses_a_fine_mode_c_run_too() -> None:
    from simulation.assemble import SimulationError

    with pytest.raises(SimulationError) as refused:
        openfoam.OpenFOAMEngine().simulate(cfd_config("fine"))
    assert refused.value.code == "CFD_FIDELITY_NOT_OFFERED"


def test_a_full_cfd_queue_refuses_without_using_the_quota(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "active", lambda lane: 4 if lane == "cfd" else 0)
    refused = client.post("/api/simulations", json={"config": cfd_config()})
    assert refused.status_code == 503 and refused.json()["detail"]["code"] == "CFD_QUEUE_FULL"
    assert client.get("/api/auth/me").json()["cfdQuota"]["used"] == 0


def test_sweeps_and_optimisation_cannot_use_mode_c() -> None:
    spec, powertrain = spec_and_powertrain("fastback")
    sweep = {"config": cfd_config(), "spec": spec, "powertrain": powertrain, "paramX": "rideHeight", "valuesX": [0.12, 0.14]}
    refused = client.post("/api/parameter-sweep", json=sweep)
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "CFD_NOT_SUPPORTED"
    optimisation = {
        "config": cfd_config(),
        "spec": spec,
        "powertrain": powertrain,
        "objective": "min-drag",
        "variables": [{"param": "rideHeight", "min": 0.12, "max": 0.16}],
        "algorithm": "bayesian",
        "iterations": 5,
        "seed": 1,
    }
    assert client.post("/api/optimization", json=optimisation).json()["detail"]["code"] == "CFD_NOT_SUPPORTED"


def test_cfd_runs_wait_in_a_lane_of_their_own() -> None:
    created = client.post("/api/simulations", json={"config": cfd_config()}).json()
    assert jobs.get(created["id"]).lane == "cfd"
    client.post(f"/api/simulations/{created['id']}/run")
    assert wait_for(f"/api/simulations/{created['id']}")["state"] == "FAILED"
    analytical = client.post("/api/simulations", json={"config": config_for("fastback", mode="analytical")}).json()
    assert jobs.get(analytical["id"]).lane == "default"


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------


def test_runs_and_files_are_deleted_after_the_retention_period(tmp_path: Path) -> None:
    job_id, _ = run_simulation(config_for("fastback", mode="analytical"))
    old_case = openfoam.CASES_DIR / "case-old"
    new_case = openfoam.CASES_DIR / "case-new"
    for case in (old_case, new_case):
        (case / "system").mkdir(parents=True)
    (openfoam.CASES_DIR / "case-old.zip").write_bytes(b"zip")
    surface_module.SURFACE_DIR.mkdir(parents=True, exist_ok=True)
    old_surface = surface_module.SURFACE_DIR / "abc.f32"
    old_surface.write_bytes(b"\0" * 36)
    eleven_days_ago = time.time() - 11 * DAY
    for path in (old_case, openfoam.CASES_DIR / "case-old.zip", old_surface):
        os.utime(path, (eleven_days_ago, eleven_days_ago))

    # Within the retention period nothing of the run is touched.
    assert purge() == {"runs": 0, "caseEntries": 2, "surfaceFiles": 1}
    assert not old_case.exists() and not old_surface.exists() and new_case.exists()
    assert len(client.get("/api/runs").json()) == 1

    # Ten days after it was created, the run is gone.
    assert purge(now=time.time() + 10 * DAY + 1)["runs"] == 1
    assert client.get("/api/runs").json() == []
    assert client.get(f"/api/runs/{job_id}").status_code == 404


# ---------------------------------------------------------------------------
# Origins
# ---------------------------------------------------------------------------


def test_requests_from_other_sites_are_refused() -> None:
    body = {"config": config_for("fastback", mode="analytical")}
    foreign = client.post("/api/simulations", json=body, headers={"Origin": "https://evil.example"})
    assert foreign.status_code == 403 and foreign.json()["detail"]["code"] == "ORIGIN_NOT_ALLOWED"
    assert client.post("/api/simulations", json=body, headers={"Origin": "http://localhost:3000"}).status_code == 201

    preflight = client.options(
        "/api/simulations",
        headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"},
    )
    assert preflight.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert preflight.headers["access-control-allow-credentials"] == "true"
    refused = client.options(
        "/api/simulations", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert "access-control-allow-origin" not in refused.headers


def test_a_result_from_the_cache_uses_no_mode_c_quota() -> None:
    created = client.post("/api/simulations", json={"config": cfd_config()}).json()
    # As if the result of an identical configuration had been served from the result cache.
    get_store().finish_run(created["id"], "COMPLETE", {"cached": True, "aero": {"coefficients": {"cd": 0.3, "cl": 0.0}}})
    assert client.get("/api/auth/me").json()["cfdQuota"]["used"] == 0
    assert client.get("/api/runs").json()[0]["cached"] is True


def test_sign_in_limits_use_the_proxy_s_client_address_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AEROLAB_CLIENT_IP_HEADER", "fly-client-ip")
    # 5 accounts per address and hour: a sixth from the same visitor is refused, one from another is not.
    for i in range(5):
        assert anonymous().post("/api/auth/register", json={"email": f"u{i}@example.com", "password": "long enough"}, headers={"Fly-Client-IP": "203.0.113.7"}).status_code == 201
    assert anonymous().post("/api/auth/register", json={"email": "u5@example.com", "password": "long enough"}, headers={"Fly-Client-IP": "203.0.113.7"}).status_code == 429
    assert anonymous().post("/api/auth/register", json={"email": "u6@example.com", "password": "long enough"}, headers={"Fly-Client-IP": "198.51.100.2"}).status_code == 201
