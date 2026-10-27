"""Mode C solver orchestration, exercised with a stand-in tool chain.

OpenFOAM itself is not needed here. The tests put small shell scripts named
like the OpenFOAM programs behind a fake `openfoam` session wrapper and check
what the adapter does with them: how it finds the solver, which steps it runs
in which order, how it reports progress, failures and time-outs, and how it
labels the result. The stand-in "solver" copies a coefficient file fixture; the
numbers in it are parser fixtures, not CFD results.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
import pytest

import engines.openfoam as openfoam
from engines.openfoam import (
    MESH_SETTINGS,
    OpenFOAMEngine,
    _wrapper_candidates as real_wrapper_candidates,  # bound before the test fixture replaces it
    estimate_cells,
    find_launcher,
    generate_case,
    parse_force_coeffs,
    plan_case,
    processors_for,
    result_from_coefficients,
    solver_availability,
    summarize_force_coeffs,
)
from simulation.assemble import SimulationError, prepare_case
from tests.helpers import config_for
from tests.test_api import client, run_simulation
from tests.test_openfoam import coefficient_file

RECORD = 'echo "$(basename "$0") $*" >> calls.log\n'


def fake_tools(
    directory: Path,
    iterations: int = 400,
    fail: str | None = None,
    solver_delay: float = 0.0,
    failed_mesh_checks: int = 0,
    coefficients: str | None = None,
    body_y_plus: float | None = 120.0,
) -> Path:
    """Shell scripts standing in for the OpenFOAM programs. Each records its call in calls.log."""
    directory.mkdir(parents=True, exist_ok=True)

    def tool(name: str, body: str) -> None:
        path = directory / name
        path.write_text("#!/bin/sh\n" + RECORD + body, encoding="utf-8")
        path.chmod(0o755)

    for name in ("blockMesh", "surfaceFeatureExtract", "snappyHexMesh", "decomposePar"):
        tool(name, "echo 'FOAM FATAL ERROR: synthetic failure'\nexit 3\n" if fail == name else "echo End\n")
    mesh_verdict = f"echo 'Failed {failed_mesh_checks} mesh checks.'\n" if failed_mesh_checks else "echo 'Mesh OK.'\n"
    tool("checkMesh", "echo '    cells:            123456'\n" + mesh_verdict)
    tool("mpirun", 'shift 2\nexec "$@"\n')
    tool(
        "simpleFoam",
        (f"sleep {solver_delay}\n" if solver_delay else "")
        + f'i=1\nwhile [ "$i" -le {iterations} ]; do echo "Time = $i"; i=$((i + 1)); done\n'
        + (f"echo '    patch body y+ : min = 41.1, max = 3318.4, average = {body_y_plus}'\n" if body_y_plus else "")
        + "mkdir -p postProcessing/forceCoeffs/0\n"
        + f'cp "{directory}/coefficient.dat" postProcessing/forceCoeffs/0/coefficient.dat\n'
        + "echo End\n",
    )
    (directory / "coefficient.dat").write_text(coefficients or coefficient_file(), encoding="utf-8")
    return directory


def fake_wrapper(path: Path, tools: Path, version: str = "v-test") -> Path:
    """Stand-in for OpenFOAM's `openfoam -c "<command>"` session wrapper."""
    path.write_text(
        "#!/bin/sh\n"
        '[ "$1" = "-c" ] || exit 64\n'
        f'PATH="{tools}:$PATH"\nWM_PROJECT_VERSION={version}\nexport PATH WM_PROJECT_VERSION\n'
        'exec sh -c "$2"\n',
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def use_wrapper(monkeypatch: pytest.MonkeyPatch, wrapper: Path) -> None:
    monkeypatch.setattr(openfoam, "_wrapper_candidates", lambda: [str(wrapper)])
    openfoam.reset_launcher_cache()


def calls(case_dir: Path) -> list[str]:
    return (case_dir / "calls.log").read_text(encoding="utf-8").splitlines()


# ---------------------------------------------------------------------------
# Finding OpenFOAM
# ---------------------------------------------------------------------------


def test_programs_on_the_path_are_used_directly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tools = fake_tools(tmp_path / "tools")
    monkeypatch.setenv("PATH", f"{tools}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("WM_PROJECT_VERSION", "v9999")
    openfoam.reset_launcher_cache()
    launcher, detail = find_launcher()
    assert launcher is not None and launcher.wrapper is None and launcher.version == "v9999"
    assert "found on PATH" in detail
    assert launcher.argv("blockMesh") == ["sh", "-c", "blockMesh"]
    assert solver_availability() == (True, detail)


def test_a_session_wrapper_is_used_when_the_programs_are_not_on_the_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    wrapper = fake_wrapper(tmp_path / "openfoam", fake_tools(tmp_path / "tools"))
    use_wrapper(monkeypatch, wrapper)
    launcher, detail = find_launcher()
    assert launcher is not None and launcher.wrapper == str(wrapper) and launcher.version == "v-test"
    assert "session wrapper" in detail and str(wrapper) in detail
    assert launcher.argv("snappyHexMesh -overwrite") == [str(wrapper), "-c", "snappyHexMesh -overwrite"]


def test_a_wrapper_without_the_solver_is_not_accepted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", empty))
    launcher, detail = find_launcher()
    assert launcher is None
    assert "not available" in detail and "does not provide blockMesh, snappyHexMesh, simpleFoam" in detail
    monkeypatch.setattr(openfoam, "_wrapper_candidates", lambda: [str(tmp_path / "no-such-wrapper")])
    openfoam.reset_launcher_cache()
    assert "could not be started" in find_launcher()[1]


def test_wrapper_candidates_come_from_the_environment_the_path_and_the_app_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def executable(path: Path) -> str:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n", encoding="utf-8")
        path.chmod(0o755)
        return str(path)

    on_path = executable(tmp_path / "bin/openfoam")
    older = executable(tmp_path / "bin/openfoam2412")
    newer = executable(tmp_path / "bin/openfoam2606")
    bundled = executable(tmp_path / "Applications/OpenFOAM-v2606.app/Contents/Resources/etc/openfoam")
    (tmp_path / "bin/openfoam-notes.txt").write_text("not executable", encoding="utf-8")
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))
    monkeypatch.setattr(openfoam, "APP_WRAPPER_PATTERN", str(tmp_path / "Applications/OpenFOAM-v*.app/Contents/Resources/etc/openfoam"))
    monkeypatch.delenv(openfoam.WRAPPER_ENV, raising=False)
    assert real_wrapper_candidates() == [on_path, newer, older, bundled]
    # An explicit setting is the only candidate.
    monkeypatch.setenv(openfoam.WRAPPER_ENV, "/somewhere/else/openfoam")
    assert real_wrapper_candidates() == ["/somewhere/else/openfoam"]


def test_the_answer_is_cached_and_a_missing_solver_is_looked_for_again(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    probes: list[str] = []
    wrapper = fake_wrapper(tmp_path / "openfoam", fake_tools(tmp_path / "tools"))

    def counted() -> list[str]:
        probes.append("probe")
        return [str(wrapper)]

    monkeypatch.setattr(openfoam, "_wrapper_candidates", counted)
    openfoam.reset_launcher_cache()
    assert find_launcher()[0] is not None and find_launcher()[0] is not None
    assert len(probes) == 1
    # Not found: the answer expires quickly, so an installation made later is noticed.
    monkeypatch.setattr(openfoam, "_wrapper_candidates", lambda: [])
    monkeypatch.setattr(openfoam, "_MISSING_SECONDS", 0.0)
    openfoam.reset_launcher_cache()
    assert find_launcher()[0] is None
    monkeypatch.setattr(openfoam, "_wrapper_candidates", counted)
    assert find_launcher()[0] is not None


def test_processor_count_follows_the_mesh_size_and_the_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(openfoam, "_performance_cores", lambda: 8)
    assert processors_for(20_000) == 1
    assert processors_for(120_000) == 4
    assert processors_for(5_000_000) == 8
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "3")
    assert processors_for(5_000_000) == 3
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "many")
    assert processors_for(5_000_000) == 8


# ---------------------------------------------------------------------------
# Mesh settings
# ---------------------------------------------------------------------------


def test_the_grid_setting_selects_the_mesh_resolution(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "6")
    estimates = {}
    for fidelity in ("coarse", "medium", "fine"):
        config = {**config_for("fastback", mode="cfd"), "fidelity": fidelity}
        prepared = prepare_case(config)
        plan = plan_case(config, prepared)
        case = tmp_path / fidelity
        generate_case(config, prepared, case)
        estimates[fidelity] = plan.cell_estimate
        settings = MESH_SETTINGS[fidelity]
        assert plan.fidelity == fidelity and plan.settings is settings and plan.processors == 6
        assert plan.cell_estimate == estimate_cells(prepared, settings)

        snappy = (case / "system/snappyHexMeshDict").read_text()
        assert f"body   {{ level ({settings.body_levels[0]} {settings.body_levels[1]});" in snappy
        assert f"addLayers       {'true' if settings.layers else 'false'};" in snappy
        assert f"endTime         {settings.iterations};" in (case / "system/controlDict").read_text()
        assert "numberOfSubdomains 6;" in (case / "system/decomposeParDict").read_text()
        allrun = (case / "Allrun").read_text()
        assert "decomposePar -force -copyZero" in allrun and "mpirun -np 6 simpleFoam -parallel" in allrun
        assert allrun.index("decomposePar") < allrun.index("mpirun -np 6 snappyHexMesh -overwrite -parallel")
        readme = (case / "README-AEROLAB.txt").read_text()
        assert f"Mesh setting  : {fidelity}" in readme
        assert ("COARSE MESH" in readme) == (fidelity == "coarse")

    assert estimates["coarse"] < estimates["medium"] < estimates["fine"]
    assert estimates["coarse"] < 0.3 * estimates["fine"]


def test_a_single_process_case_has_no_decomposition(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "1")
    config = config_for("hatchback", mode="cfd")
    generate_case(config, prepare_case(config), tmp_path / "case")
    allrun = (tmp_path / "case/Allrun").read_text()
    assert "decomposePar" not in allrun and "mpirun" not in allrun
    assert allrun.rstrip().endswith("simpleFoam > log.simpleFoam 2>&1")


# ---------------------------------------------------------------------------
# Running the solver
# ---------------------------------------------------------------------------


def test_a_run_goes_through_every_step_and_returns_what_the_solver_wrote(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", fake_tools(tmp_path / "tools", iterations=400)))
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "4")
    config = config_for("fastback", mode="cfd")
    assert config["fidelity"] == "coarse"
    progress: list[tuple[str, float, str]] = []
    engine = OpenFOAMEngine()
    result = engine.simulate(config, lambda state, fraction, message: progress.append((state, fraction, message)))

    case_dir = engine.case_dir_for(config)
    # The background mesh is decomposed first, so snappyHexMesh and checkMesh run on every process too.
    assert calls(case_dir) == [
        "blockMesh ",
        "surfaceFeatureExtract ",
        "decomposePar -force -copyZero",
        "mpirun -np 4 snappyHexMesh -overwrite -parallel",
        "snappyHexMesh -overwrite -parallel",
        "mpirun -np 4 checkMesh -parallel",
        "checkMesh -parallel",
        "mpirun -np 4 simpleFoam -parallel",
        "simpleFoam -parallel",
    ]
    for label in ("blockMesh", "surfaceFeatures", "snappyHexMesh", "checkMesh", "decomposePar", "simpleFoam"):
        assert (case_dir / f"log.{label}").stat().st_size > 0
    assert "Time = 400" in (case_dir / "log.simpleFoam").read_text()

    # Progress moves forward through the real job states and reports solver iterations.
    states = [state for state, _, _ in progress]
    assert states[0] == "PREPARING" and "MESHING" in states and "SOLVING" in states and states[-1] == "POST_PROCESSING"
    fractions = [fraction for _, fraction, _ in progress]
    assert fractions == sorted(fractions) and fractions[-1] < 1
    assert any(message == "simpleFoam · iteration 400 of at most 500" for _, _, message in progress)

    # The coefficients are exactly what the solver output contains.
    expected = summarize_force_coeffs(parse_force_coeffs(coefficient_file()))
    assert result["mode"] == "cfd" and result["source"] == "backend"
    assert result["coefficients"]["cd"] == pytest.approx(expected["cd"])
    assert result["coefficients"]["cl"] == pytest.approx(expected["cl"])
    run = result["cfd"]
    assert run["meshSetting"] == "coarse" and run["cells"] == 123456 and run["meshChecksFailed"] == 0
    assert run["processors"] == 4 and run["iterations"] == 400 and run["iterationLimit"] == 500
    assert run["residualTargetsMet"] is True and run["openfoamVersion"] == "v-test" and run["wallTimeS"] > 0
    assert "run by the AeroLab backend" in result["provenance"]
    assert "coarse mesh setting, 123,456 cells" in result["provenance"] and "v-test" in result["provenance"]
    # A coarse mesh is flagged as a pipeline check, not as a result to quote.
    codes = {warning["code"] for warning in result["warnings"]}
    assert "CFD_COARSE_MESH" in codes and "CFD_MESH_QUALITY" not in codes and "CFD_RESIDUALS" not in codes
    # y+ is read from the solver log; inside the wall-function range there is nothing to warn about.
    assert run["yPlusBody"] == {"min": 41.1, "max": 3318.4, "average": 120.0} and "CFD_Y_PLUS" not in codes
    # Every backend run says that it is CFD of the idealised shape, as information rather than as a fault.
    note = next(warning for warning in result["warnings"] if warning["code"] == "CFD_SIMPLIFIED_GEOMETRY")
    assert note["severity"] == "info" and "not directly comparable" in note["message"]


@pytest.mark.parametrize(("average", "warned"), [(714.4, True), (12.0, True), (150.0, False), (None, False)])
def test_y_plus_outside_the_wall_function_range_is_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, average: float | None, warned: bool
) -> None:
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", fake_tools(tmp_path / "tools", body_y_plus=average)))
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "1")
    result = OpenFOAMEngine().simulate(config_for("fastback", mode="cfd"))
    assert (result["cfd"]["yPlusBody"] is None) == (average is None)
    warning = [warning for warning in result["warnings"] if warning["code"] == "CFD_Y_PLUS"]
    assert bool(warning) == warned
    if warned:
        assert f"Average y+ on the body is {average:.0f}" in warning[0]["message"]


def test_a_serial_run_skips_decomposition(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tools = fake_tools(tmp_path / "tools", iterations=1000, failed_mesh_checks=2)
    monkeypatch.setenv("PATH", f"{tools}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "1")
    openfoam.reset_launcher_cache()
    config = {**config_for("sedan", mode="cfd"), "fidelity": "medium"}
    engine = OpenFOAMEngine()
    result = engine.simulate(config)
    assert calls(engine.case_dir_for(config)) == ["blockMesh ", "surfaceFeatureExtract ", "snappyHexMesh -overwrite", "checkMesh ", "simpleFoam "]
    codes = {warning["code"] for warning in result["warnings"]}
    # Medium has prism layers, so no coarse-mesh warning; the failed mesh checks and the exhausted
    # iteration limit are both reported.
    assert "CFD_COARSE_MESH" not in codes and {"CFD_MESH_QUALITY", "CFD_RESIDUALS"} <= codes
    assert result["cfd"]["meshChecksFailed"] == 2 and result["cfd"]["residualTargetsMet"] is False


def test_a_failing_step_stops_the_run_and_produces_no_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", fake_tools(tmp_path / "tools", fail="snappyHexMesh")))
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "2")
    config = config_for("suv", mode="cfd")
    engine = OpenFOAMEngine()
    with pytest.raises(SimulationError) as caught:
        engine.simulate(config)
    assert caught.value.code == "CFD_SOLVER_FAILED"
    assert "snappyHexMesh failed with exit code 3" in caught.value.message
    assert "FOAM FATAL ERROR: synthetic failure" in caught.value.message
    # Nothing after the failed step ran, and there is nothing to read back.
    assert calls(engine.case_dir_for(config)) == [
        "blockMesh ",
        "surfaceFeatureExtract ",
        "decomposePar -force -copyZero",
        "mpirun -np 2 snappyHexMesh -overwrite -parallel",
        "snappyHexMesh -overwrite -parallel",
    ]
    with pytest.raises(SimulationError) as caught:
        engine.get_results()
    assert caught.value.code == "CFD_NO_RESULTS"


def test_a_run_that_exceeds_its_time_limit_is_stopped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", fake_tools(tmp_path / "tools", solver_delay=30)))
    monkeypatch.setenv(openfoam.TIMEOUT_ENV, "2")
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "2")
    started = time.monotonic()
    with pytest.raises(SimulationError) as caught:
        OpenFOAMEngine().simulate(config_for("hatchback", mode="cfd"))
    assert caught.value.code == "TIMEOUT" and "simpleFoam" in caught.value.message
    assert time.monotonic() - started < 15


def test_a_solver_that_writes_no_coefficients_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tools = fake_tools(tmp_path / "tools")
    (tools / "simpleFoam").write_text("#!/bin/sh\necho 'Time = 1'\necho End\n", encoding="utf-8")
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", tools))
    with pytest.raises(SimulationError) as caught:
        OpenFOAMEngine().simulate(config_for("hatchback", mode="cfd"))
    assert caught.value.code == "CFD_NO_RESULTS"


def test_mode_c_runs_as_a_job_through_the_api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", fake_tools(tmp_path / "tools")))
    health = client.get("/api/health").json()["engines"]["cfd"]
    assert health["available"] and "session wrapper" in health["detail"]
    job_id, status = run_simulation(config_for("fastback", mode="cfd"))
    assert status["state"] == "COMPLETE", status
    aero = client.get(f"/api/simulations/{job_id}/results").json()["aero"]
    assert aero["mode"] == "cfd" and aero["source"] == "backend" and aero["cfd"]["cells"] == 123456

    case = client.post("/api/cfd/case", json={"config": config_for("fastback")}).json()
    assert case["solverAvailable"] is True and case["meshSetting"] == "coarse"
    assert case["iterations"] == 500 and case["prismLayers"] == 0 and case["processors"] >= 1


# ---------------------------------------------------------------------------
# Convergence of the coefficient history
# ---------------------------------------------------------------------------


def history(cd_values: np.ndarray, cl: float = 0.05) -> str:
    lines = ["# Time\tCd\tCd(f)\tCd(r)\tCl\tCl(f)\tCl(r)\tCmPitch\tCmRoll\tCmYaw\tCs\tCs(f)\tCs(r)"]
    for step, cd in enumerate(cd_values, start=1):
        lines.append("\t".join(str(value) for value in [step, cd, cd / 2, cd / 2, cl, 0.3 * cl, 0.7 * cl, 0.01, 0.0, 0.0, 0.0, 0.0, 0.0]))
    return "\n".join(lines) + "\n"


def test_a_history_that_is_still_drifting_is_reported() -> None:
    config = config_for("sedan", mode="cfd")
    prepared = prepare_case(config)
    steps = np.arange(1, 601)

    settled = summarize_force_coeffs(parse_force_coeffs(history(0.30 + 0.2 * np.exp(-steps / 30))))
    assert abs(settled["cdDrift"]) < 1e-4
    result = result_from_coefficients(config, prepared, settled, "fixture")
    assert "CFD_NOT_SETTLED" not in {warning["code"] for warning in result["warnings"]}

    # Cd still falling by 0.0001 per iteration at the end of the run.
    drifting = summarize_force_coeffs(parse_force_coeffs(history(0.36 - 1e-4 * steps)))
    assert drifting["cdDrift"] == pytest.approx(-1e-4 * drifting["window"])
    result = result_from_coefficients(config, prepared, drifting, "fixture")
    warning = next(warning for warning in result["warnings"] if warning["code"] == "CFD_NOT_SETTLED")
    assert "has not settled" in warning["message"]
    # The drift is part of the stated uncertainty.
    assert result["uncertainty"]["cd"] >= abs(drifting["cdDrift"])

    # Too short to have two windows: no drift is claimed either way.
    short = summarize_force_coeffs(parse_force_coeffs(history(np.full(60, 0.3))))
    assert short["cdDrift"] is None


def progressive_solver(tools: Path, rows: int, cd: float = 0.3012, cl: float = 0.0421) -> None:
    """A stand-in simpleFoam that writes one coefficient row per iteration, like the real one, and stops after the
    iteration in which controlDict asks for `stopAt writeNow`."""
    history = coefficient_file(rows=rows, cd=cd, cl=cl).splitlines()
    header = [line for line in history if line.startswith("#")]
    data = [line for line in history if not line.startswith("#")]
    (tools / "history.dat").write_text("\n".join(data) + "\n", encoding="utf-8")
    (tools / "header.dat").write_text("\n".join(header) + "\n", encoding="utf-8")
    script = tools / "simpleFoam"
    script.write_text(
        "#!/bin/sh\n" + RECORD
        + "out=postProcessing/forceCoeffs/0/coefficient.dat\nmkdir -p postProcessing/forceCoeffs/0\n"
        + f'cp "{tools}/header.dat" "$out"\ni=0\n'
        + f'while IFS= read -r row; do\n  i=$((i + 1))\n  echo "Time = $i"\n  echo "$row" >> "$out"\n'
        + '  if grep -q "^stopAt *writeNow;" system/controlDict; then echo "stopped at $i" > stopped.txt; break; fi\n'
        + f'done < "{tools}/history.dat"\necho End\n',
        encoding="utf-8",
    )
    script.chmod(0o755)


def test_a_run_stops_once_the_coefficients_have_settled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tools = fake_tools(tmp_path / "tools")
    progressive_solver(tools, rows=500)
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", tools))
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "1")
    config = config_for("fastback", mode="cfd")
    engine = OpenFOAMEngine()
    result = engine.simulate(config)
    run = result["cfd"]
    # Checked every 10 iterations from half the limit on; the fixture's start-up transient has died away well
    # before the end. The stand-in runs ahead of the check, so it may get a few iterations further.
    settled = run["settledAt"]
    assert settled is not None and settled % 10 == 0 and 250 <= settled < 500
    assert settled <= run["iterations"] < 500
    assert run["residualTargetsMet"] is False
    case_dir = engine.case_dir_for(config)
    assert "stopAt          writeNow;" in (case_dir / "system/controlDict").read_text()
    assert (case_dir / "stopped.txt").exists()
    message = next(w["message"] for w in result["warnings"] if w["code"] == "CFD_RESIDUALS")
    assert f"stopped at iteration {settled} of at most 500 because Cd and Cl had settled" in message
    assert "CFD_DRIFTING" not in {w["code"] for w in result["warnings"]}
    assert result["coefficients"]["cd"] == pytest.approx(0.3012, abs=5e-4)


def test_a_run_that_is_still_moving_uses_its_full_iteration_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tools = fake_tools(tmp_path / "tools")
    progressive_solver(tools, rows=500)
    # A drag coefficient that keeps rising never settles.
    history = (tools / "history.dat").read_text().splitlines()
    rising = []
    for index, line in enumerate(history):
        values = line.split("\t")
        values[1] = f"{float(values[1]) + 1e-4 * index:.8e}"
        rising.append("\t".join(values))
    (tools / "history.dat").write_text("\n".join(rising) + "\n")
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", tools))
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "1")
    run = OpenFOAMEngine().simulate(config_for("fastback", mode="cfd"))["cfd"]
    assert run["settledAt"] is None and run["iterations"] == 500


def test_stopping_early_can_be_switched_off(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tools = fake_tools(tmp_path / "tools")
    progressive_solver(tools, rows=500)
    use_wrapper(monkeypatch, fake_wrapper(tmp_path / "openfoam", tools))
    monkeypatch.setenv(openfoam.PROCESSORS_ENV, "1")
    monkeypatch.setenv(openfoam.EARLY_STOP_ENV, "0")
    run = OpenFOAMEngine().simulate(config_for("fastback", mode="cfd"))["cfd"]
    assert run["settledAt"] is None and run["iterations"] == 500
