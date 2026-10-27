"""OpenFOAM adapter: case generation, result parsing, and honest failure without a solver."""

from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

import numpy as np
import pytest

import engines.openfoam as openfoam
from engines.base import CFDBackend, SimulationEngine
from engines.openfoam import (
    IMPORT_PROVENANCE,
    OpenFOAMEngine,
    generate_case,
    parse_force_coeffs,
    result_from_coefficients,
    summarize_force_coeffs,
    zip_case,
)
from geometry.profile import build_body_shape
from geometry.stl import body_surface, device_surfaces, wheel_surfaces
from simulation.assemble import SimulationError, prepare_case
from tests.helpers import config_for


def coefficient_file(rows: int = 400, cd: float = 0.3012, cl: float = 0.0421, area: float | None = None, speed: float = 41.666667) -> str:
    """Text in the layout written by OpenFOAM's forceCoeffs function object (parser fixture, not a CFD result)."""
    header = [
        "# Force coefficients",
        "# dragDir             : (1 0 0)",
        "# liftDir             : (0 0 1)",
        f"# magUInf             : {speed:.6e}",
        "# lRef                : 2.9",
    ]
    if area is not None:
        header.append(f"# Aref                : {area:.6f}")
    header.append("# Time\tCd\tCd(f)\tCd(r)\tCl\tCl(f)\tCl(r)\tCmPitch\tCmRoll\tCmYaw\tCs\tCs(f)\tCs(r)")
    lines = list(header)
    for step in range(1, rows + 1):
        # Decaying start-up transient toward the converged values.
        transient = 0.4 * np.exp(-step / 40)
        ripple = 2e-4 * np.sin(step / 7)
        row = [step, cd + transient + ripple, 0.5 * cd, 0.5 * cd, cl - transient + ripple, 0.3 * cl, 0.7 * cl, 0.01, 0.0, 0.002, 0.0, 0.0, 0.0]
        lines.append("\t".join(f"{value:.8e}" if i else str(value) for i, value in enumerate(row)))
    return "\n".join(lines) + "\n"


def test_engine_implements_both_interfaces() -> None:
    engine = OpenFOAMEngine()
    assert isinstance(engine, SimulationEngine) and isinstance(engine, CFDBackend)
    assert engine.mode == "cfd"


def test_surfaces_are_closed_and_follow_the_geometry() -> None:
    shape = build_body_shape(config_for("fastback")["geometry"])
    body = body_surface(shape)
    assert body.shape[1:] == (3, 3) and len(body) > 2000
    assert body[:, :, 0].min() == pytest.approx(0, abs=1e-9)
    assert body[:, :, 0].max() == pytest.approx(shape.length)
    assert body[:, :, 2].max() == pytest.approx(shape.params["rideHeight"] + shape.params["roofHeight"], abs=2e-3)
    # A closed surface has zero net area vector.
    area_vector = 0.5 * np.cross(body[:, 1] - body[:, 0], body[:, 2] - body[:, 0]).sum(axis=0)
    assert np.allclose(area_vector, 0, atol=1e-6)
    wheels = wheel_surfaces(shape)
    assert np.allclose(0.5 * np.cross(wheels[:, 1] - wheels[:, 0], wheels[:, 2] - wheels[:, 0]).sum(axis=0), 0, atol=1e-9)
    assert wheels[:, :, 2].min() == pytest.approx(0, abs=1e-9)  # tyres touch the ground
    assert device_surfaces(shape) is not None  # the fastback has a lip spoiler
    assert device_surfaces(build_body_shape(config_for("suv")["geometry"])) is None


def test_generated_case_is_complete(tmp_path: Path) -> None:
    config = config_for("sports-coupe", mode="cfd", environment={"windSpeed": 8, "windAngle": 60})
    prepared = prepare_case(config)
    files = generate_case(config, prepared, tmp_path / "case")
    expected = {
        "0/U", "0/p", "0/k", "0/omega", "0/nut",
        "constant/transportProperties", "constant/turbulenceProperties",
        "constant/triSurface/body.stl", "constant/triSurface/wheels.stl", "constant/triSurface/devices.stl",
        "system/blockMeshDict", "system/snappyHexMeshDict", "system/controlDict",
        "system/fvSchemes", "system/fvSolution", "Allrun", "README-AEROLAB.txt",
    }
    assert expected <= set(files)
    for name in files:
        assert (tmp_path / "case" / name).stat().st_size > 0

    control = (tmp_path / "case/system/controlDict").read_text()
    assert "forceCoeffs" in control and "simpleFoam" in control
    assert f"Aref            {prepared.metrics.frontal_area:.6f}" in control
    assert f"magUInf         {prepared.flow.speed:.6f}" in control
    velocity = (tmp_path / "case/0/U").read_text()
    # The onset flow is yawed: both velocity components appear in the inlet condition.
    assert prepared.flow.yaw_deg > 5
    assert "fixedValue" in velocity and " 0)" in velocity
    assert (tmp_path / "case/constant/triSurface/body.stl").read_text().startswith("solid body")
    assert "simpleFoam" in (tmp_path / "case/Allrun").read_text()

    archive = zip_case(tmp_path / "case")
    with zipfile.ZipFile(archive) as bundle:
        assert "case/system/controlDict" in bundle.namelist()


def test_parser_reads_the_force_coefficient_layout() -> None:
    parsed = parse_force_coeffs(coefficient_file(area=2.34))
    assert parsed["columns"][:5] == ["Time", "Cd", "Cd(f)", "Cd(r)", "Cl"]
    assert parsed["data"].shape == (400, 13)
    assert parsed["metadata"]["Aref"] == pytest.approx(2.34)
    summary = summarize_force_coeffs(parsed)
    assert summary["iterations"] == 400 and summary["window"] == 80
    # Averaging the tail removes the start-up transient.
    assert summary["cd"] == pytest.approx(0.3012, abs=2e-3)
    assert summary["cl"] == pytest.approx(0.0421, abs=2e-3)
    assert summary["clFront"] == pytest.approx(0.3 * 0.0421, abs=1e-6)
    assert summary["cdStd"] < 1e-2


def test_parser_accepts_the_older_column_layout() -> None:
    text = "# Time Cm Cd Cl Cl(f) Cl(r)\n" + "\n".join(f"{i} 0.01 0.33 0.05 0.02 0.03" for i in range(1, 60))
    summary = summarize_force_coeffs(parse_force_coeffs(text))
    assert summary["cd"] == pytest.approx(0.33) and summary["cl"] == pytest.approx(0.05)
    assert summary["cs"] is None and summary["cmYaw"] is None


@pytest.mark.parametrize(
    "text",
    [
        "",
        "1 0.3 0.1\n2 0.3 0.1\n",
        "# Time Cd Cl\n",
        "# Time Cd Cl\n1 0.3 abc\n",
        "# Time Cd Cl\n1 0.3\n",
        "# Time Cm Cl\n1 0.01 0.05\n",
        "# Time Cd Cl\n1 nan 0.05\n",
    ],
    ids=["empty", "no-header", "no-rows", "non-numeric", "ragged", "no-cd", "nan"],
)
def test_parser_rejects_malformed_files(text: str) -> None:
    with pytest.raises(SimulationError) as caught:
        parse_force_coeffs(text)
    assert caught.value.code == "CFD_PARSE_ERROR"


def test_imported_coefficients_become_a_labelled_cfd_result() -> None:
    config = config_for("fastback", mode="cfd")
    prepared = prepare_case(config)
    summary = summarize_force_coeffs(parse_force_coeffs(coefficient_file(area=prepared.metrics.frontal_area)))
    result = result_from_coefficients(config, prepared, summary, IMPORT_PROVENANCE)
    assert result["mode"] == "cfd"
    assert "did not run" in result["provenance"]
    # CFD numbers are reported as read: no calibration offset.
    assert result["coefficients"]["cd"] == pytest.approx(summary["cd"])
    assert result["calibration"]["cdOffset"] == 0 and result["calibration"]["clOffset"] == 0
    assert result["coefficients"]["clFront"] + result["coefficients"]["clRear"] == pytest.approx(result["coefficients"]["cl"])
    assert result["forces"]["drag"] == pytest.approx(result["forces"]["dynamicPressure"] * summary["cd"] * prepared.metrics.frontal_area)


def test_mismatched_reference_values_are_rescaled_with_a_warning() -> None:
    config = config_for("fastback", mode="cfd")
    prepared = prepare_case(config)
    area = prepared.metrics.frontal_area
    summary = summarize_force_coeffs(parse_force_coeffs(coefficient_file(area=2 * area, speed=30.0)))
    result = result_from_coefficients(config, prepared, summary, IMPORT_PROVENANCE)
    codes = {warning["code"] for warning in result["warnings"]}
    assert {"CFD_REFERENCE_AREA", "CFD_REFERENCE_SPEED"} <= codes
    expected = summary["cd"] * 2 * (30.0 / prepared.flow.speed) ** 2
    assert result["coefficients"]["cd"] == pytest.approx(expected)


def test_missing_solver_fails_explicitly_instead_of_substituting(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    engine = OpenFOAMEngine()
    available, detail = engine.availability()
    assert not available and "not available" in detail
    config = config_for("sedan", mode="cfd")
    with pytest.raises(SimulationError) as caught:
        engine.simulate(config)
    assert caught.value.code == "CFD_SOLVER_UNAVAILABLE"
    assert "No CFD result was produced" in caught.value.message
    with pytest.raises(SimulationError) as caught:
        engine.run(config["geometry"], config)
    assert caught.value.code == "CFD_SOLVER_UNAVAILABLE"
    with pytest.raises(SimulationError) as caught:
        engine.get_results()
    assert caught.value.code == "CFD_NO_CASE"


def test_get_results_reads_solver_output_from_the_case(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = OpenFOAMEngine()
    config = config_for("sedan", mode="cfd")
    case_dir, _, prepared = engine.prepare_case_files(config)
    assert case_dir.parent == openfoam.CASES_DIR
    with pytest.raises(SimulationError) as caught:
        engine.get_results()
    assert caught.value.code == "CFD_NO_RESULTS"
    output = case_dir / "postProcessing/forceCoeffs/0"
    output.mkdir(parents=True)
    (output / "coefficient.dat").write_text(coefficient_file(area=prepared.metrics.frontal_area))
    assert engine.get_results()["cd"] == pytest.approx(0.3012, abs=2e-3)
