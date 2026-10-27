"""Engine interfaces.

    SimulationEngine
        ├── AnalyticalEngine      (Mode A)
        ├── ReducedOrderEngine    (Mode B)
        ├── OpenFOAMEngine        (Mode C, via CFDBackend)
        └── MLSurrogateEngine     (Mode D)

Every engine takes a simulation configuration (the JSON shape shared with the
frontend) and returns an aerodynamic result in that same shape, tagged with the
mode that produced it. An engine that cannot produce a result raises
SimulationError; it never returns substitute numbers.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable

# (job state, overall progress 0..1, message)
ProgressReporter = Callable[[str, float, str], None]


def no_progress(_state: str, _progress: float, _message: str) -> None:
    """Default reporter: discard progress."""


class SimulationEngine(ABC):
    """An aerodynamic model that turns geometry + conditions into coefficients."""

    #: Simulation mode identifier shared with the frontend.
    mode: str = ""
    #: Human-readable provenance attached to every result.
    provenance: str = ""

    @abstractmethod
    def availability(self) -> tuple[bool, str]:
        """Whether the engine can run on this machine, with an explanation."""

    @abstractmethod
    def simulate(self, config: dict[str, Any], report: ProgressReporter = no_progress) -> dict[str, Any]:
        """Runs one simulation and returns the aerodynamic result (AeroResult JSON)."""


class CFDBackend(ABC):
    """Adapter interface for an external CFD solver.

    Implementations generate the solver's case from the geometry and conditions,
    run it, and parse its output. `run` must raise if the solver is unavailable
    or fails: results are only ever read back from real solver output.
    """

    @abstractmethod
    def run(self, geometry: dict[str, float], conditions: dict[str, Any]) -> None:
        """Generates the case and runs the solver to completion."""

    @abstractmethod
    def get_results(self) -> dict[str, Any]:
        """Parses the solver output of the last run into structured results."""
