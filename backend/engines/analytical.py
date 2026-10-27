"""Mode A engine: analytical component build-up, calibrated to the class reference."""

from __future__ import annotations

from typing import Any

from engines.base import ProgressReporter, SimulationEngine, no_progress
from physics.aero_analytical import analytical_raw
from physics.model import MODEL
from simulation.assemble import PreparedCase, assemble_result, prepare_case

ANALYTICAL_PROVENANCE = (
    "Mode A · Analytical — semi-empirical component build-up (closed-form correlations). No flow field is solved."
)

ANALYTICAL_ASSUMPTIONS = [
    "Steady, incompressible airflow at constant air density.",
    "Coefficients come from closed-form correlations, not from a flow solution.",
    "Rear separation is a smooth empirical function of the effective rear slope (the real transition is abrupt).",
    "Base pressure, trailing-vortex drag and underbody suction use fixed empirical constants.",
    "Rear wing treated with finite-wing (lifting-line) theory in a reduced dynamic-pressure onset flow.",
    "Simplified wheel aerodynamics: exposed-tyre and wheelhouse drag correlations; no wheel rotation effects.",
    "Simplified ground interaction: ride-height dependence via a Venturi-type correlation.",
    "Rigid vehicle body; no thermal, cooling-flow or aeroelastic effects.",
    "Results are anchored to an approximate class reference and are most reliable as differences between configurations.",
]


class AnalyticalEngine(SimulationEngine):
    mode = "analytical"
    provenance = ANALYTICAL_PROVENANCE

    def availability(self) -> tuple[bool, str]:
        return True, "Closed-form model; always available."

    def simulate(
        self,
        config: dict[str, Any],
        report: ProgressReporter = no_progress,
        prepared: PreparedCase | None = None,
    ) -> dict[str, Any]:
        report("PREPARING", 0.1, "Preparing geometry")
        prepared = prepared or prepare_case(config)
        report("SOLVING", 0.5, "Evaluating correlations")
        raw = analytical_raw(prepared.shape, prepared.metrics, prepared.flow)
        raw_reference = analytical_raw(prepared.reference_shape, prepared.reference_metrics, prepared.calibration_flow)
        report("POST_PROCESSING", 0.9, "Assembling result")
        return assemble_result(
            config,
            prepared,
            raw,
            raw_reference,
            mode=self.mode,
            provenance=self.provenance,
            uncertainty_model=MODEL["uncertainty"]["analytical"],
            assumptions=ANALYTICAL_ASSUMPTIONS,
        )
