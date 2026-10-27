"""Mode B — reduced-order engine (mirror of lib/simulation/reducedOrder.ts).

Numerically solved: 3D potential flow about the body and its wake displacement
body (potential_flow.py); surface pressure from Bernoulli, integrated over the
body to give pressure drag and lift.

Empirical closures (same correlations as Mode A): separation location, base
pressure (blended with the pressure the solver finds along the wake boundary),
trailing-vortex drag and lift, skin friction, wheel and underbody-roughness
drag, rear wing (lifting-line, using the local dynamic pressure from the solved
field), front splitter and crosswind forces.

This is NOT CFD: there is no viscosity, turbulence or solved wake.
"""

from __future__ import annotations

import base64
import math
import threading
from dataclasses import dataclass
from typing import Any

import numpy as np

from engines.base import ProgressReporter, SimulationEngine, no_progress
from engines.potential_flow import (
    Apertures,
    Grid,
    build_grid,
    cell_velocities,
    compute_apertures,
    fidelity_settings,
    mark_active_cells,
    solve_potential,
)
from geometry.metrics import GeometryMetrics
from geometry.profile import BodyShape, lower_z, wing_geometry
from geometry.solids import SolidModel, build_solid_model, inside_body, wake_coordinates
from physics.aero_analytical import (
    FlowState,
    Item,
    RawAero,
    detail_drag_items,
    friction_drag,
    splitter_effect,
    sum_lift,
    underbody_drag,
    wheel_drag,
    wing_effect,
    yaw_effects,
)
from physics.model import DEG_TO_RAD, MODEL
from physics.rear_flow import compute_rear_flow
from simulation.assemble import PreparedCase, assemble_result, prepare_case
from simulation.hashing import hash_value

RO = MODEL["reducedOrder"]
D = MODEL["drag"]
DIST = MODEL["liftDistribution"]

REDUCED_ORDER_PROVENANCE = (
    "Mode B · Reduced-order — 3D potential flow solved numerically (cut-cell finite volume) with empirical "
    "closures for separation, base pressure, friction and wheels. Inviscid; not CFD."
)

REDUCED_ORDER_FIELD_PROVENANCE = (
    "Reduced-order field: 3D potential flow (inviscid) on a cut-cell grid, with an empirical wake displacement body. "
    "Velocities inside the wake and the turbulence estimate are synthetic. Not a CFD solution."
)

REDUCED_ORDER_ASSUMPTIONS = [
    "Steady, incompressible, inviscid, irrotational airflow (potential flow) at constant air density.",
    "No turbulence model: there is no viscosity in the solved equations.",
    "The separated wake is replaced by a closed displacement body whose shape is prescribed empirically.",
    "Separation location is an empirical function of the effective rear slope; it is not predicted by the solver.",
    "Base pressure blends an empirical value with the pressure the solver finds along the wake boundary.",
    "Skin friction, wheel drag, underbody roughness, trailing-vortex drag and crosswind forces are empirical closures.",
    "Rear wing uses lifting-line theory with the local dynamic pressure sampled from the solved field.",
    "Open-jet test section: constant-pressure side and top boundaries, uniform inflow, stationary ground plane.",
    "Simplified wheels (non-rotating cylinders) and simplified ground interaction.",
    "Rigid vehicle body; no thermal or cooling-flow effects.",
    "Results are anchored to an approximate class reference and are most reliable as differences between configurations.",
]

CELL_FLUID, CELL_SOLID, CELL_WAKE = 0, 1, 2


@dataclass
class Solved:
    raw: RawAero
    diagnostics: dict[str, Any]
    field: dict[str, Any] | None


def _wake_boundary_pressure(grid: Grid, ap: Apertures, active: np.ndarray, cp: np.ndarray, model: SolidModel) -> float | None:
    """Pressure the potential solution carries along the wake boundary just behind the tail."""
    dx = np.diff(grid.xf)[None, None, :]
    dy = np.diff(grid.yf)[None, :, None]
    dz = np.diff(grid.zf)[:, None, None]
    ux, uy, uz = ap.ux.astype(float), ap.uy.astype(float), ap.uz.astype(float)
    bx, by, bz = ap.bx.astype(float), ap.by.astype(float), ap.bz.astype(float)
    # Area vector of the wake surface inside each cell = union surface minus real-solid surface.
    sx = (ux[:, :, :-1] - ux[:, :, 1:] - (bx[:, :, :-1] - bx[:, :, 1:])) * dy * dz
    sy = (uy[:, :-1, :] - uy[:, 1:, :] - (by[:, :-1, :] - by[:, 1:, :])) * dx * dz
    sz = (uz[:-1, :, :] - uz[1:, :, :] - (bz[:-1, :, :] - bz[1:, :, :])) * dx * dy
    weight = np.sqrt(sx * sx + sy * sy + sz * sz)
    x_end = model.length + RO["basePressureSampleExtent"] * (model.wake.xc - model.length)
    in_range = ((grid.xc >= model.length) & (grid.xc <= x_end))[None, None, :]
    weight = np.where(active & in_range, weight, 0.0)
    total = float(weight.sum())
    return float((weight * cp).sum()) / total if total > 0 else None


def _integrate_pressure(
    grid: Grid,
    ap: Apertures,
    active: np.ndarray,
    cp: np.ndarray,
    fluid_fraction: np.ndarray,
    model: SolidModel,
    base_pressure: float,
    area: float,
) -> dict[str, float]:
    """Integrates surface pressure over the real solids; coefficients referenced to `area`."""
    shape, ride = model.shape, model.ride
    params = shape.params
    dx = np.diff(grid.xf)[None, None, :]
    dy = np.diff(grid.yf)[None, :, None]
    dz = np.diff(grid.zf)[:, None, None]

    bxm = ap.bx[:, :, :-1].astype(float)
    bxp = ap.bx[:, :, 1:].astype(float)
    bxm[:, :, 0] = 1
    bxp[:, :, -1] = 1
    bym = ap.by[:, :-1, :].astype(float)
    byp = ap.by[:, 1:, :].astype(float)
    bym[:, 0, :] = 1
    byp[:, -1, :] = 1
    bzm = ap.bz[:-1, :, :].astype(float)
    bzp = ap.bz[1:, :, :].astype(float)
    bzp[-1, :, :] = 1

    # Area vector of the body surface inside each cell, pointing into the solid.
    sx = (bxm - bxp) * dy * dz
    sz = (bzm - bzp) * dx * dy
    body_fraction = (bxm + bxp + bym + byp + bzm + bzp) / 6
    # Share of the cell's fluid that belongs to the outer flow rather than the wake.
    outer = np.where(active, np.minimum(fluid_fraction / np.maximum(body_fraction, 1e-6), 1.0), 0.0)

    xc = grid.xc[None, None, :]
    yc = grid.yc[None, :, None]
    zc = grid.zc[:, None, None]
    # Underbody cells: a rough floor slows the flow, weakening the pressure signal.
    floor_loss = RO["underbodyLossRoughFloor"] + (1 - RO["underbodyLossRoughFloor"]) * params["floorFlatness"]
    under = (
        (xc >= 0)
        & (xc <= model.length)
        & (np.abs(yc) <= 0.5 * params["width"])
        & (zc < ride + lower_z(shape, grid.xc)[None, None, :])
    )
    under = under & ~inside_body(model, xc, yc, zc)
    cp_outer = np.where(under, cp * floor_loss, cp)

    fx_attached = float((outer * cp_outer * sx).sum())
    fx_base = float(((1 - outer) * base_pressure * sx).sum())
    fz = (outer * cp_outer + (1 - outer) * base_pressure) * sz
    front = (shape.rear_axle_x - xc) / params["wheelbase"]
    upper = sz < 0
    scale = (2 if grid.symmetric else 1) / area
    return {
        "cdAttached": fx_attached * scale,
        "cdBase": fx_base * scale,
        "clUpper": float(fz[upper].sum()) * scale,
        "clLower": float(fz[~upper].sum()) * scale,
        "clUpperFront": float((fz * front)[upper].sum()) * scale,
        "clLowerFront": float((fz * front)[~upper].sum()) * scale,
    }


def _locate(faces: np.ndarray, value: float) -> int:
    index = 0
    while index < len(faces) - 2 and faces[index + 1] <= value:
        index += 1
    return index


def _wing_dynamic_pressure(grid: Grid, active: np.ndarray, speed_squared: np.ndarray, shape: BodyShape) -> float | None:
    """Local-to-freestream dynamic pressure ratio at the rear wing, from the solved field."""
    wing = wing_geometry(shape)
    if not wing.present:
        return None
    i = _locate(grid.xf, wing.xc)
    j = _locate(grid.yf, wing.span / 4)
    k = _locate(grid.zf, shape.params["rideHeight"] + wing.zc)
    if not active[k, j, i]:
        return None
    return float(min(max(speed_squared[k, j, i], 0.2), 1.5))


def _encode(array: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(array, dtype=dtype).tobytes()).decode("ascii")


def _build_field(
    grid: Grid,
    active: np.ndarray,
    u: np.ndarray,
    v: np.ndarray,
    w: np.ndarray,
    cp: np.ndarray,
    model: SolidModel,
    base_pressure: float,
    flow: FlowState,
    fidelity: str,
) -> dict[str, Any]:
    """Flow field in the frontend's FlowField layout, with typed arrays base64-encoded."""
    xc = grid.xc[None, None, :] * np.ones((grid.nz, grid.ny, 1))
    yc = grid.yc[None, :, None] * np.ones((grid.nz, 1, grid.nx))
    zc = grid.zc[:, None, None] * np.ones((1, grid.ny, grid.nx))
    inactive = ~active
    in_body = inactive & inside_body(model, xc, yc, zc)
    in_wake, zeta, eta, height = wake_coordinates(model, xc, yc, zc)
    wake = inactive & ~in_body & in_wake

    kind = np.where(active, CELL_FLUID, np.where(wake, CELL_WAKE, CELL_SOLID)).astype(np.uint8)
    ti = np.where(active, 0.005, 0.0)

    # Synthetic recirculation: a counter-rotating vortex pair with reversed flow on the wake
    # centreline, relaxing to a forward-moving velocity deficit further downstream.
    extent = RO["wakeRecirculationExtent"]
    wake_span = model.wake.xc - model.length
    xl = np.clip((xc - model.length) / wake_span, 0.0, 1.0)
    bubble = np.minimum(xl / extent, 1.0)
    envelope = np.sin(math.pi * bubble)
    lateral = 1 - eta * eta
    swirl = RO["wakeRecirculation"] * lateral
    u = np.where(wake, 0.5 * xl * xl + swirl * envelope * np.cos(2 * math.pi * zeta), u)
    v = np.where(wake, 0.0, v)
    w_wake = np.where(
        xl < extent,
        -swirl * (height / (2 * extent * wake_span)) * np.cos(math.pi * bubble) * np.sin(2 * math.pi * zeta),
        0.0,
    )
    w = np.where(wake, w_wake, w)
    cp = np.where(wake, base_pressure, cp)
    ti = np.where(wake, 0.1 + 0.2 * envelope * lateral, ti)

    return {
        "nx": grid.nx,
        "ny": grid.ny,
        "nz": grid.nz,
        "encoding": "base64 little-endian; float32 for xc/yc/zc/u/v/w/cp/ti, uint8 for kind; cell index = i + nx * (j + ny * k)",
        "xc": _encode(grid.xc, "<f4"),
        "yc": _encode(grid.yc, "<f4"),
        "zc": _encode(grid.zc, "<f4"),
        "u": _encode(u, "<f4"),
        "v": _encode(v, "<f4"),
        "w": _encode(w, "<f4"),
        "cp": _encode(cp, "<f4"),
        "ti": _encode(ti, "<f4"),
        "kind": _encode(kind, "u1"),
        "symmetric": grid.symmetric,
        "bounds": {
            "xMin": float(grid.xf[0]),
            "xMax": float(grid.xf[-1]),
            "yMax": float(grid.yf[-1]),
            "zMax": float(grid.zf[-1]),
        },
        "freestream": {"speed": flow.speed, "yawDeg": flow.yaw_deg},
        "provenance": REDUCED_ORDER_FIELD_PROVENANCE,
        "fidelity": fidelity,
    }


def solve_reduced_order(
    shape: BodyShape,
    metrics: GeometryMetrics,
    flow: FlowState,
    fidelity: str,
    build_field: bool = False,
    report: ProgressReporter = no_progress,
) -> Solved:
    """Solves the potential flow for one geometry and returns uncalibrated coefficients."""
    settings = fidelity_settings(fidelity)
    area = metrics.frontal_area
    rear_flow = compute_rear_flow(shape, area)

    report("MESHING", 0.0, "Generating cut-cell grid")
    symmetric = abs(flow.yaw_deg) < 1e-6
    grid = build_grid(
        metrics.length, shape.params["width"], shape.params["rideHeight"], shape.params["roofHeight"], fidelity, symmetric
    )
    model = build_solid_model(shape, rear_flow, 1.2 * settings["hx"], 1.2 * settings["hy"])
    apertures = compute_apertures(grid, model)
    active = mark_active_cells(grid, apertures)

    report("SOLVING", 0.0, "Solving potential flow")
    solution = solve_potential(
        grid,
        apertures,
        active,
        flow.yaw_deg,
        settings["tolerance"],
        on_progress=lambda fraction, iteration, residual: report(
            "SOLVING", fraction, f"Solving potential flow · iteration {iteration} · residual {residual:.1e}"
        ),
    )

    report("POST_PROCESSING", 0.0, "Integrating surface pressure")
    velocity = cell_velocities(grid, apertures, active, solution.phi, flow.yaw_deg)
    speed_squared = velocity.u**2 + velocity.v**2 + velocity.w**2
    # Bernoulli: Cp = 1 - (V / V_inf)^2, bounded below to tame corner singularities.
    cp = np.where(active, np.maximum(1 - speed_squared, RO["cpFloor"]), 0.0)

    field_pressure = _wake_boundary_pressure(grid, apertures, active, cp, model)
    empirical_base = rear_flow.base_pressure_coefficient
    if field_pressure is None:
        base_pressure = empirical_base
    else:
        clamped = min(max(field_pressure, RO["basePressureMin"]), RO["basePressureMax"])
        base_pressure = RO["basePressureBlend"] * empirical_base + (1 - RO["basePressureBlend"]) * clamped

    integrated = _integrate_pressure(grid, apertures, active, cp, velocity.fluid_fraction, model, base_pressure, area)

    wing_cl, wing_cd = wing_effect(shape, metrics, _wing_dynamic_pressure(grid, active, speed_squared, shape))
    splitter_cl, splitter_cd = splitter_effect(shape, metrics)
    cd_friction = friction_drag(metrics, flow)
    # Trailing vortices are not part of a potential solution. Their lift is tied to their drag
    # through the slant angle (the vortex force acts normal to the slanted surface).
    vortex_lift = rear_flow.vortex_drag / math.tan(max(rear_flow.effective_slant_deg, 8) * DEG_TO_RAD)

    def front_share(front: float, total: float) -> float:
        return front / total if abs(total) > 1e-9 else 0.5

    drag = [
        Item("pressure", "Surface pressure, attached flow (integrated)", integrated["cdAttached"]),
        Item("base", "Base pressure on separated surfaces (integrated)", integrated["cdBase"]),
        Item("vortex", "Rear-slant trailing vortices (closure)", rear_flow.vortex_drag),
        Item("underbody", "Underbody roughness (closure)", underbody_drag(shape)),
        Item("wheels", "Wheels and wheelhouses (closure)", wheel_drag(shape, metrics)),
        Item("friction", "Skin friction (closure)", cd_friction),
        *detail_drag_items(shape, metrics),
        Item("wing", "Rear wing (lifting-line)", wing_cd),
        Item("splitter", "Front splitter (closure)", splitter_cd),
    ]
    lift = [
        Item(
            "upper",
            "Upper-surface pressure (integrated)",
            integrated["clUpper"],
            front_share(integrated["clUpperFront"], integrated["clUpper"]),
        ),
        Item(
            "lower",
            "Underbody pressure (integrated)",
            integrated["clLower"],
            front_share(integrated["clLowerFront"], integrated["clLower"]),
        ),
        Item("vortex", "Rear-slant vortex lift (closure)", vortex_lift, DIST["slant"]),
        Item("wing", "Rear wing (lifting-line)", wing_cl, DIST["wing"]),
        Item("splitter", "Front splitter (closure)", splitter_cl, DIST["splitter"]),
    ]

    cd_zero_yaw = sum(item.value for item in drag)
    yaw = yaw_effects(shape, metrics, cd_zero_yaw, flow.yaw_deg)
    drag.append(Item("yaw", "Yaw-induced (closure)", yaw.cd_increment))
    lift.append(Item("yaw", "Yaw-induced (closure)", yaw.cl_increment, DIST["yaw"]))
    cl, cl_front, cl_rear = sum_lift(lift)

    raw = RawAero(
        cd=cd_zero_yaw + yaw.cd_increment,
        cl=cl,
        cl_front=cl_front,
        cl_rear=cl_rear,
        cs=yaw.cs,
        cm_yaw=yaw.cm_yaw,
        cd_friction=cd_friction,
        drag=drag,
        lift=lift,
        rear_flow=rear_flow.with_base_pressure(base_pressure),
    )
    diagnostics = {
        "cells": grid.nx * grid.ny * grid.nz,
        "fluidCells": int(active.sum()),
        "iterations": solution.iterations,
        "residual": solution.residual,
        "converged": solution.converged,
        "gridSize": [grid.nx, grid.ny, grid.nz],
        "blockageRatio": area / (2 * MODEL["tunnel"]["halfWidth"] * MODEL["tunnel"]["height"]),
        "pressureDragAttached": integrated["cdAttached"],
        "basePressureFromField": field_pressure,
    }
    field = None
    if build_field:
        field = _build_field(
            grid, active, velocity.u, velocity.v, velocity.w, cp, model, base_pressure, flow, fidelity
        )
    return Solved(raw=raw, diagnostics=diagnostics, field=field)


class ReducedOrderEngine(SimulationEngine):
    mode = "reduced-order"
    provenance = REDUCED_ORDER_PROVENANCE

    #: Uncalibrated reference solutions, keyed by reference geometry + fidelity (shared by all instances).
    _reference_cache: dict[str, RawAero] = {}
    _lock = threading.Lock()

    def availability(self) -> tuple[bool, str]:
        return True, "Built-in potential-flow solver (NumPy / SciPy); always available."

    def _reference(self, config: dict[str, Any], prepared: PreparedCase, report: ProgressReporter) -> tuple[RawAero, bool]:
        key = hash_value({"version": MODEL["version"], "geometry": config["referenceGeometry"], "fidelity": config["fidelity"]})
        with self._lock:
            cached = self._reference_cache.get(key)
        if cached is not None:
            return cached, True

        def reference_report(state: str, fraction: float, message: str) -> None:
            within = 0.05 * fraction if state == "MESHING" else 0.05 + 0.9 * fraction if state == "SOLVING" else 0.95
            report(state, 0.45 * within, f"Reference geometry · {message}")

        solved = solve_reduced_order(
            prepared.reference_shape,
            prepared.reference_metrics,
            prepared.calibration_flow,
            config["fidelity"],
            report=reference_report,
        )
        with self._lock:
            self._reference_cache[key] = solved.raw
        return solved.raw, False

    def simulate(
        self,
        config: dict[str, Any],
        report: ProgressReporter = no_progress,
        prepared: PreparedCase | None = None,
        want_field: bool = False,
    ) -> dict[str, Any]:
        report("PREPARING", 0.0, "Preparing geometry")
        prepared = prepared or prepare_case(config)
        raw_reference, was_cached = self._reference(config, prepared, report)
        share = 0.0 if was_cached else 0.45

        def main_report(state: str, fraction: float, message: str) -> None:
            within = 0.05 * fraction if state == "MESHING" else 0.05 + 0.9 * fraction if state == "SOLVING" else 0.96
            report(state, share + (1 - share) * within, message)

        solved = solve_reduced_order(
            prepared.shape, prepared.metrics, prepared.flow, config["fidelity"], build_field=want_field, report=main_report
        )
        result = assemble_result(
            config,
            prepared,
            solved.raw,
            raw_reference,
            mode=self.mode,
            provenance=self.provenance,
            uncertainty_model=MODEL["uncertainty"]["reducedOrder"],
            assumptions=REDUCED_ORDER_ASSUMPTIONS,
            solver={**solved.diagnostics, "rawCd": solved.raw.cd, "rawCl": solved.raw.cl},
        )
        if solved.field is not None:
            result["field"] = solved.field
        return result
