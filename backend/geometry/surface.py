"""Closed surfaces supplied for CFD: the shrink-wrapped form of an imported 3D model.

The browser wraps the model (lib/geometry/wrap.ts) and uploads the result as raw
triangles in tunnel coordinates (x downstream with the nose at 0, z up, ground
at z = 0). The surface is checked, described and stored here, and Mode C meshes
it in place of the parametric body. Nothing is taken on trust from the client:
the reference area and the extents are measured from the triangles.
"""

from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from simulation.assemble import SimulationError

SURFACE_DIR = Path(__file__).resolve().parents[1] / "data" / "surfaces"
MAX_TRIANGLES = 3_000_000
# Tyres of a model touch the ground along a line. For meshing the surface is lowered by this much, so that
# each tyre meets the ground in a patch, as a loaded tyre does (m).
SURFACE_SINK = 0.01
# Pixel of the silhouette raster from which the frontal area is measured (m).
_PIXEL = 0.005
_WELD = 1e-5


@dataclass(frozen=True)
class SurfaceInfo:
    id: str
    triangles: int
    # Extents as uploaded (before the tyres are sunk), m.
    min: tuple[float, float, float]
    max: tuple[float, float, float]
    # Silhouette from the front of the part above the ground once the tyres are sunk, m^2.
    frontal_area: float
    area: float

    @property
    def length(self) -> float:
        return self.max[0]

    @property
    def half_width(self) -> float:
        return max(abs(self.min[1]), abs(self.max[1]))

    @property
    def height(self) -> float:
        return self.max[2] - SURFACE_SINK

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "triangles": self.triangles,
            "min": list(self.min),
            "max": list(self.max),
            "frontalArea": self.frontal_area,
            "area": self.area,
            "sink": SURFACE_SINK,
        }


def _triangles(raw: bytes) -> np.ndarray:
    if len(raw) == 0 or len(raw) % 36 != 0:
        raise SimulationError("CFD_SURFACE_INVALID", "A surface is sent as 9 little-endian float32 values per triangle.")
    tri = np.frombuffer(raw, dtype="<f4").astype(np.float64).reshape(-1, 3, 3)
    if len(tri) < 4:
        raise SimulationError("CFD_SURFACE_INVALID", "A closed surface has at least four triangles.")
    if len(tri) > MAX_TRIANGLES:
        raise SimulationError("CFD_SURFACE_INVALID", f"The surface has {len(tri):,} triangles; the limit is {MAX_TRIANGLES:,}.")
    if not np.isfinite(tri).all():
        raise SimulationError("CFD_SURFACE_INVALID", "The surface contains coordinates that are not numbers.")
    return tri


def open_edge_count(tri: np.ndarray) -> int:
    """Edges that are not shared by an even number of triangles; 0 for a closed surface."""
    keys = np.round(tri.reshape(-1, 3) / _WELD).astype(np.int64)
    _, index = np.unique(keys, axis=0, return_inverse=True)
    faces = index.reshape(-1, 3)
    edges = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    edges = edges[edges[:, 0] != edges[:, 1]]
    _, counts = np.unique(edges, axis=0, return_counts=True)
    return int(np.count_nonzero(counts % 2))


def frontal_area(tri: np.ndarray, floor: float = 0.0) -> float:
    """Area of the silhouette on the Y-Z plane of everything above z = floor."""
    y_min = float(tri[:, :, 1].min())
    z_max = float(tri[:, :, 2].max())
    y_max = float(tri[:, :, 1].max())
    width = int(np.ceil((y_max - y_min) / _PIXEL)) + 2
    height = int(np.ceil(max(z_max - floor, _PIXEL) / _PIXEL)) + 2
    lit = np.zeros((height, width), dtype=bool)
    yz = tri[:, :, 1:]
    edge = np.max(np.linalg.norm(yz - np.roll(yz, 1, axis=1), axis=2), axis=1)
    order = np.argsort(edge)
    # Triangles are sampled on a lattice finer than half a pixel; small triangles in large batches.
    start = 0
    while start < len(order):
        stop = min(start + 40_000, len(order))
        n = int(min(max(np.ceil(edge[order[stop - 1]] / (0.5 * _PIXEL)), 1), 400))
        while stop - start > 1 and (n + 1) * (n + 2) // 2 * (stop - start) > 6_000_000:
            stop = start + max((stop - start) // 2, 1)
            n = int(min(max(np.ceil(edge[order[stop - 1]] / (0.5 * _PIXEL)), 1), 400))
        batch = yz[order[start:stop]]
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
        keep = i + j <= n
        a = (i[keep] / n)[None, :, None]
        b = (j[keep] / n)[None, :, None]
        points = batch[:, 0:1, :] + (batch[:, 1:2, :] - batch[:, 0:1, :]) * a + (batch[:, 2:3, :] - batch[:, 0:1, :]) * b
        y = points[..., 0].ravel()
        z = points[..., 1].ravel()
        above = z >= floor
        lit[np.floor((z[above] - floor) / _PIXEL).astype(int), np.floor((y[above] - y_min) / _PIXEL).astype(int)] = True
        start = stop
    return float(lit.sum()) * _PIXEL * _PIXEL


def binary_stl(tri: np.ndarray, name: str = "body") -> bytes:
    """Binary STL of triangles (n, 3, 3), with facet normals."""
    normals = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 0)
    record = np.zeros(len(tri), dtype=[("normal", "<f4", 3), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
    record["normal"] = normals
    record["vertices"] = tri
    return name.encode("ascii", "replace")[:80].ljust(80, b" ") + struct.pack("<I", len(tri)) + record.tobytes()


def store_surface(raw: bytes) -> SurfaceInfo:
    """Checks an uploaded surface, measures it and keeps it. Raises SimulationError when it cannot be used."""
    tri = _triangles(raw)
    low = tri.reshape(-1, 3).min(axis=0)
    high = tri.reshape(-1, 3).max(axis=0)
    extent = high - low
    if not (1.0 <= extent[0] <= 12.0 and 0.3 <= extent[1] <= 4.0 and 0.3 <= extent[2] <= 5.0):
        raise SimulationError(
            "CFD_SURFACE_INVALID",
            f"The surface measures {extent[0]:.2f} x {extent[1]:.2f} x {extent[2]:.2f} m, which is not a road vehicle in metres.",
        )
    if low[2] < -0.2 or low[2] > 0.3:
        raise SimulationError("CFD_SURFACE_INVALID", f"The lowest point of the surface is at z = {low[2]:.3f} m; it has to stand on the ground at z = 0.")
    open_edges = open_edge_count(tri)
    if open_edges:
        raise SimulationError("CFD_SURFACE_NOT_CLOSED", f"The surface is not closed: {open_edges:,} of its edges border a hole. Only a closed surface can be meshed.")
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    info = SurfaceInfo(
        id=hashlib.sha256(raw).hexdigest()[:16],
        triangles=len(tri),
        min=tuple(float(v) for v in low),
        max=tuple(float(v) for v in high),
        frontal_area=frontal_area(tri, floor=SURFACE_SINK),
        area=float(0.5 * np.linalg.norm(cross, axis=1).sum()),
    )
    SURFACE_DIR.mkdir(parents=True, exist_ok=True)
    (SURFACE_DIR / f"{info.id}.f32").write_bytes(raw)
    (SURFACE_DIR / f"{info.id}.json").write_text(json.dumps(asdict(info)), encoding="utf-8")
    return info


def load_surface(surface_id: str) -> tuple[SurfaceInfo, np.ndarray]:
    """The description and the triangles of a stored surface."""
    meta = SURFACE_DIR / f"{surface_id}.json"
    data = SURFACE_DIR / f"{surface_id}.f32"
    if not surface_id.isalnum() or not meta.is_file() or not data.is_file():
        raise SimulationError(
            "CFD_SURFACE_MISSING",
            "The wrapped surface of this model is not on the backend (it may have been restarted or cleaned). Build the CFD surface again.",
        )
    stored = json.loads(meta.read_text(encoding="utf-8"))
    info = SurfaceInfo(**{**stored, "min": tuple(stored["min"]), "max": tuple(stored["max"])})
    return info, _triangles(data.read_bytes())


def sunk_stl(tri: np.ndarray) -> bytes:
    """The surface as it is meshed: lowered so that the tyres stand in the ground by SURFACE_SINK."""
    lowered = tri.copy()
    lowered[:, :, 2] -= SURFACE_SINK
    return binary_stl(lowered)
