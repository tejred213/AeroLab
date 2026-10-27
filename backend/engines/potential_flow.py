"""Mode B numerical core (mirror of lib/simulation/potentialFlow.ts).

Steady incompressible potential flow about the vehicle and its wake
displacement body, on a rectilinear cut-cell finite-volume grid.

Unknown: perturbation potential phi' with velocity u = U_inf + grad(phi').
Each cell conserves volume flux through the open part of its faces:

    sum_f a_f A_f (U_inf . n_f + d(phi')/dn_f) = 0

where a_f is the open-area fraction ("aperture") of face f.

Boundary conditions: ground and symmetry plane are walls; the inlet has uniform
inflow; the side, top and outlet boundaries are constant-pressure (open-jet)
boundaries, phi' = 0.

This is an inviscid model. Separation, base pressure and friction are NOT
solved; they are added as empirical closures in reduced_order.py.

Arrays are indexed [k, j, i] (z, y, x), so that flattening gives the same cell
numbering as the TypeScript implementation: c = i + nx * (j + ny * k).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np
from scipy.sparse import csr_matrix, diags
from scipy.sparse.csgraph import connected_components
from scipy.sparse.linalg import LinearOperator, cg

from geometry.solids import SolidModel, body_extents, wake_half_width, x_breakpoints, z_breakpoints
from physics.model import DEG_TO_RAD, MODEL

RO = MODEL["reducedOrder"]
TUNNEL = MODEL["tunnel"]

_GAUSS = (0.5 - 0.5 / math.sqrt(3), 0.5 + 0.5 / math.sqrt(3))
_GROUND_SAMPLE_HEIGHT = 0.01


@dataclass
class Grid:
    nx: int
    ny: int
    nz: int
    xf: np.ndarray
    yf: np.ndarray
    zf: np.ndarray
    xc: np.ndarray
    yc: np.ndarray
    zc: np.ndarray
    symmetric: bool


def fidelity_settings(fidelity: str) -> dict[str, float]:
    return RO["fidelity"][fidelity]


def _build_axis(lo: float, fine_lo: float, zones: list[tuple[float, float]], hi: float, growth: float) -> np.ndarray:
    """Uniform zones between fine_lo and the last zone end, then cells growing geometrically to lo and hi."""
    faces = [fine_lo]
    position = fine_lo
    for to, h in zones:
        count = max(1, _round_half_up((to - position) / h))
        step = (to - position) / count
        for i in range(1, count):
            faces.append(position + step * i)
        faces.append(to)
        position = to
    h = zones[-1][1]
    while position < hi - 1e-9:
        h *= growth
        position += h
        if hi - position < 0.5 * h:
            position = hi
        faces.append(min(position, hi))
    if lo < fine_lo - 1e-9:
        lower: list[float] = []
        h = zones[0][1]
        position = fine_lo
        while position > lo + 1e-9:
            h *= growth
            position -= h
            if position - lo < 0.5 * h:
                position = lo
            lower.append(max(position, lo))
        lower.reverse()
        faces = lower + faces
    return np.asarray(faces, dtype=float)


def _round_half_up(value: float) -> int:
    """JavaScript's Math.round (ties toward +infinity), so both implementations build the same grid."""
    return math.floor(value + 0.5)


def build_grid(length: float, width: float, ride_height: float, roof_height: float, fidelity: str, symmetric: bool) -> Grid:
    """Rectilinear grid with faces on the floor plane, roof crown, nose, tail and body sides."""
    f = fidelity_settings(fidelity)
    half_width = width / 2
    roof = ride_height + roof_height
    growth = RO["growth"]
    xf = _build_axis(
        TUNNEL["xMin"],
        -TUNNEL["upstreamFine"],
        [(0.0, f["hx"]), (length, f["hx"]), (length + TUNNEL["downstreamFine"], f["hx"])],
        TUNNEL["xMax"],
        growth,
    )
    lateral = half_width + TUNNEL["lateralFine"]
    if symmetric:
        yf = _build_axis(0.0, 0.0, [(half_width, f["hy"]), (lateral, f["hy"])], TUNNEL["halfWidth"], growth)
    else:
        yf = _build_axis(
            -TUNNEL["halfWidth"],
            -lateral,
            [(-half_width, f["hy"]), (half_width, f["hy"]), (lateral, f["hy"])],
            TUNNEL["halfWidth"],
            growth,
        )
    lower_body = min(ride_height + TUNNEL["groundZone"], 0.5 * (ride_height + roof))
    zf = _build_axis(
        0.0,
        0.0,
        [
            (ride_height, ride_height / f["gapCells"]),
            (lower_body, f["hzGround"]),
            (roof, f["hzBody"]),
            (roof + TUNNEL["aboveFine"], f["hzBody"]),
        ],
        TUNNEL["height"],
        growth,
    )
    centres = lambda faces: 0.5 * (faces[:-1] + faces[1:])  # noqa: E731
    return Grid(
        nx=len(xf) - 1,
        ny=len(yf) - 1,
        nz=len(zf) - 1,
        xf=xf,
        yf=yf,
        zf=zf,
        xc=centres(xf),
        yc=centres(yf),
        zc=centres(zf),
        symmetric=symmetric,
    )


# ---------------------------------------------------------------------------
# Apertures
# ---------------------------------------------------------------------------


@dataclass
class Apertures:
    """Open fraction of each face: b* for the real solids only, u* including the wake body."""

    bx: np.ndarray  # (nz, ny, nx + 1)
    by: np.ndarray  # (nz, ny + 1, nx)
    bz: np.ndarray  # (nz + 1, ny, nx)
    ux: np.ndarray
    uy: np.ndarray
    uz: np.ndarray


def _cell_range(faces: np.ndarray, lo: float, hi: float) -> tuple[int, int]:
    """Range [start, end) of cells whose extent overlaps [lo, hi]."""
    n = len(faces) - 1
    start = 0
    while start < n and faces[start + 1] <= lo:
        start += 1
    end = n
    while end > start and faces[end - 1] >= hi:
        end -= 1
    return start, end


def _samples(faces: np.ndarray, breakpoints: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Gauss points for integrating over consecutive cells, splitting each cell at breakpoints.

    Returns (positions, weights as a fraction of the owning cell, cell index relative to faces[0]).
    """
    lo, hi = faces[0], faces[-1]
    inner = breakpoints[(breakpoints > lo + 1e-9) & (breakpoints < hi - 1e-9)]
    # Breakpoints within round-off of a face do not split a cell.
    if len(inner) > 0:
        nearest = np.abs(inner[:, None] - faces[None, :]).min(axis=1)
        inner = inner[nearest > 1e-9]
    bounds = np.unique(np.concatenate([faces, inner]))
    a = bounds[:-1]
    b = bounds[1:]
    cell = np.clip(np.searchsorted(faces, 0.5 * (a + b), side="right") - 1, 0, len(faces) - 2)
    size = faces[cell + 1] - faces[cell]
    weight = (b - a) / size / 2
    positions = np.concatenate([a + (b - a) * _GAUSS[0], a + (b - a) * _GAUSS[1]])
    return positions, np.concatenate([weight, weight]), np.concatenate([cell, cell])


def _overlap(a: np.ndarray, b: np.ndarray, start: np.ndarray, end: np.ndarray) -> np.ndarray:
    return np.maximum(np.minimum(b, end) - np.maximum(a, start), 0.0)


def _coverage(ya: np.ndarray, yb: np.ndarray, w0: np.ndarray, e0: np.ndarray, e1: np.ndarray) -> np.ndarray:
    """Covered length of y segments [ya, yb] by the |y| intervals [0, w0] and [e0, e1].

    ya, yb have shape (ny,); w0, e0, e1 have shape (samples, 1). Result: (samples, ny).
    """

    def positive(a: np.ndarray, b: np.ndarray) -> np.ndarray:
        return _overlap(a, b, 0.0, w0) + _overlap(a, b, np.maximum(e0, w0), e1)

    return positive(np.maximum(ya, 0.0), np.maximum(yb, 0.0)) + positive(np.maximum(-yb, 0.0), np.maximum(-ya, 0.0))


def compute_apertures(grid: Grid, model: SolidModel) -> Apertures:
    """Open-area fraction of every cell face near the vehicle.

    Coverage is integrated exactly in y and by 2-point Gauss quadrature in x and
    z between the stations where a solid starts or ends, so apertures vary
    smoothly with the geometry parameters.
    """
    nx, ny, nz = grid.nx, grid.ny, grid.nz
    xf, yf, zf = grid.xf, grid.yf, grid.zf
    ap = Apertures(
        bx=np.ones((nz, ny, nx + 1), dtype=np.float32),
        by=np.ones((nz, ny + 1, nx), dtype=np.float32),
        bz=np.ones((nz + 1, ny, nx), dtype=np.float32),
        ux=np.ones((nz, ny, nx + 1), dtype=np.float32),
        uy=np.ones((nz, ny + 1, nx), dtype=np.float32),
        uz=np.ones((nz + 1, ny, nx), dtype=np.float32),
    )

    margin = 1e-6
    i0, i1 = _cell_range(xf, model.x_min - margin, model.x_max + margin)
    j0, j1 = _cell_range(yf, -model.y_max, model.y_max)
    z_top = max(model.z_max, model.wake.z_sep_top, model.wake.spoiler_tip_z) + 0.02
    k0, k1 = _cell_range(zf, 0.0, z_top)

    ya = yf[j0:j1]
    yb = yf[j0 + 1 : j1 + 1]
    dy = yb - ya
    x_points = x_breakpoints(model, True)

    def extents(x, z):
        """(w0 body, w0 union, e0, e1) as column vectors for broadcasting against y."""
        w0, e0, e1 = body_extents(model, x, z)
        wake = wake_half_width(model, x, z)
        return w0[:, None], np.maximum(w0, wake)[:, None], e0[:, None], e1[:, None]

    # ---- X faces (normal to the flow) ----
    z_faces = zf[k0 : k1 + 1]
    for i in range(i0, i1 + 1):
        x = float(xf[i])
        zs, weights, cells = _samples(z_faces, z_breakpoints(model, x, True))
        w_body, w_union, e0, e1 = extents(np.full_like(zs, x), zs)
        cover_b = np.zeros((k1 - k0, j1 - j0))
        cover_u = np.zeros((k1 - k0, j1 - j0))
        np.add.at(cover_b, cells, weights[:, None] * _coverage(ya, yb, w_body, e0, e1) / dy)
        np.add.at(cover_u, cells, weights[:, None] * _coverage(ya, yb, w_union, e0, e1) / dy)
        ap.bx[k0:k1, j0:j1, i] = 1 - cover_b
        ap.ux[k0:k1, j0:j1, i] = 1 - cover_u

    # ---- Z faces (horizontal) ----
    # The ground face (k = 0) is sampled just above the road so that tyre contact patches
    # count as covered; it only matters for the body-surface integration.
    xs, x_weights, x_cells = _samples(xf[i0 : i1 + 1], x_points)
    for k in range(k0, k1 + 1):
        z = _GROUND_SAMPLE_HEIGHT if k == 0 else float(zf[k])
        w_body, w_union, e0, e1 = extents(xs, np.full_like(xs, z))
        cover_b = np.zeros((i1 - i0, j1 - j0))
        cover_u = np.zeros((i1 - i0, j1 - j0))
        np.add.at(cover_b, x_cells, x_weights[:, None] * _coverage(ya, yb, w_body, e0, e1) / dy)
        np.add.at(cover_u, x_cells, x_weights[:, None] * _coverage(ya, yb, w_union, e0, e1) / dy)
        ap.bz[k, j0:j1, i0:i1] = (1 - cover_b).T
        ap.uz[k, j0:j1, i0:i1] = (1 - cover_u).T

    # ---- Y faces (vertical, parallel to the flow) ----
    j_face_start = max(j0, 1) if grid.symmetric else j0
    j_face_end = min(j1, ny)
    face_y = np.abs(yf[j_face_start : j_face_end + 1])[None, :]
    for i in range(i0, i1):
        cover_b = np.zeros((k1 - k0, j_face_end + 1 - j_face_start))
        cover_u = np.zeros_like(cover_b)
        mask = x_cells == (i - i0)
        for x, x_weight in zip(xs[mask], x_weights[mask]):
            zs, z_weights, cells = _samples(z_faces, z_breakpoints(model, float(x), True))
            w0, e0, e1 = body_extents(model, np.full_like(zs, x), zs)
            wake = wake_half_width(model, np.full_like(zs, x), zs)
            in_body = ((w0 > 0)[:, None] & (face_y <= w0[:, None])) | (
                (e1 > e0)[:, None] & (face_y >= e0[:, None]) & (face_y <= e1[:, None])
            )
            in_union = in_body | ((wake > 0)[:, None] & (face_y <= wake[:, None]))
            weight = (x_weight * z_weights)[:, None]
            np.add.at(cover_b, cells, weight * in_body)
            np.add.at(cover_u, cells, weight * in_union)
        ap.by[k0:k1, j_face_start : j_face_end + 1, i] = 1 - cover_b
        ap.uy[k0:k1, j_face_start : j_face_end + 1, i] = 1 - cover_u

    # Remove vanishing openings, which would only harm the conditioning.
    for array in (ap.bx, ap.by, ap.bz, ap.ux, ap.uy, ap.uz):
        array[array < RO["minAperture"]] = 0
        array[array > 1] = 1
    return ap


# ---------------------------------------------------------------------------
# Fluid cells
# ---------------------------------------------------------------------------


def mark_active_cells(grid: Grid, ap: Apertures) -> np.ndarray:
    """Cells that take part in the solve: connected to the far field through open faces.

    Openings into unreachable pockets are closed. Returns a boolean array (nz, ny, nx).
    """
    nx, ny, nz = grid.nx, grid.ny, grid.nz
    total = nx * ny * nz
    index = np.arange(total).reshape(nz, ny, nx)
    rows: list[np.ndarray] = []
    cols: list[np.ndarray] = []
    for open_faces, a, b in (
        (ap.ux[:, :, 1:nx] > 0, index[:, :, :-1], index[:, :, 1:]),
        (ap.uy[:, 1:ny, :] > 0, index[:, :-1, :], index[:, 1:, :]),
        (ap.uz[1:nz, :, :] > 0, index[:-1, :, :], index[1:, :, :]),
    ):
        rows.append(a[open_faces])
        cols.append(b[open_faces])
    row = np.concatenate(rows)
    col = np.concatenate(cols)
    graph = csr_matrix((np.ones(len(row), dtype=np.int8), (row, col)), shape=(total, total))
    _, labels = connected_components(graph, directed=False)
    seed = index[nz - 1, ny - 1, 0]
    reached = (labels == labels[seed]).reshape(nz, ny, nx)

    blocked = ~reached
    ap.ux[:, :, :-1][blocked] = 0
    ap.ux[:, :, 1:][blocked] = 0
    ap.uy[:, :-1, :][blocked] = 0
    ap.uy[:, 1:, :][blocked] = 0
    ap.uz[:-1, :, :][blocked] = 0
    ap.uz[1:, :, :][blocked] = 0
    return reached


# ---------------------------------------------------------------------------
# Linear solve
# ---------------------------------------------------------------------------


@dataclass
class PotentialSolution:
    phi: np.ndarray  # (nz, ny, nx), perturbation potential for unit freestream speed
    iterations: int
    residual: float
    converged: bool


def solve_potential(
    grid: Grid,
    ap: Apertures,
    active: np.ndarray,
    yaw_deg: float,
    tolerance: float,
    on_progress: Callable[[float, int, float], None] | None = None,
    max_iterations: int | None = None,
) -> PotentialSolution:
    """Jacobi-preconditioned conjugate gradients on the symmetric positive-definite flux system."""
    nx, ny, nz = grid.nx, grid.ny, grid.nz
    total = nx * ny * nz
    ux = math.cos(yaw_deg * DEG_TO_RAD)
    uy = math.sin(yaw_deg * DEG_TO_RAD)

    dx = np.diff(grid.xf)[None, None, :]
    dy = np.diff(grid.yf)[None, :, None]
    dz = np.diff(grid.zf)[:, None, None]
    area_x = dy * dz * np.ones((1, 1, nx))
    area_y = dx * dz * np.ones((1, ny, 1))
    area_z = dx * dy * np.ones((nz, 1, 1))
    dxc = np.diff(grid.xc)[None, None, :]
    dyc = np.diff(grid.yc)[None, :, None]
    dzc = np.diff(grid.zc)[:, None, None]

    ax = ap.ux.astype(float)
    ay = ap.uy.astype(float)
    az = ap.uz.astype(float)

    # Conductance g = a A / d of the face on the minus / plus side of each cell (0 on boundaries).
    gxm = np.zeros((nz, ny, nx))
    gxp = np.zeros((nz, ny, nx))
    gym = np.zeros((nz, ny, nx))
    gyp = np.zeros((nz, ny, nx))
    gzm = np.zeros((nz, ny, nx))
    gzp = np.zeros((nz, ny, nx))
    gxm[:, :, 1:] = ax[:, :, 1:nx] * area_x[:, :, 1:] / dxc
    gxp[:, :, :-1] = ax[:, :, 1:nx] * area_x[:, :, :-1] / dxc
    gym[:, 1:, :] = ay[:, 1:ny, :] * area_y[:, 1:, :] / dyc
    gyp[:, :-1, :] = ay[:, 1:ny, :] * area_y[:, :-1, :] / dyc
    gzm[1:, :, :] = az[1:nz, :, :] * area_z[1:, :, :] / dzc
    gzp[:-1, :, :] = az[1:nz, :, :] * area_z[:-1, :, :] / dzc

    diag = gxm + gxp + gym + gyp + gzm + gzp
    # Freestream flux through the open part of the faces: sum_f a_f A_f (U . n_f).
    # Boundary faces are fully open; the inlet carries the uniform inflow.
    axm = ax[:, :, :-1].copy()
    axp = ax[:, :, 1:].copy()
    axm[:, :, 0] = 1
    axp[:, :, -1] = 1
    flux = (axp - axm) * area_x * ux
    aym = ay[:, :-1, :].copy()
    ayp = ay[:, 1:, :].copy()
    ayp[:, -1, :] = 1
    if grid.symmetric:
        # Symmetry wall at y = 0: no flux through it.
        aym[:, 0, :] = 0
    else:
        aym[:, 0, :] = 1
    flux = flux + (ayp - aym) * area_y * uy

    # Constant-pressure (phi' = 0) boundaries: outlet, top, y+ side, and y- side when not symmetric.
    diag[:, :, -1] += (area_x / (0.5 * dx))[:, :, -1]
    diag[:, -1, :] += (area_y / (0.5 * dy))[:, -1, :]
    diag[-1, :, :] += (area_z / (0.5 * dz))[-1, :, :]
    if not grid.symmetric:
        diag[:, 0, :] += (area_y / (0.5 * dy))[:, 0, :]

    inactive = ~active
    diag[inactive] = 1.0
    flux[inactive] = 0.0

    d = diag.ravel()
    rhs = flux.ravel()
    nxy = nx * ny
    matrix = diags(
        [
            d,
            -gxm.ravel()[1:],
            -gxp.ravel()[:-1],
            -gym.ravel()[nx:],
            -gyp.ravel()[:-nx],
            -gzm.ravel()[nxy:],
            -gzp.ravel()[:-nxy],
        ],
        [0, -1, 1, -nx, nx, -nxy, nxy],
        format="csr",
    )

    rhs_norm = float(np.linalg.norm(rhs))
    if rhs_norm == 0.0:
        return PotentialSolution(np.zeros((nz, ny, nx)), 0, 0.0, True)

    iterations = 0
    log_target = math.log(1 / tolerance)

    def callback(xk: np.ndarray) -> None:
        nonlocal iterations
        iterations += 1
        if on_progress is not None and iterations % 20 == 0:
            residual = float(np.linalg.norm(rhs - matrix @ xk)) / rhs_norm
            on_progress(min(math.log(1 / max(residual, 1e-300)) / log_target, 0.99), iterations, residual)

    inverse_diag = 1.0 / d
    preconditioner = LinearOperator((total, total), matvec=lambda v: inverse_diag * v)
    phi, info = cg(
        matrix,
        rhs,
        rtol=tolerance,
        atol=0.0,
        maxiter=max_iterations or RO["maxIterations"],
        M=preconditioner,
        callback=callback,
    )
    residual = float(np.linalg.norm(rhs - matrix @ phi)) / rhs_norm
    return PotentialSolution(phi.reshape(nz, ny, nx), iterations, residual, info == 0)


# ---------------------------------------------------------------------------
# Velocities
# ---------------------------------------------------------------------------


@dataclass
class CellVelocities:
    u: np.ndarray
    v: np.ndarray
    w: np.ndarray
    #: Mean of the six union apertures: a cheap proxy for the cell's fluid volume fraction.
    fluid_fraction: np.ndarray


def cell_velocities(grid: Grid, ap: Apertures, active: np.ndarray, phi: np.ndarray, yaw_deg: float) -> CellVelocities:
    """Cell-centre velocities (ratio to freestream speed) reconstructed from the face fluxes."""
    nx, ny, nz = grid.nx, grid.ny, grid.nz
    ux = math.cos(yaw_deg * DEG_TO_RAD)
    uy = math.sin(yaw_deg * DEG_TO_RAD)
    dx = np.diff(grid.xf)
    dy = np.diff(grid.yf)
    dz = np.diff(grid.zf)
    dxc = np.diff(grid.xc)[None, None, :]
    dyc = np.diff(grid.yc)[None, :, None]
    dzc = np.diff(grid.zc)[:, None, None]

    def sides(aperture: np.ndarray, axis: int) -> tuple[np.ndarray, np.ndarray]:
        """Apertures on the minus / plus side of each cell; boundary faces count as open."""
        minus = np.take(aperture, range(aperture.shape[axis] - 1), axis=axis).astype(float)
        plus = np.take(aperture, range(1, aperture.shape[axis]), axis=axis).astype(float)
        first = [slice(None)] * 3
        last = [slice(None)] * 3
        first[axis] = 0
        last[axis] = -1
        minus[tuple(first)] = 1
        plus[tuple(last)] = 1
        return minus, plus

    axm, axp = sides(ap.ux, 2)
    aym, ayp = sides(ap.uy, 1)
    azm, azp = sides(ap.uz, 0)

    # Normal velocity through the open part of each face.
    fxm = np.full((nz, ny, nx), ux)
    fxp = np.empty((nz, ny, nx))
    gradient_x = (phi[:, :, 1:] - phi[:, :, :-1]) / dxc
    fxm[:, :, 1:] = ux + gradient_x
    fxp[:, :, :-1] = ux + gradient_x
    fxp[:, :, -1] = ux - phi[:, :, -1] / (0.5 * dx[-1])

    fym = np.empty((nz, ny, nx))
    fyp = np.empty((nz, ny, nx))
    gradient_y = (phi[:, 1:, :] - phi[:, :-1, :]) / dyc
    fym[:, 1:, :] = uy + gradient_y
    fyp[:, :-1, :] = uy + gradient_y
    fym[:, 0, :] = 0.0 if grid.symmetric else uy + phi[:, 0, :] / (0.5 * dy[0])
    fyp[:, -1, :] = uy - phi[:, -1, :] / (0.5 * dy[-1])

    fzm = np.zeros((nz, ny, nx))
    fzp = np.empty((nz, ny, nx))
    gradient_z = (phi[1:, :, :] - phi[:-1, :, :]) / dzc
    fzm[1:, :, :] = gradient_z
    fzp[:-1, :, :] = gradient_z
    fzp[-1, :, :] = -phi[-1, :, :] / (0.5 * dz[-1])

    def component(am: np.ndarray, ap_: np.ndarray, fm: np.ndarray, fp: np.ndarray) -> np.ndarray:
        # Flux through the pair of faces divided by twice the larger opening: equals the face
        # velocity when both are equally open, and half of it next to a wall.
        opening = np.maximum(am, ap_)
        safe = np.where(opening > 0, opening, 1.0)
        return np.where(opening > 0, (am * fm + ap_ * fp) / (2 * safe), 0.0)

    u = np.where(active, component(axm, axp, fxm, fxp), 0.0)
    v = np.where(active, component(aym, ayp, fym, fyp), 0.0)
    w = np.where(active, component(azm, azp, fzm, fzp), 0.0)
    fluid_fraction = np.where(active, (axm + axp + aym + ayp + azm + azp) / 6, 0.0)

    # The flux-based estimate is poor in cells cut by an inclined surface. Replace it there
    # by an inverse-distance-weighted extrapolation from the neighbouring uncut cells; a
    # second pass reaches cells that only touch cells filled in the first pass.
    minimum = np.minimum.reduce([axm, axp, aym, ayp, azm, azp])
    is_open = active & (minimum >= 0.999)
    pending = active & ~is_open
    source = is_open
    for _ in range(2):
        weight_sum = np.zeros((nz, ny, nx))
        su = np.zeros((nz, ny, nx))
        sv = np.zeros((nz, ny, nx))
        sw = np.zeros((nz, ny, nx))
        for dk in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    if di == 0 and dj == 0 and dk == 0:
                        continue
                    dest = (_shift_slice(nz, dk, False), _shift_slice(ny, dj, False), _shift_slice(nx, di, False))
                    src = (_shift_slice(nz, dk, True), _shift_slice(ny, dj, True), _shift_slice(nx, di, True))
                    ex = (grid.xc[src[2]] - grid.xc[dest[2]])[None, None, :]
                    ey = (grid.yc[src[1]] - grid.yc[dest[1]])[None, :, None]
                    ez = (grid.zc[src[0]] - grid.zc[dest[0]])[:, None, None]
                    weight = np.where(source[src], 1.0 / (ex * ex + ey * ey + ez * ez), 0.0)
                    weight_sum[dest] += weight
                    su[dest] += weight * u[src]
                    sv[dest] += weight * v[src]
                    sw[dest] += weight * w[src]
        fill = pending & (weight_sum > 0)
        safe = np.where(weight_sum > 0, weight_sum, 1.0)
        u = np.where(fill, su / safe, u)
        v = np.where(fill, sv / safe, v)
        w = np.where(fill, sw / safe, w)
        pending = pending & ~fill
        source = is_open | fill
    return CellVelocities(u=u, v=v, w=w, fluid_fraction=fluid_fraction)


def _shift_slice(n: int, shift: int, source: bool) -> slice:
    """Index range of the cells that have a neighbour at +shift (dest), or of those neighbours (source)."""
    if shift == 0:
        return slice(0, n)
    if shift > 0:
        return slice(shift, n) if source else slice(0, n - shift)
    return slice(0, n + shift) if source else slice(-shift, n)
