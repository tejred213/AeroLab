"""Sanity checks: warnings for physically suspicious configurations or results.

These never alter the numbers; they tell the user when to distrust them.
Mirror of lib/simulation/sanity.ts.
"""

from __future__ import annotations

from typing import Any

from geometry.metrics import GeometryMetrics
from physics.model import MODEL
from physics.rear_flow import RearFlow

EXPECTED_CD_RANGE = (0.15, 0.6)
EXPECTED_CL_RANGE = (-1.0, 0.6)
SPEED_OF_SOUND = 340.0


def sanity_warnings(
    geometry: dict[str, float],
    metrics: GeometryMetrics,
    rear_flow: RearFlow,
    cd: float,
    cl: float,
    reference_cd: float,
    relative_speed: float,
    yaw_angle_deg: float,
) -> list[dict[str, Any]]:
    warnings: list[dict[str, Any]] = []

    def warn(code: str, message: str) -> None:
        warnings.append({"code": code, "severity": "warning", "message": message})

    if metrics.frontal_area < 1.5:
        warn("FRONTAL_AREA_SMALL", f"Frontal area is unusually small ({metrics.frontal_area:.2f} m^2).")
    elif metrics.frontal_area > 3.6:
        warn("FRONTAL_AREA_LARGE", f"Frontal area is unusually large ({metrics.frontal_area:.2f} m^2).")
    if metrics.ground_clearance < geometry["minGroundClearance"]:
        warn(
            "CLEARANCE_BELOW_LIMIT",
            f"Ride height is below the configured minimum: lowest point {metrics.ground_clearance * 1000:.0f} mm, "
            f"limit {geometry['minGroundClearance'] * 1000:.0f} mm.",
        )
    if cd < EXPECTED_CD_RANGE[0] or cd > EXPECTED_CD_RANGE[1]:
        warn(
            "CD_OUT_OF_RANGE",
            f"Predicted Cd ({cd:.3f}) is outside the expected range for a road car "
            f"({EXPECTED_CD_RANGE[0]} to {EXPECTED_CD_RANGE[1]}).",
        )
    if cl < EXPECTED_CL_RANGE[0] or cl > EXPECTED_CL_RANGE[1]:
        warn("CL_OUT_OF_RANGE", f"Predicted Cl ({cl:.3f}) is outside the expected range for a road car.")
    if abs(cd - reference_cd) > 0.35 * reference_cd:
        warn(
            "FAR_FROM_REFERENCE",
            "The geometry is far from the class reference shape; the model is extrapolating and the uncertainty is large.",
        )
    if 0.08 < rear_flow.separation_fraction < 0.92:
        warn(
            "CRITICAL_REAR_SLOPE",
            f"Effective rear slope ({rear_flow.effective_slant_deg:.1f} deg) is near the critical angle. "
            "Real flows switch abruptly between attached and separated states here; results are especially uncertain.",
        )
    if geometry["diffuserLength"] > 0.05 and geometry["diffuserAngle"] > 14:
        warn("DIFFUSER_STALL", "Diffuser angle exceeds about 14 deg; the diffuser flow is likely separated.")
    if geometry["wingChord"] > 1e-4 and geometry["wingAngle"] > MODEL["wing"]["stallOnsetDeg"]:
        warn("WING_STALL", "Rear wing angle is beyond the stall onset; downforce saturates while drag rises steeply.")
    if abs(yaw_angle_deg) > 20:
        warn("YAW_LARGE", "Aerodynamic yaw angle exceeds 20 deg; the crosswind correlations are outside their intended range.")
    if relative_speed / SPEED_OF_SOUND > 0.3:
        warn("COMPRESSIBILITY", "Relative air speed exceeds Mach 0.3; compressibility is not modelled.")
    if relative_speed < 5:
        warnings.append(
            {
                "code": "LOW_SPEED",
                "severity": "info",
                "message": "Relative air speed is very low; forces are small and Reynolds-number effects are not well represented.",
            }
        )
    return warnings
