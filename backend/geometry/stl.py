"""Triangulated surfaces of the vehicle for CFD meshing (ASCII STL).

The body is lofted through the same cross-sections the simulator draws and
solves; wheels and aero devices are written as separate closed solids, which is
how surface-based meshers expect intersecting parts.
"""

from __future__ import annotations

import math

import numpy as np

from geometry.profile import (
    BodyShape,
    lower_z,
    plan_half_width,
    section_half_width,
    skirt_geometry,
    splitter_geometry,
    spoiler_geometry,
    upper_z,
    wheel_geometry,
    wing_geometry,
)
from physics.model import DEG_TO_RAD, MODEL

Triangles = np.ndarray  # shape (n, 3, 3)

_SIDE_POINTS = 20
_STATION_SPACING = 0.04


def body_surface(shape: BodyShape) -> Triangles:
    """Closed surface of the body: loft through the cross-sections plus a flat tail cap."""
    params = shape.params
    ride = params["rideHeight"]
    nose = MODEL["profile"]["noseRadiusUpper"]
    front = nose * (np.arange(12) / 12) ** 2
    count = max(round((shape.length - nose) / _STATION_SPACING), 8)
    xs = np.concatenate([front, nose + (shape.length - nose) * np.arange(count + 1) / count])

    z_low = lower_z(shape, xs)
    z_up = np.maximum(upper_z(shape, xs), z_low)
    plan = plan_half_width(shape, xs)
    t = np.arange(_SIDE_POINTS) / (_SIDE_POINTS - 1)
    # Heights clustered toward the rounded lower and upper edges.
    heights = z_low[:, None] + (z_up - z_low)[:, None] * (1 - np.cos(math.pi * t))[None, :] / 2
    widths = section_half_width(params, z_low[:, None], z_up[:, None], plan[:, None], heights)

    ring_size = 2 * _SIDE_POINTS + 2
    rings = np.zeros((len(xs), ring_size, 3))
    rings[:, :, 0] = xs[:, None]
    # bottom centre, +y side upward, top centre, -y side downward
    rings[:, 0, 2] = z_low + ride
    rings[:, 1 : _SIDE_POINTS + 1, 1] = widths
    rings[:, 1 : _SIDE_POINTS + 1, 2] = heights + ride
    rings[:, _SIDE_POINTS + 1, 2] = z_up + ride
    rings[:, _SIDE_POINTS + 2 :, 1] = -widths[:, ::-1]
    rings[:, _SIDE_POINTS + 2 :, 2] = heights[:, ::-1] + ride

    a = rings[:-1]
    b = rings[1:]
    a_next = np.roll(a, -1, axis=1)
    b_next = np.roll(b, -1, axis=1)
    side = np.concatenate(
        [np.stack([a, a_next, b], axis=2).reshape(-1, 3, 3), np.stack([a_next, b_next, b], axis=2).reshape(-1, 3, 3)]
    )
    last = rings[-1]
    centre = np.array([shape.length, 0.0, last[:, 2].mean()])
    cap = np.stack([np.broadcast_to(centre, last.shape), last, np.roll(last, -1, axis=0)], axis=1)
    triangles = np.concatenate([side, cap])
    return _drop_degenerate(triangles)


def _drop_degenerate(triangles: Triangles) -> Triangles:
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    return triangles[np.linalg.norm(normals, axis=1) > 1e-12]


def _box(centre: tuple[float, float, float], size: tuple[float, float, float], pitch_deg: float = 0.0) -> Triangles:
    """Closed box, optionally pitched about the Y axis (positive raises the +X end)."""
    half = np.asarray(size) / 2
    corners = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)], dtype=float) * half
    angle = pitch_deg * DEG_TO_RAD
    cos, sin = math.cos(angle), math.sin(angle)
    x = corners[:, 0] * cos - corners[:, 2] * sin
    z = corners[:, 0] * sin + corners[:, 2] * cos
    points = np.column_stack([x, corners[:, 1], z]) + np.asarray(centre)
    # Corner index = 4 * ix + 2 * iy + iz; faces wound counter-clockwise seen from outside.
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    triangles = []
    for q in quads:
        triangles.append([points[q[0]], points[q[1]], points[q[2]]])
        triangles.append([points[q[0]], points[q[2]], points[q[3]]])
    return np.asarray(triangles)


def _cylinder(centre: tuple[float, float, float], radius: float, width: float, segments: int = 48) -> Triangles:
    """Closed cylinder whose axis is the Y direction (a wheel)."""
    cx, cy, cz = centre
    angles = 2 * math.pi * np.arange(segments) / segments
    ring = np.column_stack([cx + radius * np.cos(angles), np.zeros(segments), cz + radius * np.sin(angles)])
    left = ring + np.array([0, cy - width / 2, 0])
    right = ring + np.array([0, cy + width / 2, 0])
    left_next = np.roll(left, -1, axis=0)
    right_next = np.roll(right, -1, axis=0)
    centre_left = np.array([cx, cy - width / 2, cz])
    centre_right = np.array([cx, cy + width / 2, cz])
    side = np.concatenate([np.stack([left, right, left_next], axis=1), np.stack([left_next, right, right_next], axis=1)])
    caps = np.concatenate(
        [
            np.stack([np.broadcast_to(centre_left, left.shape), left, left_next], axis=1),
            np.stack([np.broadcast_to(centre_right, right.shape), right_next, right], axis=1),
        ]
    )
    return np.concatenate([side, caps])


def wheel_surfaces(shape: BodyShape) -> Triangles:
    parts = []
    for wheel in wheel_geometry(shape):
        for side in (1, -1):
            parts.append(_cylinder((wheel.x, side * wheel.y, wheel.z), wheel.radius, wheel.width))
    return np.concatenate(parts)


def device_surfaces(shape: BodyShape) -> Triangles | None:
    """Spoiler, wing, splitter and skirts, where present."""
    params = shape.params
    ride = params["rideHeight"]
    parts: list[Triangles] = []

    spoiler = spoiler_geometry(shape)
    if spoiler.present:
        parts.append(
            _box(
                ((spoiler.x0 + spoiler.x1) / 2, 0.0, ride + (spoiler.z0 + spoiler.z1) / 2),
                (params["spoilerHeight"], 2 * spoiler.half_width, max(spoiler.thickness, 0.012)),
                pitch_deg=params["spoilerAngle"],
            )
        )
    wing = wing_geometry(shape)
    if wing.present:
        parts.append(_box((wing.xc, 0.0, ride + wing.zc), (wing.chord, wing.span, wing.thickness), pitch_deg=wing.angle_deg))
        strut_height = max(wing.zc - shape.tail_height, 0.02)
        for side in (1, -1):
            parts.append(_box((wing.xc, side * wing.span / 2, ride + wing.zc), (wing.chord * 1.15, 0.008, wing.chord * 0.5)))
            parts.append(
                _box((wing.xc, side * wing.span * 0.3, ride + (shape.tail_height + wing.zc) / 2), (0.07, 0.012, strut_height))
            )
    splitter = splitter_geometry(shape)
    if splitter.present:
        parts.append(
            _box(
                ((splitter.x0 + splitter.x1) / 2, 0.0, ride + splitter.thickness / 2),
                (splitter.x1 - splitter.x0, 2 * splitter.half_width, splitter.thickness),
            )
        )
    skirt = skirt_geometry(shape)
    if skirt.present:
        for side in (1, -1):
            parts.append(
                _box(
                    ((skirt.x0 + skirt.x1) / 2, side * (skirt.y_outer - skirt.thickness / 2), ride + (0.03 - skirt.depth) / 2),
                    (skirt.x1 - skirt.x0, skirt.thickness, skirt.depth + 0.03),
                )
            )
    return np.concatenate(parts) if parts else None


def to_ascii_stl(name: str, triangles: Triangles) -> str:
    """ASCII STL text for one named solid (coordinates in metres)."""
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = normals / np.where(lengths > 0, lengths, 1.0)
    lines = [f"solid {name}"]
    for normal, triangle in zip(normals, triangles):
        lines.append(f" facet normal {normal[0]:.6e} {normal[1]:.6e} {normal[2]:.6e}")
        lines.append("  outer loop")
        for vertex in triangle:
            lines.append(f"   vertex {vertex[0]:.6e} {vertex[1]:.6e} {vertex[2]:.6e}")
        lines.append("  endloop")
        lines.append(" endfacet")
    lines.append(f"endsolid {name}")
    return "\n".join(lines) + "\n"
