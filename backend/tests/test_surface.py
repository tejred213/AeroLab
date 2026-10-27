"""Closed surfaces supplied for Mode C (the wrapped form of an imported 3D model)."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

import geometry.surface as surface_module
from engines.openfoam import OpenFOAMEngine, generate_case, plan_case, prepare_cfd_case
from geometry.surface import SURFACE_SINK, binary_stl, frontal_area, load_surface, open_edge_count, store_surface
from main import app
from simulation.assemble import SimulationError, prepare_case
from tests.helpers import sign_in
from vehicle.library import get_built_in_vehicle, make_config

# A car-sized box standing on the ground: 4.6 m long, 1.8 m wide, 1.5 m high.
BOX = (0.0, 4.6, -0.9, 0.9, 0.0, 1.5)


def box_triangles(x0: float, x1: float, y0: float, y1: float, z0: float, z1: float, skip: tuple[int, ...] = ()) -> np.ndarray:
    corners = np.array(
        [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], dtype=np.float32
    )
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return np.array([corners[list(face)] for index, face in enumerate(faces) if index // 2 not in skip], dtype=np.float32)


@pytest.fixture(autouse=True)
def surface_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(surface_module, "SURFACE_DIR", tmp_path / "surfaces")
    return tmp_path / "surfaces"


def test_a_closed_surface_is_measured_and_stored() -> None:
    raw = box_triangles(*BOX).tobytes()
    info = store_surface(raw)
    assert info.triangles == 12 and len(info.id) == 16
    assert info.length == pytest.approx(4.6) and info.half_width == pytest.approx(0.9)
    # The tyres are sunk into the ground for meshing, so that much of the height is below it.
    assert info.height == pytest.approx(1.5 - SURFACE_SINK)
    assert info.frontal_area == pytest.approx(1.8 * (1.5 - SURFACE_SINK), rel=0.02)
    assert info.area == pytest.approx(2 * (4.6 * 1.8 + 4.6 * 1.5 + 1.8 * 1.5), rel=1e-6)
    # The same bytes give the same surface, and it reads back as stored.
    assert store_surface(raw).id == info.id
    loaded, triangles = load_surface(info.id)
    assert loaded == info and triangles.shape == (12, 3, 3)
    stl = binary_stl(triangles)
    assert len(stl) == 84 + 50 * 12


def test_a_surface_with_a_hole_or_bad_data_is_refused() -> None:
    with pytest.raises(SimulationError) as not_closed:
        store_surface(box_triangles(*BOX, skip=(1,)).tobytes())
    assert not_closed.value.code == "CFD_SURFACE_NOT_CLOSED"
    assert open_edge_count(box_triangles(*BOX, skip=(1,)).astype(float)) == 4
    for raw, code in [
        (b"\x00" * 35, "CFD_SURFACE_INVALID"),
        (box_triangles(0, 0.2, -0.05, 0.05, 0, 0.1).tobytes(), "CFD_SURFACE_INVALID"),
        (box_triangles(0, 4.6, -0.9, 0.9, 1.0, 2.5).tobytes(), "CFD_SURFACE_INVALID"),
        (np.full((12, 3, 3), np.nan, dtype=np.float32).tobytes(), "CFD_SURFACE_INVALID"),
    ]:
        with pytest.raises(SimulationError) as refused:
            store_surface(raw)
        assert refused.value.code == code
    with pytest.raises(SimulationError) as missing:
        load_surface("0123456789abcdef")
    assert missing.value.code == "CFD_SURFACE_MISSING"


def test_the_silhouette_ignores_what_is_below_the_floor() -> None:
    triangles = box_triangles(*BOX).astype(float)
    assert frontal_area(triangles) == pytest.approx(1.8 * 1.5, rel=0.02)
    assert frontal_area(triangles, floor=0.5) == pytest.approx(1.8 * 1.0, rel=0.02)


def _surface_config(fidelity: str = "coarse") -> tuple[dict, object]:
    info = store_surface(box_triangles(*BOX).tobytes())
    config = make_config(get_built_in_vehicle("suv"), mode="cfd", fidelity=fidelity)
    config["cfdSurface"] = {"id": info.id, "voxel": 0.015, "seal": 0.03}
    return config, info


def test_the_case_is_built_from_the_surface(tmp_path) -> None:
    config, info = _surface_config()
    plain = prepare_case(config)
    prepared = prepare_cfd_case(config)
    # The solved shape supplies the reference area and the extents; the parametric body does not.
    assert prepared.surface == info
    assert prepared.metrics.frontal_area == pytest.approx(info.frontal_area)
    assert prepared.metrics.frontal_area != pytest.approx(plain.metrics.frontal_area, rel=0.01)
    assert prepared.metrics.length == pytest.approx(4.6)
    assert prepare_cfd_case({**config, "cfdSurface": None}).surface is None

    files = generate_case(config, plain, tmp_path / "case")
    assert "constant/triSurface/body.stl" in files and "constant/triSurface/wheels.stl" not in files
    stl = (tmp_path / "case/constant/triSurface/body.stl").read_bytes()
    assert len(stl) == 84 + 50 * 12
    lowest = np.frombuffer(stl[84:], dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])["v"][:, :, 2].min()
    assert lowest == pytest.approx(-SURFACE_SINK)

    snappy = (tmp_path / "case/system/snappyHexMeshDict").read_text()
    assert "body.stl" in snappy and "wheels" not in snappy and "devices" not in snappy
    assert "features ( );" in snappy and "implicitFeatureSnap true" in snappy
    control = (tmp_path / "case/system/controlDict").read_text()
    assert "patches         (body);" in control
    assert f"Aref            {info.frontal_area:.6f};" in control
    for name in ("U", "p", "k", "omega", "nut"):
        assert "wheels" not in (tmp_path / "case/0" / name).read_text().replace("wheels are part", "")
    assert plan_case(config, prepared).cell_estimate > 0


def test_a_missing_surface_fails_before_any_file_is_written(tmp_path) -> None:
    config = make_config(get_built_in_vehicle("suv"), mode="cfd")
    config["cfdSurface"] = {"id": "0123456789abcdef"}
    with pytest.raises(SimulationError) as missing:
        OpenFOAMEngine().prepare_case_files(config)
    assert missing.value.code == "CFD_SURFACE_MISSING"


def test_the_api_stores_a_surface_and_builds_its_case(monkeypatch, tmp_path) -> None:
    import engines.openfoam as openfoam

    monkeypatch.setattr(openfoam, "CASES_DIR", tmp_path / "cfd")
    client = TestClient(app)
    sign_in(client)
    stored = client.post("/api/cfd/surfaces", content=box_triangles(*BOX).tobytes(), headers={"Content-Type": "application/octet-stream"})
    assert stored.status_code == 201
    body = stored.json()
    assert body["triangles"] == 12 and body["sink"] == SURFACE_SINK

    refused = client.post("/api/cfd/surfaces", content=box_triangles(*BOX, skip=(0,)).tobytes())
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "CFD_SURFACE_NOT_CLOSED"

    config = make_config(get_built_in_vehicle("suv"), mode="cfd")
    case = client.post("/api/cfd/case", json={"config": {**config, "cfdSurface": {"id": body["id"], "voxel": 0.015, "seal": 0.03}}})
    assert case.status_code == 200, case.text
    assert "constant/triSurface/body.stl" in case.json()["files"] and "constant/triSurface/wheels.stl" not in case.json()["files"]

    unknown = client.post("/api/cfd/case", json={"config": {**config, "cfdSurface": {"id": "f" * 16}}})
    assert unknown.status_code == 422 and unknown.json()["detail"]["code"] == "CFD_SURFACE_MISSING"
    # A configuration without a surface is unchanged by the new field.
    ordinary = client.post("/api/cfd/case", json={"config": config})
    assert ordinary.status_code == 200 and "constant/triSurface/wheels.stl" in ordinary.json()["files"]
