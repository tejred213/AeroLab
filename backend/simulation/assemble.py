"""Shared set-up and result assembly for the aerodynamic engines.

Calibration ("anchor and delta"): each vehicle class has approximate reference
coefficients. An engine evaluates both the user's geometry and the class
reference geometry; the reported coefficient is

    C = C_reference + [ C_model(geometry) - C_model(reference geometry) ]

so the simplified model only has to predict the *change* caused by a
modification. The offset is reported explicitly in the breakdown.

Mirror of lib/simulation/assemble.ts. Results are plain dicts in the camelCase
JSON shape of the frontend's AeroResult type.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from geometry.metrics import GeometryMetrics, compute_metrics
from geometry.profile import BodyShape, build_body_shape
from geometry.validate import validate_geometry
from physics.aero_analytical import FlowState, RawAero
from physics.atmosphere import AirState, air_viscosity, resolve_air, reynolds_number
from physics.forces import coefficient_force, dynamic_pressure
from physics.model import MODEL
from physics.wind import RelativeWind, relative_wind
from simulation.sanity import sanity_warnings


class SimulationError(Exception):
    """A simulation could not be carried out. Carries a machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class PreparedCase:
    shape: BodyShape
    metrics: GeometryMetrics
    reference_shape: BodyShape
    reference_metrics: GeometryMetrics
    air: AirState
    wind: RelativeWind
    flow: FlowState
    calibration_flow: FlowState
    # Mode C only: the closed surface that is meshed instead of the parametric body (geometry.surface.SurfaceInfo).
    surface: Any = None


def prepare_case(config: dict[str, Any]) -> PreparedCase:
    """Validates the configuration and derives everything the engines need."""
    errors = [issue for issue in validate_geometry(config["geometry"]) if issue["severity"] == "error"]
    if errors:
        raise SimulationError("INVALID_GEOMETRY", " ".join(issue["message"] for issue in errors))
    if any(issue["severity"] == "error" for issue in validate_geometry(config["referenceGeometry"])):
        raise SimulationError("INVALID_REFERENCE_GEOMETRY", "The reference geometry of this vehicle is invalid.")
    speed = config["speed"]
    if not math.isfinite(speed) or speed < 0:
        raise SimulationError("INVALID_CONDITIONS", "Vehicle speed must be a non-negative number.")
    environment = config["environment"]
    air = resolve_air(environment)
    if not math.isfinite(air.density) or air.density <= 0 or air.density > 5:
        raise SimulationError("INVALID_CONDITIONS", f"Air density {air.density} kg/m^3 is not physical.")
    wind = relative_wind(speed, environment["windSpeed"], environment["windAngle"])

    shape = build_body_shape(config["geometry"])
    reference_shape = build_body_shape(config["referenceGeometry"])
    return PreparedCase(
        shape=shape,
        metrics=compute_metrics(shape),
        reference_shape=reference_shape,
        reference_metrics=compute_metrics(reference_shape),
        air=air,
        wind=wind,
        flow=FlowState(speed=wind.relative_speed, yaw_deg=wind.yaw_angle_deg, density=air.density, viscosity=air.viscosity),
        calibration_flow=FlowState(
            speed=MODEL["calibration"]["speed"], yaw_deg=0.0, density=1.225, viscosity=air_viscosity(288.15)
        ),
    )


def assemble_result(
    config: dict[str, Any],
    prepared: PreparedCase,
    raw: RawAero,
    raw_reference: RawAero,
    mode: str,
    provenance: str,
    uncertainty_model: dict[str, float],
    assumptions: list[str],
    solver: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metrics, flow = prepared.metrics, prepared.flow

    cd_offset = config["reference"]["cd"] - raw_reference.cd
    cl_offset = config["reference"]["cl"] - raw_reference.cl
    cd = raw.cd + cd_offset
    cl = raw.cl + cl_offset
    cl_front = raw.cl_front + cl_offset * MODEL["liftDistribution"]["bodyBase"]

    for value in (cd, cl, raw.cs, raw.cm_yaw, metrics.frontal_area):
        if not math.isfinite(value):
            raise SimulationError("INVALID_RESULT", "The model produced a non-finite coefficient for this configuration.")
    if cd <= 0:
        raise SimulationError(
            "INVALID_RESULT",
            f"The model produced a non-physical drag coefficient (Cd = {cd:.3f}); the geometry is outside the model's valid range.",
        )

    u = uncertainty_model
    uncertainty = {
        "cd": math.hypot(u["cdRelative"] * cd, u["cdDelta"] * (raw.cd - raw_reference.cd)),
        "cl": math.hypot(u["clAbsolute"], u["clDelta"] * (raw.cl - raw_reference.cl)),
    }

    q = dynamic_pressure(flow.density, flow.speed)
    area = metrics.frontal_area
    lift = coefficient_force(q, cl, area)
    calibration_label = "Reference calibration (unmodelled detail)"
    rear = raw.rear_flow

    result: dict[str, Any] = {
        "mode": mode,
        "source": "backend",
        "provenance": provenance,
        "coefficients": {
            "cd": cd,
            "cl": cl,
            "clFront": cl_front,
            "clRear": cl - cl_front,
            "cs": raw.cs,
            "cmYaw": raw.cm_yaw,
            "cdFriction": raw.cd_friction,
            "referenceSpeed": flow.speed,
            "frontalArea": area,
        },
        "uncertainty": uncertainty,
        "forces": {
            "dynamicPressure": q,
            "drag": coefficient_force(q, cd, area),
            "lift": lift,
            "downforce": -lift,
            "side": coefficient_force(q, raw.cs, area),
            "yawMoment": coefficient_force(q, raw.cm_yaw, area) * config["geometry"]["wheelbase"],
        },
        "wind": {"relativeSpeed": flow.speed, "yawAngleDeg": flow.yaw_deg},
        "air": {
            "density": flow.density,
            "viscosity": flow.viscosity,
            "reynolds": reynolds_number(flow.density, flow.speed, metrics.length, flow.viscosity),
        },
        "breakdown": {
            "drag": [item.to_json() for item in raw.drag] + [{"id": "calibration", "label": calibration_label, "value": cd_offset}],
            "lift": [item.to_json() for item in raw.lift] + [{"id": "calibration", "label": calibration_label, "value": cl_offset}],
        },
        "calibration": {"cdRaw": raw.cd, "clRaw": raw.cl, "cdOffset": cd_offset, "clOffset": cl_offset},
        "rearFlow": rear.to_json(),
        "metrics": metrics.to_json(),
        "warnings": sanity_warnings(
            config["geometry"], metrics, rear, cd, cl, config["reference"]["cd"], flow.speed, flow.yaw_deg
        ),
        "assumptions": assumptions,
    }
    if solver is not None:
        result["solver"] = solver
    return result
