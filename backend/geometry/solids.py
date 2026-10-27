"""Solid model used by the flow solver (mirror of lib/geometry/solids.ts).

The body, wheels, spoiler and skirts, plus the wake displacement body that
stands in for the separated region. Every solid is symmetric about Y = 0 and is
described, for a given (x, z), as intervals of |y|:

* one interval starting at the centreline, [0, w0] (body section and spoiler),
* at most one detached interval [e0, e1] (a wheel or a skirt; they never share
  a station),
* the wake, also from the centreline, [0, wake half-width].

All query functions are vectorised over arrays of points.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from geometry.profile import (
    BodyShape,
    lower_z,
    plan_half_width,
    section_half_width,
    mirror_geometry,
    skirt_geometry,
    spoiler_geometry,
    upper_z,
    wheel_geometry,
)
from physics.model import MODEL
from physics.rear_flow import RearFlow

RO = MODEL["reducedOrder"]
R = MODEL["rearFlow"]

#: Grid faces are aligned with the floor, roof, nose and tail; tolerate round-off there.
EDGE_TOLERANCE = 1e-7


@dataclass
class Wake:
    x_start: float
    xs: float
    xc: float
    z_sep_top: float
    z_base_bottom: float
    z_closure: float
    sep_low: float
    sep_up: float
    sep_plan: float
    tail_low: float
    tail_up: float
    tail_plan: float
    has_spoiler: bool
    spoiler_tip_x: float
    spoiler_tip_z: float
    spoiler_half_width: float
    bubble: float
    x_bubble_start: float
    z_bubble_start: float
    bubble_slope: float
    roof_low: float
    roof_up: float
    roof_plan: float


@dataclass
class SolidModel:
    shape: BodyShape
    ride: float
    length: float
    table_step: float
    table_count: int
    table_z_low: np.ndarray
    table_z_up: np.ndarray
    table_plan: np.ndarray
    #: (x, y0, y1, radius) per axle
    wheels: list[tuple[float, float, float, float]]
    spoiler: dict[str, float]
    spoiler_present: bool
    skirt: dict[str, float]
    skirt_present: bool
    # Door mirror housing (absolute heights): the body is that much wider where it sits.
    mirror: dict[str, float]
    mirror_present: bool
    wake: Wake
    x_min: float
    x_max: float
    y_max: float
    z_max: float


def build_solid_model(shape: BodyShape, rear_flow: RearFlow, min_thickness_x: float, min_thickness_y: float) -> SolidModel:
    params, length = shape.params, shape.length
    ride = params["rideHeight"]

    step = RO["tableStep"]
    count = math.ceil(length / step) + 1
    table_x = np.minimum(np.arange(count) * step, length)

    wheels = [(w.x, w.y - w.width / 2, w.y + w.width / 2, w.radius) for w in wheel_geometry(shape)]

    blade = spoiler_geometry(shape)
    spoiler = {
        "x0": blade.x0,
        "x1": max(blade.x1, blade.x0 + 1e-4),
        "xEnd": max(blade.x1, blade.x0 + min_thickness_x),
        "zBottom": ride + blade.z0 - 0.05,
        "z0": ride + blade.z0,
        "rise": blade.rise,
        "top": ride + blade.z1 + blade.thickness,
        "halfWidth": blade.half_width,
    }

    sill = skirt_geometry(shape)
    skirt_thickness = max(sill.thickness, min_thickness_y)
    skirt = {
        "x0": sill.x0,
        "x1": sill.x1,
        "y0": sill.y_outer - skirt_thickness,
        "y1": sill.y_outer,
        "z0": ride - sill.depth,
        "z1": ride + 0.03,
    }

    # Like the other thin parts, a mirror is given at least the size the grid can see.
    housing = mirror_geometry(shape)
    mirror = {
        "x0": housing.x0,
        "x1": max(housing.x1, housing.x0 + min_thickness_x),
        "y1": housing.y1,
        "z0": ride + housing.z0,
        "z1": ride + housing.z1,
    }

    xs = min(rear_flow.separation_x, length)
    sep_up = float(upper_z(shape, xs))
    z_sep_top = ride + sep_up
    z_base_bottom = ride + shape.diffuser_exit_height
    attached = 1 - rear_flow.separation_fraction
    bubble = rear_flow.bubble_fraction if rear_flow.bubble_fraction > 0.02 else 0.0
    x_bubble_start = shape.x_roof_end
    roof_up = float(upper_z(shape, x_bubble_start))
    wake = Wake(
        x_start=min(xs, x_bubble_start) if bubble > 0 else xs,
        xs=xs,
        xc=length + max(rear_flow.wake_length, 0.3),
        z_sep_top=z_sep_top,
        z_base_bottom=z_base_bottom,
        z_closure=z_base_bottom + R["wakeClosureHeightFraction"] * (z_sep_top - z_base_bottom),
        sep_low=float(lower_z(shape, xs)),
        sep_up=sep_up,
        sep_plan=float(plan_half_width(shape, xs)),
        tail_low=float(lower_z(shape, length)),
        tail_up=shape.tail_height,
        tail_plan=float(plan_half_width(shape, length)),
        has_spoiler=blade.present and blade.rise > 1e-4 and attached > 0.05,
        spoiler_tip_x=spoiler["xEnd"],
        spoiler_tip_z=ride + shape.tail_height + attached * blade.rise,
        spoiler_half_width=blade.half_width,
        bubble=bubble,
        x_bubble_start=x_bubble_start,
        z_bubble_start=ride + roof_up,
        bubble_slope=(roof_up - shape.tail_height) / max(length - x_bubble_start, 1e-6),
        roof_low=float(lower_z(shape, x_bubble_start)),
        roof_up=roof_up,
        roof_plan=float(plan_half_width(shape, x_bubble_start)),
    )

    z_max = ride + params["roofHeight"]
    if blade.present:
        z_max = max(z_max, spoiler["top"])
    return SolidModel(
        shape=shape,
        ride=ride,
        length=length,
        table_step=step,
        table_count=count,
        table_z_low=lower_z(shape, table_x),
        table_z_up=upper_z(shape, table_x),
        table_plan=plan_half_width(shape, table_x),
        wheels=wheels,
        spoiler=spoiler,
        spoiler_present=blade.present,
        skirt=skirt,
        skirt_present=sill.present,
        mirror=mirror,
        mirror_present=housing.present,
        wake=wake,
        x_min=0.0,
        x_max=wake.xc,
        y_max=max(0.5 * params["width"] + (0.02 if sill.present else 0.0), mirror["y1"] if housing.present else 0.0) + 0.06,
        z_max=z_max,
    )


def table_section(model: SolidModel, x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Section of the body at stations x from the table: (z_low, z_up, plan, valid)."""
    x = np.asarray(x, dtype=float)
    valid = (x >= -EDGE_TOLERANCE) & (x <= model.length + EDGE_TOLERANCE)
    f = np.clip(x, 0.0, model.length) / model.table_step
    i = np.minimum(np.floor(f).astype(int), model.table_count - 2)
    t = f - i
    z_low = model.table_z_low[i] + (model.table_z_low[i + 1] - model.table_z_low[i]) * t
    z_up = model.table_z_up[i] + (model.table_z_up[i + 1] - model.table_z_up[i]) * t
    plan = model.table_plan[i] + (model.table_plan[i + 1] - model.table_plan[i]) * t
    return z_low, z_up, plan, valid


def _spoiler_top(model: SolidModel, x: np.ndarray) -> np.ndarray:
    s = model.spoiler
    t = np.minimum((x - s["x0"]) / (s["x1"] - s["x0"]), 1.0)
    return s["z0"] + s["rise"] * t + (s["top"] - s["z0"] - s["rise"])


def body_extents(model: SolidModel, x, z) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """|y| occupied by the real solids at points (x, z).

    Returns (w0, e0, e1): the interval [0, w0] from the centreline (w0 = 0 when
    absent) and the detached interval [e0, e1] (e1 <= e0 when absent).
    """
    x, z = np.broadcast_arrays(np.asarray(x, dtype=float), np.asarray(z, dtype=float))
    z_low, z_up, plan, valid = table_section(model, x)
    zb = z - model.ride
    zb = np.where((zb < z_low) & (zb > z_low - EDGE_TOLERANCE), z_low, zb)
    zb = np.where((zb > z_up) & (zb < z_up + EDGE_TOLERANCE), z_up, zb)
    w0 = np.where(valid, section_half_width(model.shape.params, z_low, z_up, plan, zb), 0.0)

    if model.mirror_present:
        m = model.mirror
        in_mirror = (w0 > 0) & (x >= m["x0"]) & (x <= m["x1"]) & (z >= m["z0"]) & (z <= m["z1"])
        w0 = np.where(in_mirror, np.maximum(w0, m["y1"]), w0)

    if model.spoiler_present:
        s = model.spoiler
        in_spoiler = (x >= s["x0"]) & (x <= s["xEnd"]) & (z >= s["zBottom"]) & (z <= _spoiler_top(model, x))
        w0 = np.where(in_spoiler, np.maximum(w0, s["halfWidth"]), w0)

    e0 = np.zeros_like(x)
    e1 = np.zeros_like(x)
    for wx, y0, y1, radius in model.wheels:
        in_wheel = (x - wx) ** 2 + (z - radius) ** 2 <= radius * radius
        e0 = np.where(in_wheel, y0, e0)
        e1 = np.where(in_wheel, y1, e1)
    if model.skirt_present:
        k = model.skirt
        in_skirt = (x >= k["x0"]) & (x <= k["x1"]) & (z >= k["z0"]) & (z <= k["z1"])
        e0 = np.where(in_skirt, k["y0"], e0)
        e1 = np.where(in_skirt, k["y1"], e1)
    return w0, e0, e1


def wake_bounds(model: SolidModel, x) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Lower and upper bounds of the wake displacement body at stations x: (bottom, top, valid)."""
    x = np.asarray(x, dtype=float)
    wake, length = model.wake, model.length
    in_range = (x >= wake.x_start) & (x <= wake.xc)

    top = np.full_like(x, -np.inf)
    xi = (x - wake.xs) / (wake.xc - wake.xs)
    # Main wake: leaves the surface tangentially (horizontal) and closes at zClosure.
    top = np.where(x >= wake.xs, wake.z_sep_top - (wake.z_sep_top - wake.z_closure) * xi * xi, top)
    if wake.has_spoiler:
        xt = (x - wake.spoiler_tip_x) / (wake.xc - wake.spoiler_tip_x)
        tip = wake.z_closure + (wake.spoiler_tip_z - wake.z_closure) * (1 - xt * xt)
        top = np.where(x >= wake.spoiler_tip_x, np.maximum(top, tip), top)

    _, z_up, _, _ = table_section(model, x)
    over_body = x <= length
    # Over the body the separated region sits on top of the upper surface.
    bottom_body = model.ride + z_up
    if wake.bubble > 0:
        # Separation bubble: bounded by the straight streamline from the roof edge to the tail edge.
        line = wake.z_bubble_start - (x - wake.x_bubble_start) * wake.bubble_slope
        bubble_top = bottom_body + wake.bubble * np.maximum(line - bottom_body, 0.0)
        top = np.where(over_body & (x >= wake.x_bubble_start), np.maximum(top, bubble_top), top)
    xl = (x - length) / (wake.xc - length)
    bottom_wake = wake.z_base_bottom + (wake.z_closure - wake.z_base_bottom) * xl * xl
    bottom = np.where(over_body, bottom_body, bottom_wake)
    valid = in_range & (top > bottom)
    return bottom, top, valid


def wake_half_width(model: SolidModel, x, z) -> np.ndarray:
    """Half-width of the wake displacement body at points (x, z); 0 outside it."""
    x, z = np.broadcast_arrays(np.asarray(x, dtype=float), np.asarray(z, dtype=float))
    bottom, top, valid = wake_bounds(model, x)
    inside = valid & (z >= bottom) & (z <= top)
    wake, params = model.wake, model.shape.params
    zb = z - model.ride
    # The wake inherits the cross-section of the body where the flow separated.
    w = section_half_width(params, wake.sep_low, wake.sep_up, wake.sep_plan, np.minimum(zb, wake.sep_up - 1e-6))
    w = np.maximum(w, section_half_width(params, wake.tail_low, wake.tail_up, wake.tail_plan, zb))
    if wake.has_spoiler:
        in_spoiler = (zb >= wake.tail_up - 0.05) & (z <= wake.spoiler_tip_z + 0.02)
        w = np.where(in_spoiler, np.maximum(w, wake.spoiler_half_width), w)
    if wake.bubble > 0:
        roof = section_half_width(params, wake.roof_low, wake.roof_up, wake.roof_plan, np.minimum(zb, wake.roof_up - 1e-6))
        w = np.where(x <= model.length, np.maximum(w, roof), w)
    xl = (x - model.length) / (wake.xc - model.length)
    w = np.where(x > model.length, w * (1 - RO["wakeWidthTaper"] * xl * xl), w)
    return np.where(inside, w, 0.0)


def x_breakpoints(model: SolidModel, include_wake: bool) -> np.ndarray:
    """Stations in x where a solid starts or ends (used to place integration samples)."""
    points = [0.0, model.length]
    for wx, _, _, radius in model.wheels:
        points += [wx - radius, wx + radius]
    if model.spoiler_present:
        points += [model.spoiler["x0"], model.spoiler["xEnd"]]
    if model.skirt_present:
        points += [model.skirt["x0"], model.skirt["x1"]]
    if model.mirror_present:
        points += [model.mirror["x0"], model.mirror["x1"]]
    if include_wake:
        points += [model.wake.x_start, model.wake.xs, model.wake.xc]
    return np.sort(np.asarray(points, dtype=float))


def z_breakpoints(model: SolidModel, x: float, include_wake: bool) -> np.ndarray:
    """Heights at station x where a solid starts or ends."""
    points: list[float] = []
    z_low, z_up, _, valid = table_section(model, np.asarray(x))
    if bool(valid):
        points += [model.ride + float(z_low), model.ride + float(z_up)]
    for wx, _, _, radius in model.wheels:
        h2 = radius * radius - (x - wx) ** 2
        if h2 > 0:
            h = math.sqrt(h2)
            points += [radius - h, radius + h]
    if model.spoiler_present and model.spoiler["x0"] <= x <= model.spoiler["xEnd"]:
        points += [model.spoiler["zBottom"], float(_spoiler_top(model, np.asarray(x)))]
    if model.skirt_present and model.skirt["x0"] <= x <= model.skirt["x1"]:
        points += [model.skirt["z0"], model.skirt["z1"]]
    if model.mirror_present and model.mirror["x0"] <= x <= model.mirror["x1"]:
        points += [model.mirror["z0"], model.mirror["z1"]]
    if include_wake:
        bottom, top, ok = wake_bounds(model, np.asarray(x))
        if bool(ok):
            points += [float(bottom), float(top)]
    return np.asarray(points, dtype=float)


def inside_body(model: SolidModel, x, y, z) -> np.ndarray:
    """True where the point lies inside a real solid (not the wake)."""
    w0, e0, e1 = body_extents(model, x, z)
    ay = np.abs(np.asarray(y, dtype=float))
    return ((w0 > 0) & (ay <= w0)) | ((e1 > e0) & (ay >= e0) & (ay <= e1))


def wake_coordinates(model: SolidModel, x, y, z) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Normalised wake coordinates: (inside, zeta, eta, height)."""
    x, y, z = np.broadcast_arrays(np.asarray(x, dtype=float), np.asarray(y, dtype=float), np.asarray(z, dtype=float))
    half_width = wake_half_width(model, x, z)
    inside = (half_width > 0) & (np.abs(y) <= half_width)
    bottom, top, _ = wake_bounds(model, x)
    height = np.where(inside, top - bottom, 1.0)
    zeta = np.where(inside, (z - bottom) / height, 0.0)
    eta = np.where(inside, np.abs(y) / np.where(half_width > 0, half_width, 1.0), 0.0)
    return inside, zeta, eta, height
