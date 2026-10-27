"""Runs Mode C on a wrapped surface from the command line, without the browser.

    cd backend
    uv run python tools/run_surface_case.py <wrap.f32> [coarse|medium|fine] [speed_kmh]

<wrap.f32> is the file tests/realModel.test.ts writes with AEROLAB_WRAP_OUT (float32 triangles in tunnel
coordinates); the .json next to it holds the vehicle id and the geometry fitted to the model. The surface is
stored exactly as the API would store it, and the engine is run exactly as a Mode C request would run it.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engines.openfoam import OpenFOAMEngine  # noqa: E402
from geometry.surface import store_surface  # noqa: E402
from vehicle.library import get_built_in_vehicle, make_config  # noqa: E402


def main() -> None:
    wrap = Path(sys.argv[1])
    fidelity = sys.argv[2] if len(sys.argv) > 2 else "coarse"
    speed = float(sys.argv[3]) / 3.6 if len(sys.argv) > 3 else 130 / 3.6
    meta = json.loads(Path(f"{wrap}.json").read_text(encoding="utf-8"))

    info = store_surface(wrap.read_bytes())
    print("surface:", json.dumps(info.to_json()), flush=True)

    config = make_config(get_built_in_vehicle(meta["vehicleId"]), speed=speed)
    config.update(geometry=meta["geometry"], mode="cfd", fidelity=fidelity, cfdSurface={"id": info.id, **meta.get("wrap", {})})

    started = time.monotonic()
    last = [""]

    def report(state: str, progress: float, message: str) -> None:
        if message != last[0]:
            last[0] = message
            print(f"[{time.monotonic() - started:7.1f} s] {state:15s} {progress:5.2f}  {message}", flush=True)

    result = OpenFOAMEngine().simulate(config, report)
    summary = {
        "coefficients": result["coefficients"],
        "uncertainty": result.get("uncertainty"),
        "frontalArea": result["metrics"]["frontalArea"],
        "cfd": result.get("cfd"),
        "warnings": [f"{warning['code']}: {warning['message']}" for warning in result["warnings"]],
        "provenance": result["provenance"],
        "seconds": round(time.monotonic() - started, 1),
    }
    print(json.dumps(summary, indent=2, default=str), flush=True)


if __name__ == "__main__":
    main()
