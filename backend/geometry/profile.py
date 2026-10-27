"""Procedural geometry kernel (mirror of lib/geometry/profile.ts).

The body is described by analytic functions of the longitudinal coordinate x
(0 at the nose, increasing toward the tail = downstream): the upper surface,
the underbody, and the plan half-width, plus a cross-section rule built from
them. The same functions drive the frontal-area integration, the flow solver's
inside/outside test and the STL written for CFD.

Coordinates: X longitudinal, Y lateral, Z vertical. "Body frame" heights are
measured from the floor plane; absolute height = rideHeight + body height.

All functions accept NumPy arrays as well as scalars.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from geometry.parameters import Geometry, complete_geometry
from physics.model import DEG_TO_RAD, MODEL

P = MODEL["profile"]

_SMOOTH_OFFSETS = (-1.0, -0.5, 0.0, 0.5, 1.0)
_SMOOTH_WEIGHTS = (1 / 9, 2 / 9, 3 / 9, 2 / 9, 1 / 9)


@dataclass
class BodyShape:
    """Knots and derived dimensions of the body, precomputed once per geometry."""

    params: Geometry
    length: float
    roof_edge_height: float
    x_cowl: float
    x_roof_start: float
    x_roof_end: float
    x_deck_start: float
    deck_height: float
    x_diffuser_start: float
    diffuser_exit_height: float
    diffuser_slope: float
    stagnation_height: float
    front_axle_x: float
    rear_axle_x: float
    knots_x: np.ndarray
    knots_z: np.ndarray
    tail_height: float = 0.0
    wheel_centre_y: float = 0.0
    roof_segment: int = field(default=2)


def build_body_shape(params: Geometry) -> BodyShape:
    params = complete_geometry(params)
    length = params["frontOverhang"] + params["wheelbase"] + params["rearOverhang"]
    roof_edge = params["roofHeight"] - P["roofCrown"]
    deck_height = params["rearBumperHeight"]

    x_cowl = params["hoodLength"]
    windshield_run = max(roof_edge - params["hoodHeight"], 0.0) / math.tan(params["windshieldAngle"] * DEG_TO_RAD)
    x_roof_start = x_cowl + windshield_run

    x_deck_start = length - params["rearDeckLength"]
    rear_window_run = max(roof_edge - deck_height, 0.0) / math.tan(params["rearWindowAngle"] * DEG_TO_RAD)
    x_roof_end = x_deck_start - rear_window_run

    knots_x = [0.0, x_cowl, x_roof_start, x_roof_end, x_deck_start]
    knots_z = [params["frontBumperHeight"], params["hoodHeight"], roof_edge, roof_edge, deck_height]
    if params["rearDeckLength"] > 1e-6:
        knots_x.append(length)
        knots_z.append(deck_height - P["deckDrop"])

    diffuser_length = min(params["diffuserLength"], length * 0.45)
    diffuser_slope_raw = math.tan(params["diffuserAngle"] * DEG_TO_RAD)
    diffuser_exit = min(diffuser_length * diffuser_slope_raw, 0.6 * deck_height)

    shape = BodyShape(
        params=params,
        length=length,
        roof_edge_height=roof_edge,
        x_cowl=x_cowl,
        x_roof_start=x_roof_start,
        x_roof_end=x_roof_end,
        x_deck_start=x_deck_start,
        deck_height=deck_height,
        x_diffuser_start=length - diffuser_length,
        diffuser_exit_height=diffuser_exit,
        diffuser_slope=diffuser_exit / diffuser_length if diffuser_length > 1e-6 else 0.0,
        stagnation_height=P["noseStagnationFraction"] * params["frontBumperHeight"],
        front_axle_x=params["frontOverhang"],
        rear_axle_x=params["frontOverhang"] + params["wheelbase"],
        knots_x=np.asarray(knots_x, dtype=float),
        knots_z=np.asarray(knots_z, dtype=float),
    )
    shape.tail_height = float(upper_z(shape, length))
    axle_half_width = min(
        float(plan_half_width(shape, shape.front_axle_x)),
        float(plan_half_width(shape, shape.rear_axle_x)),
    )
    shape.wheel_centre_y = (
        axle_half_width - params["tireWidth"] / 2 - P["wheelInset"] + P["wheelExposureOffset"] * params["wheelExposure"]
    )
    return shape


def _upper_polyline(shape: BodyShape, x: np.ndarray) -> np.ndarray:
    """Unsmoothed upper polyline with a parabolic roof crown. x is clamped to the body."""
    kx, kz = shape.knots_x, shape.knots_z
    z = _interp_knots(kx, kz, x)
    x0, x1 = kx[shape.roof_segment], kx[shape.roof_segment + 1]
    span = x1 - x0
    if span > 1e-9:
        on_roof = (x > x0) & (x <= x1)
        u = 2 * (x - x0) / span - 1
        z = np.where(on_roof, z + P["roofCrown"] * (1 - u * u), z)
    return z


def _interp_knots(kx: np.ndarray, kz: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Piecewise-linear interpolation that takes the later knot where two knots coincide."""
    x = np.asarray(x, dtype=float)
    last = len(kx) - 1
    index = np.clip(np.searchsorted(kx, x, side="left") - 1, 0, last - 1)
    x0 = kx[index]
    x1 = kx[index + 1]
    span = x1 - x0
    safe = np.where(span > 1e-9, span, 1.0)
    t = np.where(span > 1e-9, (x - x0) / safe, 1.0)
    z = kz[index] + (kz[index + 1] - kz[index]) * t
    z = np.where(x <= kx[0], kz[0], z)
    return np.where(x >= kx[last], kz[last], z)


def _nose_blend(t: np.ndarray) -> np.ndarray:
    """Quarter super-ellipse used to round the nose: 0 at t=0, 1 at t=1."""
    exponent = P["noseExponent"]
    clipped = np.clip(t, 0.0, 1.0)
    return (1 - (1 - clipped) ** exponent) ** (1 / exponent)


def upper_z(shape: BodyShape, x) -> np.ndarray:
    """Upper surface height above the floor plane at station x."""
    x = np.asarray(x, dtype=float)
    z = np.zeros_like(x)
    for offset, weight in zip(_SMOOTH_OFFSETS, _SMOOTH_WEIGHTS):
        z = z + weight * _upper_polyline(shape, x + P["smoothRadius"] * offset)
    zs = shape.stagnation_height
    radius = P["noseRadiusUpper"]
    return np.where(x < radius, zs + (z - zs) * _nose_blend(x / radius), z)


def lower_z(shape: BodyShape, x) -> np.ndarray:
    """Underbody height above the floor plane at station x (0 on the flat floor)."""
    x = np.asarray(x, dtype=float)
    radius = P["noseRadiusLower"]
    nose = shape.stagnation_height * (1 - _nose_blend(x / radius))
    diffuser = (x - shape.x_diffuser_start) * shape.diffuser_slope
    return np.where(x < radius, nose, np.where(x > shape.x_diffuser_start, diffuser, 0.0))


def plan_half_width(shape: BodyShape, x) -> np.ndarray:
    """Half-width of the body in plan view at station x (at beltline level)."""
    x = np.asarray(x, dtype=float)
    params, length = shape.params, shape.length
    factor = np.ones_like(x)
    front_extent = P["frontTaperExtent"] * length
    u = 1 - x / front_extent
    factor = np.where(x < front_extent, factor - params["frontTaper"] * u * u, factor)
    rear_start = P["rearTaperStart"] * length
    u = (x - rear_start) / (length - rear_start)
    factor = np.where(x > rear_start, factor - params["rearTaper"] * u * u, factor)
    radius = P["planNoseRadius"]
    blunt = P["planNoseBluntness"]
    factor = np.where(x < radius, factor * (blunt + (1 - blunt) * _nose_blend(x / radius)), factor)
    return 0.5 * params["width"] * factor


def section_half_width(params: Geometry, zl, zu, wb, zb) -> np.ndarray:
    """Cross-section rule: half-width at body-frame height zb; 0 outside the section."""
    zl, zu, wb, zb = np.broadcast_arrays(
        np.asarray(zl, dtype=float), np.asarray(zu, dtype=float), np.asarray(wb, dtype=float), np.asarray(zb, dtype=float)
    )
    height = zu - zl
    w = wb.copy()
    # Greenhouse: above the beltline the sides lean inward at a constant angle (tumblehome).
    greenhouse = params["roofHeight"] - P["roofCrown"] - params["beltHeight"]
    if greenhouse > 1e-6:
        t = np.minimum((zb - params["beltHeight"]) / greenhouse, 1.0)
        w = np.where(zb > params["beltHeight"], wb * (1 - (1 - params["cabinWidthRatio"]) * t), w)
    # Rounded lower (sill) and upper (roof / shoulder) edges.
    rb = np.minimum(P["bottomEdgeRadius"], 0.45 * height)
    db = zb - zl
    w = np.where(db < rb, w - (rb - np.sqrt(np.maximum(rb * rb - (rb - db) ** 2, 0.0))), w)
    rt = np.minimum(P["topEdgeRadius"], 0.45 * height)
    dt = zu - zb
    w = np.where(dt < rt, w - (rt - np.sqrt(np.maximum(rt * rt - (rt - dt) ** 2, 0.0))), w)
    w = np.maximum(w, 0.0)
    return np.where((zb < zl) | (zb > zu), 0.0, w)


def half_width(shape: BodyShape, x, zb) -> np.ndarray:
    """Half-width of the body at station x and body-frame height zb (0 outside the body)."""
    x = np.asarray(x, dtype=float)
    w = section_half_width(shape.params, lower_z(shape, x), upper_z(shape, x), plan_half_width(shape, x), zb)
    return np.where((x < 0) | (x > shape.length), 0.0, w)


# ---------------------------------------------------------------------------
# Aero devices and wheels. All heights are in the body frame unless noted.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SpoilerGeometry:
    present: bool
    x0: float
    z0: float
    x1: float
    z1: float
    half_width: float
    rise: float
    thickness: float


def spoiler_geometry(shape: BodyShape) -> SpoilerGeometry:
    params, length = shape.params, shape.length
    blade = params["spoilerHeight"]
    angle = params["spoilerAngle"] * DEG_TO_RAD
    tail_half_width = float(plan_half_width(shape, length))
    x0 = length - 0.02
    z0 = shape.tail_height
    return SpoilerGeometry(
        present=blade > 1e-4,
        x0=x0,
        z0=z0,
        x1=x0 + blade * math.cos(angle),
        z1=z0 + blade * math.sin(angle),
        half_width=min(params["spoilerWidth"] / 2, tail_half_width),
        rise=blade * math.sin(angle),
        thickness=P["spoilerThickness"],
    )


@dataclass(frozen=True)
class WingGeometry:
    present: bool
    xc: float
    zc: float
    chord: float
    span: float
    thickness: float
    angle_deg: float


def wing_geometry(shape: BodyShape) -> WingGeometry:
    params, length = shape.params, shape.length
    chord = params["wingChord"]
    return WingGeometry(
        present=chord > 1e-4,
        xc=length - 0.05 - chord / 2,
        zc=shape.tail_height + P["wingMountHeight"],
        chord=chord,
        span=2 * float(plan_half_width(shape, length)) * P["wingSpanRatio"],
        thickness=chord * P["wingThicknessRatio"],
        angle_deg=params["wingAngle"],
    )


@dataclass(frozen=True)
class SplitterGeometry:
    present: bool
    x0: float
    x1: float
    half_width: float
    thickness: float


def splitter_geometry(shape: BodyShape) -> SplitterGeometry:
    params = shape.params
    return SplitterGeometry(
        present=params["splitterExtension"] > 1e-4,
        x0=-params["splitterExtension"],
        x1=P["noseRadiusLower"] + 0.1,
        half_width=MODEL["lift"]["splitterWidthFactor"] * 0.5 * params["width"] * (1 - params["frontTaper"]),
        thickness=P["splitterThickness"],
    )


@dataclass(frozen=True)
class SkirtGeometry:
    present: bool
    x0: float
    x1: float
    y_outer: float
    thickness: float
    depth: float


def skirt_geometry(shape: BodyShape) -> SkirtGeometry:
    params = shape.params
    radius = params["wheelDiameter"] / 2
    x0 = shape.front_axle_x + radius + 0.06
    x1 = shape.rear_axle_x - radius - 0.06
    return SkirtGeometry(
        present=params["sideSkirtDepth"] > 1e-4 and x1 > x0,
        x0=x0,
        x1=x1,
        y_outer=float(plan_half_width(shape, 0.5 * (x0 + x1))) - 0.01,
        thickness=P["skirtThickness"],
        depth=params["sideSkirtDepth"],
    )


@dataclass(frozen=True)
class MirrorGeometry:
    present: bool
    x0: float
    x1: float
    z0: float
    z1: float
    y0: float
    y1: float
    area: float


def mirror_geometry(shape: BodyShape) -> MirrorGeometry:
    """Door mirrors, as the box each housing fills (mirrors mirrorGeometry in lib/geometry/profile.ts)."""
    params = shape.params
    width = params["mirrorWidth"]
    height = P["mirrorAspect"] * width
    x0 = shape.x_cowl + P["mirrorBehindCowl"]
    x1 = x0 + P["mirrorDepthRatio"] * width
    side = float(plan_half_width(shape, 0.5 * (x0 + x1)))
    z0 = params["beltHeight"] + P["mirrorAboveBelt"]
    return MirrorGeometry(
        present=width > 0.01 and x1 < shape.length,
        x0=x0,
        x1=x1,
        z0=z0,
        z1=z0 + height,
        y0=side - 0.02,
        y1=side + width,
        area=width * height,
    )


@dataclass(frozen=True)
class WheelGeometry:
    x: float
    y: float
    z: float
    radius: float
    width: float


def wheel_geometry(shape: BodyShape) -> list[WheelGeometry]:
    params = shape.params
    radius = params["wheelDiameter"] / 2
    return [
        WheelGeometry(x=x, y=shape.wheel_centre_y, z=radius, radius=radius, width=params["tireWidth"])
        for x in (shape.front_axle_x, shape.rear_axle_x)
    ]
