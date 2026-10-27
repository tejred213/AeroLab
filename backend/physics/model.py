"""Model constants shared with the TypeScript engines.

Everything is loaded from ``shared/*.json`` at the repository root, the same
files the frontend imports, so both implementations use identical numbers.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

SHARED_DIR = Path(__file__).resolve().parents[2] / "shared"


def _load(name: str) -> dict[str, Any]:
    with open(SHARED_DIR / name, encoding="utf-8") as handle:
        return json.load(handle)


MODEL: dict[str, Any] = _load("aero-model.json")
PARAMETER_DATA: dict[str, Any] = _load("parameters.json")
VEHICLE_DATA: dict[str, Any] = _load("vehicles.json")
REAL_CAR_DATA: dict[str, Any] = _load("real-cars.json")

MODEL_VERSION: str = MODEL["version"]
GRAVITY: float = MODEL["air"]["gravity"]

DEG_TO_RAD = math.pi / 180.0
RAD_TO_DEG = 180.0 / math.pi
