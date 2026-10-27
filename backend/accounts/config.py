"""Deployment settings of the backend, read from the environment each time they are needed.

    AEROLAB_ALLOWED_ORIGINS        comma-separated origins of the frontend (CORS and the origin check)
    AEROLAB_COOKIE_SECURE          1 (default) sends the session cookie over HTTPS only; 0 for local http
    AEROLAB_COOKIE_SAMESITE        lax (default), strict or none (none needs a secure cookie)
    AEROLAB_SESSION_DAYS           how long a sign-in lasts (default 30)
    AEROLAB_CFD_RUNS_PER_WINDOW    Mode C runs one account may start per window (default 2)
    AEROLAB_CFD_WINDOW_MINUTES     length of that window (default 10)
    AEROLAB_CFD_QUEUE_LIMIT        Mode C runs that may wait or run at once, all accounts together (default 4)
    AEROLAB_RUN_RETENTION_DAYS     days after which a run, its case files and uploaded surfaces are deleted (default 10)
    AEROLAB_DB                     path of the SQLite database (default backend/data/aerolab.sqlite3)
    AEROLAB_CLIENT_IP_HEADER       request header holding the visitor's address when a proxy sets it
                                   (fly-client-ip on Fly.io); unset uses the connection's address
"""

from __future__ import annotations

import os
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DEFAULT_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")


def _number(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def allowed_origins() -> list[str]:
    raw = os.environ.get("AEROLAB_ALLOWED_ORIGINS", "")
    origins = [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]
    return origins or list(DEFAULT_ORIGINS)


def cookie_secure() -> bool:
    return os.environ.get("AEROLAB_COOKIE_SECURE", "1").strip().lower() not in ("0", "false", "no")


def cookie_samesite() -> str:
    value = os.environ.get("AEROLAB_COOKIE_SAMESITE", "lax").strip().lower()
    return value if value in ("lax", "strict", "none") else "lax"


def session_seconds() -> float:
    return _number("AEROLAB_SESSION_DAYS", 30) * 86400


def cfd_runs_per_window() -> int:
    return max(int(_number("AEROLAB_CFD_RUNS_PER_WINDOW", 2)), 1)


def cfd_window_seconds() -> float:
    return max(_number("AEROLAB_CFD_WINDOW_MINUTES", 10), 1) * 60


def cfd_queue_limit() -> int:
    return max(int(_number("AEROLAB_CFD_QUEUE_LIMIT", 4)), 1)


def retention_seconds() -> float:
    return max(_number("AEROLAB_RUN_RETENTION_DAYS", 10), 0.01) * 86400


def client_ip_header() -> str:
    return os.environ.get("AEROLAB_CLIENT_IP_HEADER", "").strip().lower()


def database_path() -> Path:
    return Path(os.environ.get("AEROLAB_DB", DATA_DIR / "aerolab.sqlite3"))
