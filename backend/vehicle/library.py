"""Vehicle library: built-in generic classes plus user-created vehicles stored on disk."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from physics.model import REAL_CAR_DATA, VEHICLE_DATA

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
CUSTOM_VEHICLES_FILE = DATA_DIR / "vehicles.json"

BUILT_IN_VEHICLES: list[dict[str, Any]] = VEHICLE_DATA["vehicles"]
_lock = threading.Lock()


def _to_vehicle(record: dict[str, Any]) -> dict[str, Any]:
    """A production car (shared/real-cars.json) as a library vehicle. Mirrors lib/vehicle/library.ts.

    The calibration anchor is the generic class, not the car: the reference
    coefficients and the geometry they belong to are the class's, so the car's
    own coefficients are a prediction.
    """
    anchor = next((vehicle for vehicle in BUILT_IN_VEHICLES if vehicle["id"] == record["anchorClass"]), None)
    if anchor is None:
        raise KeyError(f'Real car "{record["id"]}" names an unknown anchor class "{record["anchorClass"]}"')
    if anchor["powertrain"]["type"] != record["powertrain"]["type"]:
        raise ValueError(f'Real car "{record["id"]}" and its anchor class "{anchor["id"]}" have different powertrain types')
    return {
        "id": record["id"],
        "name": record["name"],
        "description": (
            f'Parametric look-alike of the {record["name"]} ({record["years"]}), built from published dimensions and estimated '
            "proportions. It is a simplified shape, not the manufacturer's surfaces."
        ),
        "reference": dict(anchor["reference"]),
        "referenceGeometry": dict(anchor["geometry"]),
        "geometry": dict(record["geometry"]),
        "mass": record["mass"],
        "drivetrain": record["drivetrain"],
        "cgHeight": anchor["cgHeight"],
        "weightDistFront": record.get("weightDistFront", anchor["weightDistFront"]),
        "crr": anchor["crr"],
        "tireMu": anchor["tireMu"],
        "powertrain": {**anchor["powertrain"], **record["powertrain"]},
        "realCar": {
            "years": record["years"],
            "bodyStyle": record["bodyStyle"],
            "anchorClassId": anchor["id"],
            "anchorClassName": anchor["name"],
            "published": record["published"],
            "sources": record["sources"],
            "notes": record["notes"],
            "basis": record["basis"],
        },
    }


#: Production cars as parametric look-alikes (published figures for comparison only).
REAL_CARS: list[dict[str, Any]] = [_to_vehicle(record) for record in REAL_CAR_DATA["cars"]]
LIBRARY_VEHICLES: list[dict[str, Any]] = [*BUILT_IN_VEHICLES, *REAL_CARS]


def get_built_in_vehicle(vehicle_id: str) -> dict[str, Any]:
    for vehicle in LIBRARY_VEHICLES:
        if vehicle["id"] == vehicle_id:
            return vehicle
    raise KeyError(f'Unknown built-in vehicle "{vehicle_id}"')


def load_custom_vehicles() -> list[dict[str, Any]]:
    with _lock:
        if not CUSTOM_VEHICLES_FILE.exists():
            return []
        try:
            return json.loads(CUSTOM_VEHICLES_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []


def save_custom_vehicle(vehicle: dict[str, Any]) -> dict[str, Any]:
    """Adds or replaces a custom vehicle (matched by id)."""
    stored = {**vehicle, "custom": True}
    existing = [entry for entry in load_custom_vehicles() if entry["id"] != stored["id"]]
    existing.append(stored)
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CUSTOM_VEHICLES_FILE.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    return stored


def all_vehicles() -> list[dict[str, Any]]:
    return [*LIBRARY_VEHICLES, *load_custom_vehicles()]


def vehicle_spec_of(vehicle: dict[str, Any]) -> dict[str, Any]:
    return {key: vehicle[key] for key in ("mass", "cgHeight", "weightDistFront", "drivetrain", "crr", "tireMu")}


STANDARD_ENVIRONMENT: dict[str, Any] = {
    "airDensityMode": "computed",
    "airDensity": 1.225,
    "temperature": 288.15,
    "pressure": 101325,
    "humidity": 0,
    "windSpeed": 0,
    "windAngle": 0,
    "gradient": 0,
}


def make_config(
    vehicle: dict[str, Any],
    geometry: dict[str, float] | None = None,
    environment: dict[str, Any] | None = None,
    speed: float = 150 / 3.6,
    mode: str = "analytical",
    fidelity: str = "coarse",
) -> dict[str, Any]:
    """Configuration of one simulation for a (possibly modified) vehicle."""
    return {
        "vehicleId": vehicle["id"],
        "reference": dict(vehicle["reference"]),
        # A production-car look-alike is anchored to its generic class, not to itself.
        "referenceGeometry": dict(vehicle.get("referenceGeometry", vehicle["geometry"])),
        "geometry": dict(geometry or vehicle["geometry"]),
        "environment": {**STANDARD_ENVIRONMENT, **(environment or {})},
        "speed": speed,
        "mode": mode,
        "fidelity": fidelity,
    }
