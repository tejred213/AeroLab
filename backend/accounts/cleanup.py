"""Deletes what is older than the retention period: saved runs, CFD case directories and archives, and
uploaded surfaces. Runs every hour while the server is up (and once at start)."""

from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path

import engines.openfoam as openfoam
import geometry.surface as surface
from accounts import config
from accounts.store import get_store

INTERVAL_S = 3600


def _old_entries(directory: Path, cutoff: float) -> list[Path]:
    if not directory.is_dir():
        return []
    # A directory's own time changes whenever a file is added to it, so an active case is never old.
    return [entry for entry in directory.iterdir() if entry.stat().st_mtime < cutoff]


def purge(now: float | None = None) -> dict[str, int]:
    """Deletes everything past the retention period. Returns how much of each kind was deleted."""
    now = time.time() if now is None else now
    cutoff = now - config.retention_seconds()
    runs = get_store().delete_expired(now)
    cases = 0
    for entry in _old_entries(openfoam.CASES_DIR, cutoff):
        if entry.is_dir():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)
        cases += 1
    surfaces = 0
    for entry in _old_entries(surface.SURFACE_DIR, cutoff):
        entry.unlink(missing_ok=True)
        surfaces += 1
    return {"runs": runs, "caseEntries": cases, "surfaceFiles": surfaces}


def start_background_cleanup(stop: threading.Event) -> threading.Thread:
    def loop() -> None:
        while not stop.is_set():
            try:
                purge()
            except Exception as error:  # noqa: BLE001 - cleaning up must never stop the server
                print(f"cleanup failed: {type(error).__name__}: {error}", flush=True)
            stop.wait(INTERVAL_S)

    thread = threading.Thread(target=loop, name="aerolab-cleanup", daemon=True)
    thread.start()
    return thread
