"""Pydantic models of the API. Field names are the camelCase names used by the frontend."""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, create_model, model_validator

from geometry.parameters import PARAM_DEFINITIONS

SimulationMode = Literal["analytical", "reduced-order", "cfd", "ml-surrogate"]
Fidelity = Literal["coarse", "medium", "fine"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _geometry_fields() -> dict[str, Any]:
    """One bounded float field per geometry parameter, taken from shared/parameters.json."""
    fields: dict[str, Any] = {}
    for definition in PARAM_DEFINITIONS:
        fields[definition["id"]] = (
            Annotated[float, Field(ge=definition["min"], le=definition["max"], description=definition["label"])],
            ...,
        )
    return fields


#: Geometry parameters, each validated against its allowed range.
GeometryModel = create_model("GeometryParams", __base__=StrictModel, **_geometry_fields())


class Reference(StrictModel):
    cd: float = Field(gt=0.05, lt=1.5)
    cl: float = Field(gt=-3, lt=2)


class Environment(StrictModel):
    airDensityMode: Literal["direct", "computed"]
    airDensity: float = Field(gt=0.3, lt=2.0)
    temperature: float = Field(ge=200, le=340)
    pressure: float = Field(ge=30000, le=120000)
    humidity: float = Field(ge=0, le=1)
    windSpeed: float = Field(ge=0, le=60)
    windAngle: float = Field(ge=-90, le=90)
    gradient: float = Field(ge=-30, le=45)


class CfdSurface(StrictModel):
    """A closed surface stored on the backend (POST /api/cfd/surfaces) that Mode C meshes instead of the parametric body."""

    id: str = Field(pattern=r"^[0-9a-f]{16}$")
    # How the surface was wrapped, for the record that goes with a result.
    voxel: float | None = Field(default=None, gt=0, le=0.2)
    seal: float | None = Field(default=None, ge=0, le=1)


class SimulationConfig(StrictModel):
    vehicleId: str = Field(min_length=1, max_length=120)
    reference: Reference
    referenceGeometry: GeometryModel  # type: ignore[valid-type]
    geometry: GeometryModel  # type: ignore[valid-type]
    environment: Environment
    speed: float = Field(ge=0, le=150)
    mode: SimulationMode
    fidelity: Fidelity
    cfdSurface: CfdSurface | None = None


class PowerCurvePoint(StrictModel):
    rpm: float = Field(ge=0, le=30000)
    powerW: float = Field(ge=0, le=5e6)


class IcePowertrain(StrictModel):
    type: Literal["ICE"]
    peakPowerW: float = Field(gt=0, le=5e6)
    peakPowerRpm: float = Field(gt=500, le=25000)
    peakTorqueNm: float = Field(gt=0, le=10000)
    peakTorqueRpm: float = Field(gt=300, le=25000)
    idleRpm: float = Field(gt=200, le=5000)
    redlineRpm: float = Field(gt=1000, le=25000)
    gearRatios: list[Annotated[float, Field(gt=0.1, lt=20)]] = Field(min_length=1, max_length=12)
    finalDrive: float = Field(gt=0.5, lt=15)
    drivetrainEfficiency: float = Field(gt=0.3, le=1)
    shiftTime: float = Field(ge=0, le=3)
    powerCurve: list[PowerCurvePoint] | None = None

    @model_validator(mode="after")
    def _check_speeds(self) -> "IcePowertrain":
        if self.redlineRpm <= self.idleRpm:
            raise ValueError("redlineRpm must be greater than idleRpm")
        if self.powerCurve is not None and len(self.powerCurve) < 2:
            raise ValueError("powerCurve needs at least two points")
        return self


class EvPowertrain(StrictModel):
    type: Literal["EV"]
    peakPowerW: float = Field(gt=0, le=5e6)
    peakTorqueNm: float = Field(gt=0, le=20000)
    maxMotorRpm: float = Field(gt=1000, le=40000)
    gearRatio: float = Field(gt=1, lt=30)
    drivetrainEfficiency: float = Field(gt=0.3, le=1)
    batteryCapacityJ: float = Field(gt=0, le=2e9)


Powertrain = Annotated[Union[IcePowertrain, EvPowertrain], Field(discriminator="type")]


class VehicleSpec(StrictModel):
    mass: float = Field(gt=200, le=10000)
    cgHeight: float = Field(gt=0.1, le=2)
    weightDistFront: float = Field(gt=0.1, lt=0.9)
    drivetrain: Literal["FWD", "RWD", "AWD"]
    crr: float = Field(gt=0, lt=0.1)
    tireMu: float = Field(gt=0.1, lt=3)


class VehicleDefinition(VehicleSpec):
    id: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9][a-z0-9\-]*$")
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=600)
    reference: Reference
    geometry: GeometryModel  # type: ignore[valid-type]
    powertrain: Powertrain
    custom: bool | None = None


class CreateSimulationRequest(StrictModel):
    config: SimulationConfig


class SweepRequest(StrictModel):
    config: SimulationConfig
    spec: VehicleSpec
    powertrain: Powertrain
    paramX: str
    valuesX: list[float] = Field(min_length=1, max_length=80)
    paramY: str | None = None
    valuesY: list[float | None] = Field(default_factory=list, max_length=80)

    @model_validator(mode="after")
    def _check_params(self) -> "SweepRequest":
        known = {definition["id"] for definition in PARAM_DEFINITIONS}
        if self.paramX not in known:
            raise ValueError(f"unknown parameter {self.paramX!r}")
        if self.paramY is not None:
            if self.paramY not in known:
                raise ValueError(f"unknown parameter {self.paramY!r}")
            if self.paramY == self.paramX:
                raise ValueError("paramX and paramY must differ")
            if not self.valuesY or any(value is None or not math.isfinite(value) for value in self.valuesY):
                raise ValueError("valuesY must contain finite numbers when paramY is set")
        if len(self.valuesX) * max(len(self.valuesY), 1) > 400:
            raise ValueError("a sweep may contain at most 400 points")
        return self


class DesignVariable(StrictModel):
    param: str
    min: float
    max: float

    @model_validator(mode="after")
    def _check(self) -> "DesignVariable":
        definitions = {definition["id"]: definition for definition in PARAM_DEFINITIONS}
        if self.param not in definitions:
            raise ValueError(f"unknown parameter {self.param!r}")
        definition = definitions[self.param]
        if self.max < self.min:
            raise ValueError("max must not be below min")
        if self.min < definition["min"] - 1e-9 or self.max > definition["max"] + 1e-9:
            raise ValueError(f"bounds of {self.param} exceed its allowed range")
        return self


class Constraint(StrictModel):
    metric: Literal["cd", "cl", "drag", "downforce", "topSpeed", "efficiency"]
    op: Literal[">=", "<="]
    value: float


class OptimizationRequest(StrictModel):
    config: SimulationConfig
    spec: VehicleSpec
    powertrain: Powertrain
    objective: Literal["min-drag", "max-downforce", "max-top-speed", "max-efficiency", "meet-targets"]
    variables: list[DesignVariable] = Field(min_length=1, max_length=16)
    constraints: list[Constraint] = Field(default_factory=list, max_length=12)
    algorithm: Literal["differential-evolution", "bayesian"]
    iterations: int = Field(ge=1, le=500)
    seed: int = Field(ge=0, le=2**31 - 1)


class SurrogateTrainRequest(StrictModel):
    config: SimulationConfig
    sourceMode: Literal["analytical", "reduced-order"]
    samples: int = Field(ge=40, le=5000)
    parameters: list[str] = Field(min_length=1, max_length=31)
    spread: float = Field(gt=0, le=1)
    seed: int = Field(ge=0, le=2**31 - 1)

    @model_validator(mode="after")
    def _check_params(self) -> "SurrogateTrainRequest":
        known = {definition["id"] for definition in PARAM_DEFINITIONS}
        unknown = [param for param in self.parameters if param not in known]
        if unknown:
            raise ValueError(f"unknown parameters: {', '.join(unknown)}")
        return self


class CfdImportRequest(StrictModel):
    config: SimulationConfig
    coefficientFile: str = Field(min_length=1, max_length=2_000_000)
