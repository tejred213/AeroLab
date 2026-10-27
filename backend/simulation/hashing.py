"""Deterministic cache keys for simulations."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

from physics.model import MODEL_VERSION


def _normalise(value: Any) -> Any:
    """Rounds floats (removing representation noise) and sorts mapping keys."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        rounded = round(float(value), 9)
        return int(rounded) if rounded == int(rounded) else rounded
    if isinstance(value, dict):
        return {key: _normalise(value[key]) for key in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [_normalise(item) for item in value]
    return str(value)


def canonical_json(value: Any) -> str:
    return json.dumps(_normalise(value), separators=(",", ":"), sort_keys=True)


def hash_value(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()[:24]


def hash_config(config: dict[str, Any]) -> str:
    """Key of a simulation: geometry + environment + simulation settings (+ model version)."""
    return hash_value({"modelVersion": MODEL_VERSION, "config": config})


def aero_cache_key(config: dict[str, Any]) -> str:
    """Like hash_config but ignoring the road gradient, which has no aerodynamic effect."""
    environment = {**config["environment"], "gradient": 0}
    return hash_config({**config, "environment": environment})
