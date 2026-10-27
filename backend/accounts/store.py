"""Accounts, sign-in sessions and saved runs, kept in one SQLite database.

A session token is given to the browser once (in a cookie); only its SHA-256 is stored. A run is the
record of one backend simulation of an account: its configuration, state and result. Runs are deleted
`retention_seconds()` after they were created (see accounts/cleanup.py).
"""

from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from accounts import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  REAL NOT NULL,
    expires_at  REAL NOT NULL,
    mode        TEXT NOT NULL,
    fidelity    TEXT NOT NULL,
    vehicle_id  TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL,
    config      TEXT NOT NULL,
    result      TEXT,
    error       TEXT,
    finished_at REAL,
    -- 1 when the result came from the result cache: nothing was computed, so it uses no Mode C quota.
    cached      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_by_user ON runs (user_id, created_at);
"""

FINAL_STATES = ("COMPLETE", "FAILED")


class EmailTaken(Exception):
    pass


@dataclass(frozen=True)
class User:
    id: str
    email: str
    name: str
    created_at: float

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "email": self.email, "name": self.name, "createdAt": self.created_at}


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _user(row: sqlite3.Row) -> User:
    return User(id=row["id"], email=row["email"], name=row["name"], created_at=row["created_at"])


def _summary(row: sqlite3.Row) -> dict[str, Any]:
    """A run as listed: what it was and what came out, without the full result."""
    result = json.loads(row["result"]) if row["result"] else None
    aero = (result or {}).get("aero") or {}
    cfd = aero.get("cfd") or {}
    return {
        "id": row["id"],
        "createdAt": row["created_at"],
        "expiresAt": row["expires_at"],
        "finishedAt": row["finished_at"],
        "mode": row["mode"],
        "fidelity": row["fidelity"],
        "vehicleId": row["vehicle_id"],
        "state": row["state"],
        "error": json.loads(row["error"]) if row["error"] else None,
        "cached": bool(row["cached"]),
        "coefficients": aero.get("coefficients"),
        "cells": cfd.get("cells"),
        "wallTimeS": cfd.get("wallTimeS"),
    }


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.executescript(SCHEMA)
        columns = {row["name"] for row in self._db.execute("PRAGMA table_info(runs)")}
        if "cached" not in columns:  # databases made before the column existed
            self._db.execute("ALTER TABLE runs ADD COLUMN cached INTEGER NOT NULL DEFAULT 0")

    def _execute(self, sql: str, args: tuple[Any, ...] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self._db.execute(sql, args)

    def _all(self, sql: str, args: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    def _one(self, sql: str, args: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._db.execute(sql, args).fetchone()

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # -- users ----------------------------------------------------------------

    def create_user(self, email: str, name: str, password_hash: str) -> User:
        user = User(id=uuid.uuid4().hex, email=email, name=name, created_at=time.time())
        try:
            self._execute(
                "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                (user.id, user.email, user.name, password_hash, user.created_at),
            )
        except sqlite3.IntegrityError as error:
            raise EmailTaken(email) from error
        return user

    def credentials(self, email: str) -> tuple[User, str] | None:
        row = self._one("SELECT * FROM users WHERE email = ?", (email,))
        return (_user(row), row["password_hash"]) if row else None

    def password_hash(self, user_id: str) -> str | None:
        row = self._one("SELECT password_hash FROM users WHERE id = ?", (user_id,))
        return row["password_hash"] if row else None

    def delete_user(self, user_id: str) -> None:
        self._execute("DELETE FROM users WHERE id = ?", (user_id,))

    # -- sessions -------------------------------------------------------------

    def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        self._execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_token_hash(token), user_id, now, now + config.session_seconds()),
        )
        return token

    def user_for_session(self, token: str) -> User | None:
        row = self._one(
            "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id "
            "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
            (_token_hash(token), time.time()),
        )
        return _user(row) if row else None

    def delete_session(self, token: str) -> None:
        self._execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))

    # -- runs -----------------------------------------------------------------

    def create_run(self, run_id: str, user_id: str, run_config: dict[str, Any]) -> None:
        now = time.time()
        self._execute(
            "INSERT INTO runs (id, user_id, created_at, expires_at, mode, fidelity, vehicle_id, state, config) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?)",
            (
                run_id,
                user_id,
                now,
                now + config.retention_seconds(),
                run_config["mode"],
                run_config["fidelity"],
                run_config.get("vehicleId", ""),
                json.dumps(run_config),
            ),
        )

    def finish_run(self, run_id: str, state: str, result: Any = None, error: dict[str, str] | None = None) -> None:
        self._execute(
            "UPDATE runs SET state = ?, result = ?, error = ?, finished_at = ?, cached = ? WHERE id = ?",
            (
                state,
                json.dumps(result) if result is not None else None,
                json.dumps(error) if error else None,
                time.time(),
                1 if isinstance(result, dict) and result.get("cached") else 0,
                run_id,
            ),
        )

    def runs_of(self, user_id: str) -> list[dict[str, Any]]:
        rows = self._all("SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC", (user_id,))
        return [_summary(row) for row in rows]

    def run_of(self, user_id: str, run_id: str) -> dict[str, Any] | None:
        row = self._one("SELECT * FROM runs WHERE id = ? AND user_id = ?", (run_id, user_id))
        if row is None:
            return None
        return {
            **_summary(row),
            "config": json.loads(row["config"]),
            "result": json.loads(row["result"]) if row["result"] else None,
        }

    def delete_run(self, user_id: str, run_id: str) -> bool:
        return self._execute("DELETE FROM runs WHERE id = ? AND user_id = ?", (run_id, user_id)).rowcount > 0

    def cfd_run_times(self, user_id: str, since: float) -> list[float]:
        """Start times of the account's Mode C runs since `since`, oldest first; results served from the cache
        cost nothing and are not counted."""
        rows = self._all(
            "SELECT created_at FROM runs WHERE user_id = ? AND mode = 'cfd' AND cached = 0 AND created_at > ? ORDER BY created_at",
            (user_id, since),
        )
        return [row["created_at"] for row in rows]

    def fail_unfinished(self, code: str, message: str) -> int:
        """Marks runs that were waiting or running when the server stopped as failed."""
        placeholders = ", ".join("?" for _ in FINAL_STATES)
        return self._execute(
            f"UPDATE runs SET state = 'FAILED', error = ?, finished_at = ? WHERE state NOT IN ({placeholders})",
            (json.dumps({"code": code, "message": message}), time.time(), *FINAL_STATES),
        ).rowcount

    def delete_expired(self, now: float) -> int:
        """Deletes expired runs and sessions. Returns the number of runs deleted."""
        self._execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        return self._execute("DELETE FROM runs WHERE expires_at <= ?", (now,)).rowcount


_stores: dict[Path, Store] = {}
_stores_lock = threading.Lock()


def get_store() -> Store:
    """The store of the configured database, opened on first use."""
    path = config.database_path()
    with _stores_lock:
        store = _stores.get(path)
        if store is None:
            store = _stores[path] = Store(path)
        return store
