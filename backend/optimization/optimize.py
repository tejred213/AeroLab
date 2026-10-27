"""Design optimisation over geometry parameters.

Two search strategies share one evaluation routine and one result format
(the JSON shape of the frontend's OptimizationResult):

* differential evolution — a population-based evolutionary algorithm
  (same scheme as lib/simulation/optimize.ts), suited to cheap engines;
* Bayesian optimisation — a Gaussian-process model of the merit function with
  expected-improvement acquisition, suited to expensive engines because it
  needs far fewer evaluations.

Constraints use feasibility rules: a feasible design always beats an infeasible
one, and infeasible designs are ranked by total normalised violation.

The optimiser only searches. Every candidate is scored by the selected
simulation engine, so its results inherit that engine's limitations.
"""

from __future__ import annotations

import math
import time
import warnings
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
from scipy.stats import norm, qmc
from sklearn.exceptions import ConvergenceWarning
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import ConstantKernel, Matern, WhiteKernel

from engines.registry import simulate
from simulation.assemble import SimulationError
from vehicle.performance import make_performance_input, solve_top_speed

INVALID_VIOLATION = 1e6
ProgressCallback = Callable[[list[dict[str, Any]]], None]

_MODE_LABEL = {
    "analytical": "Mode A · Analytical",
    "reduced-order": "Mode B · Reduced-order",
    "ml-surrogate": "Mode D · ML surrogate",
    "cfd": "Mode C · CFD",
}


@dataclass
class Scored:
    x: np.ndarray
    metrics: dict[str, float] | None
    objective: float
    violation: float


def _objective_value(objective: str, metrics: dict[str, float]) -> float:
    if objective == "min-drag":
        return metrics["drag"]
    if objective == "max-downforce":
        return -metrics["downforce"]
    if objective == "max-top-speed":
        return -metrics["topSpeed"]
    if objective == "max-efficiency":
        return -metrics["efficiency"]
    return 0.0  # meet-targets: only the constraints matter


def constraint_violation(constraints: list[dict[str, Any]], metrics: dict[str, float]) -> float:
    """Sum of constraint violations, each normalised by the size of its limit."""
    total = 0.0
    for constraint in constraints:
        value = metrics[constraint["metric"]]
        excess = constraint["value"] - value if constraint["op"] == ">=" else value - constraint["value"]
        if excess > 0:
            total += excess / max(abs(constraint["value"]), 1e-3)
    return total


def _better_or_equal(a: Scored, b: Scored) -> bool:
    """Feasibility rules (Deb): true when a is at least as good as b."""
    if a.violation <= 0 and b.violation <= 0:
        return a.objective <= b.objective
    if a.violation <= 0:
        return True
    if b.violation <= 0:
        return False
    return a.violation <= b.violation


def _geometry_for(request: dict[str, Any], x: np.ndarray) -> dict[str, float]:
    geometry = dict(request["config"]["geometry"])
    for variable, value in zip(request["variables"], x):
        geometry[variable["param"]] = float(value)
    return geometry


def evaluate_design(request: dict[str, Any], geometry: dict[str, float]) -> dict[str, float] | None:
    """Aerodynamics (configured engine) + top speed for one design; None if it cannot be simulated."""
    config = {**request["config"], "geometry": geometry}
    try:
        aero = simulate(config)["aero"]
    except SimulationError:
        return None
    c = aero["coefficients"]
    top_speed, _ = solve_top_speed(
        make_performance_input(
            request["spec"], request["powertrain"], geometry, c, aero["air"]["density"], config["environment"], config["speed"]
        )
    )
    return {
        "cd": c["cd"],
        "cl": c["cl"],
        "drag": aero["forces"]["drag"],
        "downforce": aero["forces"]["downforce"],
        "topSpeed": top_speed,
        "efficiency": -c["cl"] / c["cd"],
    }


def _candidate(request: dict[str, Any], scored: Scored) -> dict[str, Any]:
    nan = float("nan")
    return {
        "geometry": _geometry_for(request, scored.x),
        "values": {variable["param"]: float(value) for variable, value in zip(request["variables"], scored.x)},
        "metrics": scored.metrics or {key: nan for key in ("cd", "cl", "drag", "downforce", "topSpeed", "efficiency")},
        "feasible": scored.metrics is not None and scored.violation <= 0,
        "violation": scored.violation,
    }


def _distinct_candidates(request: dict[str, Any], members: list[Scored], limit: int = 5) -> list[dict[str, Any]]:
    """Best distinct designs, best first."""
    feasible = sorted((m for m in members if m.metrics and m.violation <= 0), key=lambda m: m.objective)
    infeasible = sorted((m for m in members if m.metrics and m.violation > 0), key=lambda m: m.violation)
    spans = np.array([max(v["max"] - v["min"], 1e-12) for v in request["variables"]])
    chosen: list[Scored] = []
    for member in feasible + infeasible:
        if all(np.max(np.abs(member.x - other.x) / spans) > 0.02 for other in chosen):
            chosen.append(member)
        if len(chosen) >= limit:
            break
    return [_candidate(request, member) for member in chosen]


class _Search:
    """Shared bookkeeping of an optimisation run."""

    def __init__(self, request: dict[str, Any], on_progress: ProgressCallback | None) -> None:
        self.request = request
        self.on_progress = on_progress
        self.evaluations = 0
        self.history: list[dict[str, Any]] = []
        self.lows = np.array([v["min"] for v in request["variables"]], dtype=float)
        self.highs = np.array([v["max"] for v in request["variables"]], dtype=float)

    def score(self, x: np.ndarray) -> Scored:
        self.evaluations += 1
        metrics = evaluate_design(self.request, _geometry_for(self.request, x))
        if metrics is None:
            return Scored(x, None, math.inf, INVALID_VIOLATION)
        return Scored(
            x,
            metrics,
            _objective_value(self.request["objective"], metrics),
            constraint_violation(self.request["constraints"], metrics),
        )

    def record(self, iteration: int, best: Scored) -> None:
        if best.metrics is None:
            return
        self.history.append(
            {
                "iteration": iteration,
                "evaluations": self.evaluations,
                "feasible": best.violation <= 0,
                "violation": best.violation,
                "metrics": best.metrics,
            }
        )
        if self.on_progress:
            self.on_progress(list(self.history))

    def start_point(self) -> np.ndarray:
        current = np.array([self.request["config"]["geometry"][v["param"]] for v in self.request["variables"]], dtype=float)
        return np.clip(current, self.lows, self.highs)

    def baseline(self) -> Scored:
        return self.score(np.array([self.request["config"]["geometry"][v["param"]] for v in self.request["variables"]], dtype=float))


def _best(members: list[Scored]) -> Scored:
    best = members[0]
    for member in members[1:]:
        if _better_or_equal(member, best):
            best = member
    return best


def _differential_evolution(search: _Search) -> tuple[list[Scored], str]:
    """DE/rand/1/bin with greedy selection under the feasibility rules."""
    request = search.request
    rng = np.random.default_rng(request["seed"])
    dimension = len(request["variables"])
    population_size = min(max(8 * dimension, 12), 40)
    weight, crossover = 0.7, 0.9

    population = [search.score(search.start_point())]
    while len(population) < population_size:
        population.append(search.score(search.lows + rng.random(dimension) * (search.highs - search.lows)))
    search.record(0, _best(population))

    for iteration in range(1, request["iterations"] + 1):
        next_population: list[Scored] = []
        for i in range(population_size):
            others = [index for index in range(population_size) if index != i]
            a, b, c = rng.choice(others, size=3, replace=False)
            forced = rng.integers(dimension)
            mask = rng.random(dimension) < crossover
            mask[forced] = True
            mutant = np.clip(population[a].x + weight * (population[b].x - population[c].x), search.lows, search.highs)
            trial = search.score(np.where(mask, mutant, population[i].x))
            next_population.append(trial if _better_or_equal(trial, population[i]) else population[i])
        population = next_population
        search.record(iteration, _best(population))
    return population, f"Differential evolution (rand/1/bin, population {population_size})"


def _merit(scored: Scored, scale: float) -> float:
    """Single number for the Gaussian process: objective, or a penalty that grows with the violation."""
    if scored.metrics is None:
        return scale * 10
    if scored.violation > 0:
        return scale * (1 + scored.violation)
    return scored.objective


def _bayesian(search: _Search) -> tuple[list[Scored], str]:
    """Gaussian-process model of the merit with expected-improvement acquisition."""
    request = search.request
    rng = np.random.default_rng(request["seed"])
    dimension = len(request["variables"])
    span = search.highs - search.lows
    initial = max(2 * dimension + 2, 6)

    sampler = qmc.LatinHypercube(d=dimension, seed=request["seed"])
    points = [search.start_point(), *(search.lows + row * span for row in sampler.random(initial - 1))]
    evaluated = [search.score(point) for point in points]
    search.record(0, _best(evaluated))

    kernel = ConstantKernel(1.0, (1e-2, 1e2)) * Matern(
        length_scale=np.full(dimension, 0.3), length_scale_bounds=(0.03, 30.0), nu=2.5
    ) + WhiteKernel(1e-6, (1e-9, 1e-2))
    for iteration in range(1, request["iterations"] + 1):
        valid = [member for member in evaluated if member.metrics is not None]
        objectives = [member.objective for member in valid if member.violation <= 0] or [0.0]
        # Penalty level: above every feasible objective, so any feasible design beats any infeasible one.
        scale = max(objectives) + max(abs(max(objectives)), abs(min(objectives)), 1.0)
        x_train = np.array([(member.x - search.lows) / span for member in evaluated])
        y_train = np.array([_merit(member, scale) for member in evaluated])
        mean, std = float(y_train.mean()), float(y_train.std()) or 1.0
        gp = GaussianProcessRegressor(kernel=kernel, normalize_y=False, n_restarts_optimizer=1, random_state=request["seed"])
        with warnings.catch_warnings():
            # Hyper-parameters resting on a bound are expected for the few, smooth samples seen here.
            warnings.simplefilter("ignore", ConvergenceWarning)
            gp.fit(x_train, (y_train - mean) / std)

        best_index = int(np.argmin(y_train))
        best_value = (y_train[best_index] - mean) / std
        # Candidates: a global scatter plus a local cloud around the incumbent.
        local = np.clip(x_train[best_index] + 0.08 * rng.standard_normal((600, dimension)), 0, 1)
        candidates = np.vstack([rng.random((1400, dimension)), local])
        mu, sigma = gp.predict(candidates, return_std=True)
        sigma = np.maximum(sigma, 1e-9)
        improvement = best_value - mu
        z = improvement / sigma
        expected = improvement * norm.cdf(z) + sigma * norm.pdf(z)
        choice = candidates[int(np.argmax(expected))]
        evaluated.append(search.score(search.lows + choice * span))
        search.record(iteration, _best(evaluated))
    return evaluated, f"Bayesian optimisation (Gaussian process, expected improvement, {initial} initial points)"


def run_optimization(request: dict[str, Any], on_progress: ProgressCallback | None = None) -> dict[str, Any]:
    """Runs the requested search and returns OptimizationResult JSON."""
    started = time.perf_counter()
    search = _Search(request, on_progress)
    baseline = search.baseline()
    if request["algorithm"] == "bayesian":
        members, algorithm = _bayesian(search)
    else:
        members, algorithm = _differential_evolution(search)

    config = request["config"]
    grid = f" ({config['fidelity']} grid)" if config["mode"] == "reduced-order" else ""
    return {
        "request": request,
        "history": search.history,
        "best": _candidate(request, _best(members)),
        "baseline": _candidate(request, baseline),
        "candidates": _distinct_candidates(request, members),
        "evaluations": search.evaluations,
        "algorithm": algorithm,
        "provenance": f"Scored with {_MODE_LABEL.get(config['mode'], config['mode'])}{grid}, on the backend",
        "durationMs": (time.perf_counter() - started) * 1000,
    }
