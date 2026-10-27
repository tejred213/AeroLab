"""Engine registry and result cache: the single place where a mode is turned into numbers."""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Any

from engines.analytical import AnalyticalEngine
from engines.base import ProgressReporter, SimulationEngine, no_progress
from engines.ml_surrogate import MLSurrogateEngine
from engines.openfoam import OpenFOAMEngine
from engines.reduced_order import ReducedOrderEngine
from simulation.assemble import SimulationError
from simulation.hashing import aero_cache_key, hash_config

_ANALYTICAL = AnalyticalEngine()
_REDUCED_ORDER = ReducedOrderEngine()
_SURROGATE = MLSurrogateEngine()

CACHE_LIMIT = 512
_cache: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
_cache_lock = threading.Lock()


def get_engine(mode: str) -> SimulationEngine:
    if mode == "analytical":
        return _ANALYTICAL
    if mode == "reduced-order":
        return _REDUCED_ORDER
    if mode == "ml-surrogate":
        return _SURROGATE
    if mode == "cfd":
        # The CFD adapter keeps per-run state (its case directory), so each run gets its own instance.
        return OpenFOAMEngine()
    raise SimulationError("UNKNOWN_MODE", f'Unknown simulation mode "{mode}".')


def engine_availability() -> dict[str, dict[str, Any]]:
    report = {}
    for mode in ("analytical", "reduced-order", "cfd", "ml-surrogate"):
        available, detail = get_engine(mode).availability()
        report[mode] = {"available": available, "detail": detail}
    return report


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def simulate(config: dict[str, Any], report: ProgressReporter = no_progress) -> dict[str, Any]:
    """Runs (or fetches from the cache) one simulation. Returns SimulationResult JSON."""
    started = time.perf_counter()
    # Surrogate predictions depend on which model is currently trained, so they are not cached.
    cacheable = config["mode"] != "ml-surrogate"
    key = aero_cache_key(config)
    if cacheable:
        with _cache_lock:
            cached = _cache.get(key)
            if cached is not None:
                _cache.move_to_end(key)
        if cached is not None:
            report("COMPLETE", 1.0, "Complete (cached result)")
            return {
                "hash": hash_config(config),
                "config": config,
                "aero": cached,
                "durationMs": (time.perf_counter() - started) * 1000,
                "cached": True,
            }

    aero = get_engine(config["mode"]).simulate(config, report)
    if cacheable:
        with _cache_lock:
            _cache[key] = aero
            while len(_cache) > CACHE_LIMIT:
                _cache.popitem(last=False)
    return {
        "hash": hash_config(config),
        "config": config,
        "aero": aero,
        "durationMs": (time.perf_counter() - started) * 1000,
        "cached": False,
    }
