"""Parameter sweeps and 2D design-space maps (mirror of lib/simulation/sweep.ts)."""

from __future__ import annotations

import time
from typing import Any, Callable

from engines.registry import simulate
from simulation.assemble import SimulationError
from vehicle.performance import make_performance_input, simulate_acceleration, solve_top_speed

_EMPTY = {
    "valid": False,
    "cd": None,
    "cdUncertainty": None,
    "cl": None,
    "clUncertainty": None,
    "drag": None,
    "downforce": None,
    "topSpeed": None,
    "efficiency": None,
    "accel100": None,
}

_MODE_LABEL = {
    "analytical": "Mode A · Analytical",
    "reduced-order": "Mode B · Reduced-order",
    "ml-surrogate": "Mode D · ML surrogate",
    "cfd": "Mode C · CFD",
}


def evaluate_point(config: dict[str, Any], spec: dict[str, Any], powertrain: dict[str, Any], x: float, y: float | None) -> dict[str, Any]:
    """Aerodynamics with the configured engine, then vehicle performance, for one design point."""
    try:
        aero = simulate(config)["aero"]
        c = aero["coefficients"]
        inp = make_performance_input(spec, powertrain, config["geometry"], c, aero["air"]["density"], config["environment"], config["speed"])
        top_speed, _ = solve_top_speed(inp)
        accel = simulate_acceleration(inp, stop_after_kmh=100)
        accel100 = next((entry["time"] for entry in accel["times"] if entry["target"] == 100), None)
        return {
            "x": x,
            "y": y,
            "valid": True,
            "error": None,
            "cd": c["cd"],
            "cdUncertainty": aero["uncertainty"]["cd"],
            "cl": c["cl"],
            "clUncertainty": aero["uncertainty"]["cl"],
            "drag": aero["forces"]["drag"],
            "downforce": aero["forces"]["downforce"],
            "topSpeed": top_speed,
            "efficiency": -c["cl"] / c["cd"],
            "accel100": accel100,
        }
    except SimulationError as error:
        return {"x": x, "y": y, **_EMPTY, "error": error.message}


def run_sweep(request: dict[str, Any], on_progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
    """Runs a 1D sweep (paramY is None) or a 2D design-space map. Returns SweepResult JSON."""
    started = time.perf_counter()
    config = request["config"]
    param_x, param_y = request["paramX"], request.get("paramY")
    values_x = request["valuesX"]
    values_y = request["valuesY"] if param_y else [None]
    total = len(values_x) * len(values_y)
    rows: list[dict[str, Any]] = []
    for y in values_y:
        for x in values_x:
            geometry = {**config["geometry"], param_x: x}
            if param_y:
                geometry[param_y] = y
            rows.append(evaluate_point({**config, "geometry": geometry}, request["spec"], request["powertrain"], x, y if param_y else None))
            if on_progress:
                on_progress(len(rows), total)
    provenance = ""
    if any(row["valid"] for row in rows):
        label = _MODE_LABEL.get(config["mode"], config["mode"])
        grid = f" ({config['fidelity']} grid)" if config["mode"] == "reduced-order" else ""
        provenance = f"{label}{grid}, computed on the backend"
    return {"request": request, "rows": rows, "provenance": provenance, "durationMs": (time.perf_counter() - started) * 1000}
