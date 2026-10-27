"""Accounts and saved runs.

    POST /api/auth/register               create an account and sign in
    POST /api/auth/login                  sign in
    POST /api/auth/logout                 sign out
    GET  /api/auth/me                     the signed-in account (or null), its Mode C quota and the retention period
    POST /api/auth/account/delete         delete the account and its runs (password required)
    GET  /api/runs                        the account's runs, newest first
    GET  /api/runs/{id}                   one run with its configuration and result
    DELETE /api/runs/{id}                 delete a run

The session is an HttpOnly cookie; the frontend sends it with `credentials: "include"`.
"""

from __future__ import annotations

import math
import re
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field

from accounts import config, limits
from accounts.passwords import DUMMY_HASH, hash_password, verify_password
from accounts.store import FINAL_STATES, EmailTaken, User, get_store
from api.errors import fail
from models.domain import StrictModel
from simulation.jobs import jobs

SESSION_COOKIE = "aerolab_session"
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

router = APIRouter(prefix="/api")


class RegisterRequest(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)
    name: str = Field(default="", max_length=80)


class LoginRequest(StrictModel):
    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class PasswordRequest(StrictModel):
    password: str = Field(min_length=1, max_length=256)


def _address(request: Request) -> str:
    # Behind a proxy that sets it (Fly.io's edge sets Fly-Client-IP), the visitor's own address. Only trust
    # such a header when nothing but that proxy can reach the backend.
    header = config.client_ip_header()
    forwarded = request.headers.get(header, "").strip() if header else ""
    if forwarded:
        return forwarded
    return request.client.host if request.client else "unknown"


def _too_many(wait_s: float, what: str) -> Exception:
    return fail(
        429,
        "RATE_LIMITED",
        f"Too many {what}. Try again in {limits.describe_wait(wait_s)}.",
        headers={"Retry-After": str(math.ceil(wait_s))},
    )


def current_user(request: Request) -> User | None:
    token = request.cookies.get(SESSION_COOKIE)
    return get_store().user_for_session(token) if token else None


def require_user(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise fail(401, "AUTH_REQUIRED", "Sign in to use the backend: runs on it are saved to your account.")
    return user


def _start_session(response: Response, user: User) -> None:
    token = get_store().create_session(user.id)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(config.session_seconds()),
        httponly=True,
        secure=config.cookie_secure(),
        samesite=config.cookie_samesite(),  # type: ignore[arg-type]
        path="/",
    )


def _me(user: User | None) -> dict[str, Any]:
    retention_days = config.retention_seconds() / 86400
    if user is None:
        return {"user": None, "cfdQuota": None, "retentionDays": retention_days}
    return {
        "user": user.to_json(),
        "cfdQuota": limits.cfd_quota(get_store(), user.id).to_json(),
        "retentionDays": retention_days,
    }


@router.post("/auth/register", status_code=201)
def register(body: RegisterRequest, request: Request, response: Response) -> dict[str, Any]:
    email = body.email.strip().lower()
    if not EMAIL_PATTERN.match(email):
        raise fail(422, "INVALID_EMAIL", "Enter a valid email address.")
    wait = limits.signups_by_address.hit(_address(request))
    if wait:
        raise _too_many(wait, "new accounts from this address")
    try:
        user = get_store().create_user(email, body.name.strip(), hash_password(body.password))
    except EmailTaken as error:
        raise fail(409, "EMAIL_TAKEN", "An account with this email address exists already. Sign in instead.") from error
    _start_session(response, user)
    return _me(user)


@router.post("/auth/login")
def login(body: LoginRequest, request: Request, response: Response) -> dict[str, Any]:
    email = body.email.strip().lower()
    wait = max(limits.login_by_address.hit(_address(request)), limits.login_by_email.hit(email))
    if wait:
        raise _too_many(wait, "sign-in attempts")
    found = get_store().credentials(email)
    # An unknown email costs the same hashing work as a wrong password.
    valid = verify_password(body.password, found[1] if found else DUMMY_HASH)
    if found is None or not valid:
        raise fail(401, "INVALID_CREDENTIALS", "The email address or the password is not correct.")
    _start_session(response, found[0])
    return _me(found[0])


@router.post("/auth/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        get_store().delete_session(token)
    response.delete_cookie(SESSION_COOKIE, path="/", secure=config.cookie_secure(), samesite=config.cookie_samesite())  # type: ignore[arg-type]
    return _me(None)


@router.get("/auth/me")
def me(user: User | None = Depends(current_user)) -> dict[str, Any]:
    return _me(user)


@router.post("/auth/account/delete")
def delete_account(body: PasswordRequest, response: Response, user: User = Depends(require_user)) -> dict[str, Any]:
    stored = get_store().password_hash(user.id)
    if stored is None or not verify_password(body.password, stored):
        raise fail(401, "INVALID_CREDENTIALS", "The password is not correct.")
    # Sessions and runs go with the account (foreign keys); case files expire with the retention period.
    get_store().delete_user(user.id)
    response.delete_cookie(SESSION_COOKIE, path="/", secure=config.cookie_secure(), samesite=config.cookie_samesite())  # type: ignore[arg-type]
    return _me(None)


# ---------------------------------------------------------------------------
# Saved runs
# ---------------------------------------------------------------------------


def _live(run: dict[str, Any]) -> dict[str, Any]:
    """A run that has not finished shows the state of its job, if the job is still known."""
    if run["state"] in FINAL_STATES:
        return {**run, "progress": 1.0 if run["state"] == "COMPLETE" else 0.0, "message": run["state"].capitalize()}
    job = jobs.get(run["id"])
    if job is None:
        return {**run, "progress": 0.0, "message": "Waiting"}
    return {**run, "state": job.state, "progress": job.progress, "message": job.message}


@router.get("/runs")
def list_runs(user: User = Depends(require_user)) -> list[dict[str, Any]]:
    return [_live(run) for run in get_store().runs_of(user.id)]


@router.get("/runs/{run_id}")
def get_run(run_id: str, user: User = Depends(require_user)) -> dict[str, Any]:
    run = get_store().run_of(user.id, run_id)
    if run is None:
        raise fail(404, "RUN_NOT_FOUND", "No saved run with this id (runs are deleted after the retention period).")
    return _live(run)


@router.delete("/runs/{run_id}")
def delete_run(run_id: str, user: User = Depends(require_user)) -> dict[str, bool]:
    if not get_store().delete_run(user.id, run_id):
        raise fail(404, "RUN_NOT_FOUND", "No saved run with this id.")
    return {"deleted": True}
