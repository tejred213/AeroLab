"""Shared fixtures: every test writes its runtime data into a temporary directory, with its own account
database, and the shared API test client is signed in to a fresh account."""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import pytest

import accounts.store as store_module
import api.routes as routes
import engines.ml_surrogate as ml_surrogate
import geometry.surface as surface_module
from accounts import limits
import engines.openfoam as openfoam
import vehicle.library as library
from engines.registry import clear_cache


@pytest.fixture(autouse=True)
def isolated_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    data = tmp_path / "data"
    monkeypatch.setattr(ml_surrogate, "DATA_DIR", data)
    monkeypatch.setattr(ml_surrogate, "DATASET_DIR", data / "datasets")
    monkeypatch.setattr(ml_surrogate, "MODEL_DIR", data / "surrogates")
    monkeypatch.setattr(ml_surrogate, "_loaded", {})
    monkeypatch.setattr(openfoam, "CASES_DIR", data / "cfd")
    monkeypatch.setattr(routes, "CASES_DIR", data / "cfd")
    monkeypatch.setattr(library, "DATA_DIR", data)
    monkeypatch.setattr(library, "CUSTOM_VEHICLES_FILE", data / "vehicles.json")
    monkeypatch.setattr(surface_module, "SURFACE_DIR", data / "surfaces")
    database = data / "aerolab.sqlite3"
    monkeypatch.setenv("AEROLAB_DB", str(database))
    # The test client talks plain http, which does not carry secure cookies.
    monkeypatch.setenv("AEROLAB_COOKIE_SECURE", "0")
    for name in ("AEROLAB_CFD_RUNS_PER_WINDOW", "AEROLAB_CFD_WINDOW_MINUTES", "AEROLAB_CFD_QUEUE_LIMIT", "AEROLAB_RUN_RETENTION_DAYS"):
        monkeypatch.delenv(name, raising=False)
    for window in limits.ALL_WINDOWS:
        window.reset()
    # Imported here: the API test module builds the app, which reads the environment set above.
    from tests.helpers import sign_in
    from tests.test_api import client

    client.cookies.clear()
    sign_in(client)
    # Tests never use an OpenFOAM installation that happens to be on this machine: no session wrapper is
    # looked for, so a solver run needs the fake tool chain a test puts on the PATH itself.
    monkeypatch.setattr(openfoam, "_wrapper_candidates", lambda: [])
    monkeypatch.delenv(openfoam.PROCESSORS_ENV, raising=False)
    openfoam.reset_launcher_cache()
    clear_cache()
    yield data
    openfoam.reset_launcher_cache()
    opened = store_module._stores.pop(database, None)
    if opened is not None:
        opened.close()
