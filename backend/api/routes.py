"""HTTP API of the AeroLab backend.

    POST /api/simulations                 create a simulation job
    GET  /api/simulations/{id}            job status
    POST /api/simulations/{id}/run        start the job
    GET  /api/simulations/{id}/results    result of a completed job
    GET  /api/simulations/{id}/field      reduced-order flow field for the job's geometry
    POST /api/parameter-sweep             sweep job (1D or 2D)
    POST /api/optimization                optimisation job
    GET  /api/jobs/{id}                   status / result of a sweep, optimisation or training job
    POST /api/surrogate/train             train the ML surrogate (job)
    GET  /api/surrogate                   list trained surrogates
    POST /api/surrogate/predict           predict with the surrogate
    GET  /api/vehicles                    vehicle library
    POST /api/vehicles                    store a custom vehicle
    POST /api/cfd/case                    generate an OpenFOAM case (does not run it)
    GET  /api/cfd/case/{id}/download      download a generated case as zip
    POST /api/cfd/surfaces                store a closed surface (a wrapped 3D model) for Mode C
    POST /api/cfd/import                  import force coefficients from a solver run
    GET  /api/health                      status and engine availability

Everything that computes or stores something needs a signed-in account (api/auth.py); a job can only be
seen by the account that created it. Every simulation is saved as a run of its account. Mode C runs are
limited per account (accounts/limits.py), use the coarse or medium grid only, and wait in a lane of their own.

Errors are returned as {"detail": {"code": ..., "message": ...}}.
"""

from __future__ import annotations

import math
import threading
from typing import Any

import numpy as np
from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse

from accounts import config as settings
from accounts import limits
from accounts.store import User, get_store
from api.auth import require_user
from api.errors import fail

from engines import ml_surrogate
from engines.openfoam import (
    CASES_DIR,
    IMPORT_PROVENANCE,
    OpenFOAMEngine,
    check_run_fidelity,
    plan_case,
    parse_force_coeffs,
    prepare_cfd_case,
    result_from_coefficients,
    solver_availability,
    summarize_force_coeffs,
    zip_case,
)
from engines.reduced_order import solve_reduced_order
from engines.registry import engine_availability, get_engine, simulate
from geometry.surface import store_surface
from geometry.validate import validate_geometry
from models.domain import (
    CfdImportRequest,
    CreateSimulationRequest,
    OptimizationRequest,
    SurrogateTrainRequest,
    SweepRequest,
    VehicleDefinition,
)
from optimization.optimize import run_optimization
from physics.model import MODEL_VERSION
from simulation.assemble import SimulationError, prepare_case
from simulation.hashing import hash_config
from simulation.jobs import Job, jobs
from simulation.sweep import run_sweep
from vehicle.library import all_vehicles, save_custom_vehicle

BACKEND_VERSION = "0.1.0"
router = APIRouter(prefix="/api")


def sanitize(value: Any) -> Any:
    """Makes a result JSON-safe: NumPy scalars become Python numbers, non-finite floats become null."""
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    if isinstance(value, (np.floating, float)):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    return value


def checked_config(config: dict[str, Any]) -> dict[str, Any]:
    """Rejects configurations whose geometry cannot be built, before any job is created."""
    errors = [issue["message"] for issue in validate_geometry(config["geometry"]) if issue["severity"] == "error"]
    if errors:
        raise fail(422, "INVALID_GEOMETRY", " ".join(errors))
    # An absent surface is absent, not null: configurations hash and compare as they did before the field existed.
    if config.get("cfdSurface") is None:
        config.pop("cfdSurface", None)
    else:
        config["cfdSurface"] = {key: value for key, value in config["cfdSurface"].items() if value is not None}
    return config


def require_job(job_id: str, user: User, kind: str | None = None) -> Job:
    job = jobs.get(job_id)
    # Another account's job is reported as missing, not as forbidden: its id says nothing.
    if job is None or job.owner != user.id or (kind is not None and job.kind != kind):
        raise fail(404, "JOB_NOT_FOUND", f'No job with id "{job_id}".')
    return job


def allow_job(user: User) -> None:
    """Applies the per-minute job limit of an account."""
    wait = limits.jobs_by_user.hit(user.id)
    if wait:
        raise fail(
            429,
            "RATE_LIMITED",
            f"Too many jobs in a short time. Try again in {limits.describe_wait(wait)}.",
            headers={"Retry-After": str(math.ceil(wait))},
        )


def no_cfd(config: dict[str, Any], what: str) -> None:
    """Multi-run jobs would make every design point a CFD run."""
    if config["mode"] == "cfd":
        raise fail(422, "CFD_NOT_SUPPORTED", f"{what} cannot use Mode C: every point would be a CFD run. Use Mode A or B.")


#: Checking the Mode C quota and recording the run happen together, so two requests cannot both pass.
_cfd_admission = threading.Lock()


def admit_cfd_run(config: dict[str, Any], user: User) -> None:
    try:
        check_run_fidelity(config)
    except SimulationError as error:
        raise fail(422, error.code, error.message) from error
    # A full queue is checked first: refusing for that reason does not use any of the account's quota.
    active = jobs.active("cfd")
    if active >= settings.cfd_queue_limit():
        raise fail(
            503,
            "CFD_QUEUE_FULL",
            f"The CFD queue is full ({active} runs are waiting or running). Try again in a few minutes; "
            "this did not count towards your CFD runs.",
            headers={"Retry-After": "120"},
        )
    quota = limits.cfd_quota(get_store(), user.id)
    if quota.retry_after_s > 0:
        raise fail(
            429,
            "CFD_RATE_LIMITED",
            f"An account can start {quota.limit} CFD runs every {quota.window_s / 60:g} minutes. "
            f"The next one can start in {limits.describe_wait(quota.retry_after_s)}. Nothing was computed.",
            headers={"Retry-After": str(math.ceil(quota.retry_after_s))},
        )


@router.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "version": BACKEND_VERSION, "modelVersion": MODEL_VERSION, "engines": engine_availability()}


# ---------------------------------------------------------------------------
# Simulations
# ---------------------------------------------------------------------------


@router.post("/simulations", status_code=201)
def create_simulation(request: CreateSimulationRequest, user: User = Depends(require_user)) -> dict[str, Any]:
    config = checked_config(request.config.model_dump())
    cfd = config["mode"] == "cfd"
    with _cfd_admission:
        if cfd:
            admit_cfd_run(config, user)
        allow_job(user)
        job = jobs.create("simulation", payload=config, owner=user.id, lane="cfd" if cfd else "default")
        get_store().create_run(job.id, user.id, config)
    return {"id": job.id, "state": job.state, "hash": hash_config(config)}


def record_run(job: Job) -> None:
    """Saves the outcome of a simulation job with the account's run."""
    result = sanitize(job.result) if job.state == "COMPLETE" else None
    get_store().finish_run(job.id, job.state, result, job.error)


@router.post("/simulations/{job_id}/run")
def run_simulation(job_id: str, user: User = Depends(require_user)) -> dict[str, Any]:
    job = require_job(job_id, user, "simulation")
    jobs.start(job, lambda running: simulate(running.payload, jobs.reporter(running)), on_finish=record_run)
    return {"id": job.id, "state": job.state}


@router.get("/simulations/{job_id}")
def simulation_status(job_id: str, user: User = Depends(require_user)) -> dict[str, Any]:
    return sanitize(require_job(job_id, user, "simulation").status(include_result=False))


@router.get("/simulations/{job_id}/results")
def simulation_results(job_id: str, user: User = Depends(require_user)) -> dict[str, Any]:
    job = require_job(job_id, user, "simulation")
    if job.state == "FAILED" and job.error:
        raise fail(409, job.error["code"], job.error["message"])
    if job.state != "COMPLETE":
        raise fail(409, "NOT_COMPLETE", f"The simulation is {job.state}; results are available once it is COMPLETE.")
    return sanitize(job.result)


@router.get("/simulations/{job_id}/field")
def simulation_field(job_id: str, user: User = Depends(require_user)) -> dict[str, Any]:
    """Reduced-order flow field for the job's geometry and yaw angle (for visualisation)."""
    job = require_job(job_id, user, "simulation")
    try:
        prepared = prepare_case(job.payload)
        solved = solve_reduced_order(prepared.shape, prepared.metrics, prepared.flow, job.payload["fidelity"], build_field=True)
    except SimulationError as error:
        raise fail(422, error.code, error.message) from error
    return sanitize(solved.field)


# ---------------------------------------------------------------------------
# Multi-run jobs
# ---------------------------------------------------------------------------


@router.get("/jobs/{job_id}")
def job_status(job_id: str, user: User = Depends(require_user)) -> dict[str, Any]:
    return sanitize(require_job(job_id, user).status())


@router.post("/parameter-sweep", status_code=202)
def parameter_sweep(request: SweepRequest, user: User = Depends(require_user)) -> dict[str, str]:
    payload = request.model_dump()
    checked_config(payload["config"])
    no_cfd(payload["config"], "A parameter sweep")
    allow_job(user)
    job = jobs.create("sweep", payload=payload, owner=user.id)

    def task(running: Job) -> dict[str, Any]:
        return run_sweep(
            running.payload,
            lambda done, total: jobs.update(running, "SOLVING", done / total, f"Point {done} of {total}"),
        )

    jobs.start(job, task)
    return {"jobId": job.id}


@router.post("/optimization", status_code=202)
def optimization(request: OptimizationRequest, user: User = Depends(require_user)) -> dict[str, str]:
    payload = request.model_dump()
    checked_config(payload["config"])
    no_cfd(payload["config"], "An optimisation")
    allow_job(user)
    job = jobs.create("optimization", payload=payload, owner=user.id)
    iterations = payload["iterations"]

    def task(running: Job) -> dict[str, Any]:
        def on_progress(history: list[dict[str, Any]]) -> None:
            running.partial = history
            step = history[-1]["iteration"]
            jobs.update(running, "SOLVING", step / iterations, f"Iteration {step} of {iterations}")

        return run_optimization(running.payload, on_progress)

    jobs.start(job, task)
    return {"jobId": job.id}


# ---------------------------------------------------------------------------
# ML surrogate
# ---------------------------------------------------------------------------


@router.get("/surrogate")
def surrogate_models() -> list[dict[str, Any]]:
    return sanitize(ml_surrogate.list_models())


@router.post("/surrogate/train", status_code=202)
def surrogate_train(request: SurrogateTrainRequest, user: User = Depends(require_user)) -> dict[str, str]:
    payload = request.model_dump()
    checked_config(payload["config"])
    allow_job(user)
    job = jobs.create("surrogate-training", payload=payload, owner=user.id)
    jobs.start(job, lambda running: ml_surrogate.train(running.payload, get_engine(running.payload["sourceMode"]), jobs.reporter(running)))
    return {"jobId": job.id}


@router.post("/surrogate/predict")
def surrogate_predict(request: CreateSimulationRequest, _user: User = Depends(require_user)) -> dict[str, Any]:
    config = {**checked_config(request.config.model_dump()), "mode": "ml-surrogate"}
    try:
        return sanitize(simulate(config))
    except SimulationError as error:
        raise fail(409 if error.code == "SURROGATE_NOT_TRAINED" else 422, error.code, error.message) from error


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------


@router.get("/vehicles")
def vehicles() -> list[dict[str, Any]]:
    return all_vehicles()


@router.post("/vehicles", status_code=201)
def create_vehicle(vehicle: VehicleDefinition, _user: User = Depends(require_user)) -> dict[str, Any]:
    data = vehicle.model_dump()
    errors = [issue["message"] for issue in validate_geometry(data["geometry"]) if issue["severity"] == "error"]
    if errors:
        raise fail(422, "INVALID_GEOMETRY", " ".join(errors))
    if any(existing["id"] == data["id"] and not existing.get("custom") for existing in all_vehicles()):
        raise fail(409, "VEHICLE_ID_TAKEN", "A built-in vehicle already uses this id.")
    return save_custom_vehicle(data)


# ---------------------------------------------------------------------------
# CFD
# ---------------------------------------------------------------------------


@router.post("/cfd/case")
def cfd_case(request: CreateSimulationRequest, _user: User = Depends(require_user)) -> dict[str, Any]:
    """Generates the complete OpenFOAM case for a configuration. The solver is not run."""
    config = {**checked_config(request.config.model_dump()), "mode": "cfd"}
    engine = OpenFOAMEngine()
    try:
        case_dir, files, prepared = engine.prepare_case_files(config)
    except SimulationError as error:
        raise fail(422, error.code, error.message) from error
    zip_case(case_dir)
    available, detail = solver_availability()
    plan = plan_case(config, prepared)
    return {
        "caseId": case_dir.name,
        "path": str(case_dir),
        "files": files,
        "solverAvailable": available,
        "solverDetail": detail,
        "meshSetting": plan.fidelity,
        "cellEstimate": plan.cell_estimate,
        "iterations": plan.settings.iterations,
        "processors": plan.processors,
        "prismLayers": plan.settings.layers,
    }


@router.post("/cfd/surfaces", status_code=201)
async def cfd_surface(request: Request, _user: User = Depends(require_user)) -> dict[str, Any]:
    """Stores a closed surface for Mode C: the request body is 9 little-endian float32 values per triangle."""
    try:
        return store_surface(await request.body()).to_json()
    except SimulationError as error:
        raise fail(422, error.code, error.message) from error


@router.get("/cfd/case/{case_id}/download")
def cfd_case_download(case_id: str, _user: User = Depends(require_user)) -> FileResponse:
    archive = (CASES_DIR / f"{case_id}.zip").resolve()
    # Only archives directly inside the case directory may be served.
    if archive.parent != CASES_DIR.resolve() or not archive.is_file():
        raise fail(404, "CASE_NOT_FOUND", "No generated case with this id.")
    return FileResponse(archive, media_type="application/zip", filename=archive.name)


@router.post("/cfd/import")
def cfd_import(request: CfdImportRequest, _user: User = Depends(require_user)) -> dict[str, Any]:
    """Builds a Mode C result from force coefficients produced by a solver run elsewhere."""
    config = {**checked_config(request.config.model_dump()), "mode": "cfd"}
    try:
        prepared = prepare_cfd_case(config)
        summary = summarize_force_coeffs(parse_force_coeffs(request.coefficientFile))
        aero = result_from_coefficients(config, prepared, summary, IMPORT_PROVENANCE, source="imported")
    except SimulationError as error:
        raise fail(422, error.code, error.message) from error
    return sanitize({"hash": hash_config(config), "config": config, "aero": aero, "durationMs": 0.0, "cached": False})
