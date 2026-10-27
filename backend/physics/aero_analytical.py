"""Mode A — analytical aerodynamic model (mirror of lib/physics/aeroAnalytical.ts).

A semi-empirical component build-up: drag and lift coefficients are assembled
from closed-form correlations for the forebody, rear end, underbody, wheels,
skin friction and aero devices. No flow field is solved. This is NOT CFD.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from geometry.metrics import GeometryMetrics
from geometry.profile import BodyShape, mirror_geometry, plan_half_width, spoiler_geometry, wing_geometry
from physics.atmosphere import reynolds_number
from physics.model import DEG_TO_RAD, MODEL
from physics.rear_flow import RearFlow, compute_rear_flow

D = MODEL["drag"]
L = MODEL["lift"]
W = MODEL["wing"]
DIST = MODEL["liftDistribution"]
YAW = MODEL["yaw"]


@dataclass(frozen=True)
class FlowState:
    """Onset flow relative to the vehicle."""

    speed: float
    yaw_deg: float
    density: float
    viscosity: float


@dataclass
class Item:
    id: str
    label: str
    value: float
    front: float = 0.5

    def to_json(self) -> dict[str, object]:
        return {"id": self.id, "label": self.label, "value": self.value}


@dataclass
class RawAero:
    cd: float
    cl: float
    cl_front: float
    cl_rear: float
    cs: float
    cm_yaw: float
    cd_friction: float
    drag: list[Item]
    lift: list[Item]
    rear_flow: RearFlow
    extra: dict[str, float] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Component correlations (also reused by the reduced-order engine as closures)
# ---------------------------------------------------------------------------


def friction_drag(metrics: GeometryMetrics, flow: FlowState) -> float:
    """Turbulent flat-plate skin friction applied to the wetted area, with a form factor."""
    reynolds = max(reynolds_number(flow.density, max(flow.speed, 1.0), metrics.length, flow.viscosity), 1e4)
    cf = D["frictionCoefficient"] * reynolds ** D["frictionExponent"]
    return cf * D["frictionFormFactor"] * metrics.wetted_area / metrics.frontal_area


def forebody_drag(shape: BodyShape) -> float:
    params = shape.params
    nose_ratio = params["frontBumperHeight"] / params["roofHeight"]
    greenhouse = max(params["roofHeight"] - params["hoodHeight"], 0.0) / params["roofHeight"]
    sin_screen = math.sin(params["windshieldAngle"] * DEG_TO_RAD)
    value = (
        D["forebodyBase"]
        + D["noseBluntness"] * nose_ratio * nose_ratio
        + D["windshield"] * greenhouse * sin_screen * sin_screen
        - D["frontTaperRelief"] * params["frontTaper"]
    )
    return max(value, 0.005)


def underbody_drag(shape: BodyShape) -> float:
    params = shape.params
    return (
        D["underbodyBase"]
        + D["underbodyRoughness"] * (1 - params["floorFlatness"])
        + D["rideHeightSlope"] * (params["rideHeight"] - D["rideHeightRef"]) * (1 - 0.5 * params["floorFlatness"])
    )


def wheel_drag(shape: BodyShape, metrics: GeometryMetrics) -> float:
    params = shape.params
    exposed_height = min(params["rideHeight"] + D["wheelExposedExtra"], params["wheelDiameter"] / 2)
    tyre = (2 * D["wheelFrontCd"] + 2 * D["wheelRearCd"]) * params["tireWidth"] * exposed_height / metrics.frontal_area
    wheelhouse = (
        # Open rims pump air through the rotating wheel into the wheelhouse; closed covers do not.
        (D["wheelhouseBase"] + D["wheelhouseExposure"] * params["wheelExposure"] + D["rimVentilation"] * params["rimOpenness"])
        * (params["wheelDiameter"] / D["wheelDiameterRef"])
        * math.sqrt(params["tireWidth"] / D["tireWidthRef"])
        * (D["wheelAreaRef"] / metrics.frontal_area)
    )
    return tyre + wheelhouse


def cooling_drag(shape: BodyShape) -> float:
    """Cooling drag: momentum lost by the air that goes through the radiator."""
    return D["coolingLoss"] * shape.params["grilleOpening"]


def mirror_drag(shape: BodyShape, metrics: GeometryMetrics) -> float:
    """Drag of the two door mirrors, referenced to the vehicle's frontal area (which includes them)."""
    mirror = mirror_geometry(shape)
    if not mirror.present:
        return 0.0
    return 2 * D["mirrorCd"] * mirror.area * D["mirrorSpeedFactor"] * D["mirrorSpeedFactor"] / metrics.frontal_area


def detail_drag_items(shape: BodyShape, metrics: GeometryMetrics) -> list["Item"]:
    """Drag items of the details, shared by the analytical and the reduced-order build-up."""
    return [
        Item("cooling", "Cooling air (grille and intakes)", cooling_drag(shape)),
        Item("mirrors", "Door mirrors", mirror_drag(shape, metrics)),
        Item("detail", "Handles, shut lines, wipers (constant)", D["smallDetail"]),
    ]


def _ground_factors(shape: BodyShape) -> tuple[float, float, float]:
    params = shape.params
    h = params["rideHeight"]
    height_ratio = D["rideHeightRef"] / h
    # Very small gaps choke with boundary-layer fluid, capping the suction.
    choke = 1 - math.exp(-h / L["viscousChokeHeight"])
    skirt = 1 + L["skirtGain"] * min(params["sideSkirtDepth"] / h, L["skirtMaxRatio"])
    return height_ratio, choke, skirt


def underbody_lift(shape: BodyShape) -> float:
    params = shape.params
    height_ratio, choke, skirt = _ground_factors(shape)
    floor = L["underbodyRoughFloor"] + (1 - L["underbodyRoughFloor"]) * params["floorFlatness"]
    gain = min(height_ratio, L["underbodyMaxGain"]) ** L["underbodyExponent"]
    return -L["underbody"] * floor * gain * choke * skirt


def diffuser_effect(shape: BodyShape) -> tuple[float, float]:
    """Returns (cl, cd) of the diffuser."""
    params, length = shape.params, shape.length
    diffuser_length = length - shape.x_diffuser_start
    if diffuser_length < 1e-6 or params["diffuserAngle"] < 1e-6:
        return 0.0, 0.0
    height_ratio, choke, skirt = _ground_factors(shape)
    r = params["diffuserAngle"] / L["diffuserOptimumDeg"]
    efficiency = r * math.exp((1 - r * r) / 2)
    floor = L["diffuserRoughFloor"] + (1 - L["diffuserRoughFloor"]) * params["floorFlatness"]
    width_ratio = 2 * float(plan_half_width(shape, length)) / params["width"]
    gain = min(height_ratio, L["underbodyMaxGain"]) ** L["diffuserRideExponent"]
    cl = -L["diffuser"] * floor * efficiency * (diffuser_length / length) * width_ratio * gain * choke * skirt
    return cl, D["diffuserInduced"] * abs(cl)


def spoiler_effect(shape: BodyShape, metrics: GeometryMetrics, separation_fraction: float) -> tuple[float, float]:
    """Returns (cl, cd) of the lip spoiler."""
    spoiler = spoiler_geometry(shape)
    if not spoiler.present or spoiler.rise <= 0:
        return 0.0, 0.0
    area_ratio = spoiler.rise * 2 * spoiler.half_width / metrics.frontal_area
    effectiveness = 1 - L["spoilerSeparatedLoss"] * separation_fraction
    cl = -L["spoilerMax"] * (1 - math.exp(-area_ratio / L["spoilerAreaRef"])) * effectiveness
    x = spoiler.rise / D["spoilerOptimumHeight"]
    cd = D["spoilerPlate"] * area_ratio * effectiveness - D["spoilerBenefit"] * x * math.exp(1 - x)
    return cl, cd


def wing_effect(shape: BodyShape, metrics: GeometryMetrics, q_ratio: float | None = None) -> tuple[float, float]:
    """Rear wing from finite-wing (lifting-line) theory. Returns (cl, cd)."""
    wing = wing_geometry(shape)
    if not wing.present:
        return 0.0, 0.0
    if q_ratio is None:
        q_ratio = W["dynamicPressureRatio"]
    aspect_ratio = wing.span / wing.chord
    slope = 2 * math.pi * aspect_ratio / (aspect_ratio + 2)
    alpha = (wing.angle_deg + W["zeroLiftOffsetDeg"]) * DEG_TO_RAD
    wing_cl = W["clMax"] * math.tanh(slope * alpha / W["clMax"])
    stall = max(wing.angle_deg - W["stallOnsetDeg"], 0.0)
    wing_cd = W["profileCd"] + wing_cl * wing_cl / (math.pi * aspect_ratio * W["oswaldEfficiency"]) + W["stallDrag"] * stall * stall
    area_ratio = q_ratio * wing.span * wing.chord / metrics.frontal_area
    return -wing_cl * area_ratio, wing_cd * area_ratio + W["supportDrag"]


def splitter_effect(shape: BodyShape, metrics: GeometryMetrics) -> tuple[float, float]:
    """Returns (cl, cd) of the front splitter."""
    params = shape.params
    if params["splitterExtension"] < 1e-6:
        return 0.0, 0.0
    width = L["splitterWidthFactor"] * params["width"] * (1 - params["frontTaper"])
    area_ratio = params["splitterExtension"] * width / metrics.frontal_area
    gain = min(D["rideHeightRef"] / params["rideHeight"], L["splitterMaxGain"])
    return -L["splitter"] * area_ratio * gain, D["splitter"] * area_ratio


def slant_lift(rear_flow: RearFlow, frontal_area: float) -> float:
    attached = (
        L["slantAttached"] * min(rear_flow.effective_slant_deg / L["slantRefDeg"], 1.2) * (1 - rear_flow.slant_separated)
    )
    separated = -rear_flow.base_pressure_coefficient * rear_flow.slant_separated
    return (attached + separated) * rear_flow.slant_plan_area / frontal_area


@dataclass(frozen=True)
class YawEffects:
    cd_increment: float
    cl_increment: float
    cs: float
    cm_yaw: float


def yaw_effects(shape: BodyShape, metrics: GeometryMetrics, cd_zero_yaw: float, yaw_deg: float) -> YawEffects:
    """Crosswind sensitivity; cm_yaw > 0 means the nose is pushed downwind."""
    yaw = yaw_deg * DEG_TO_RAD
    sin_yaw = math.sin(yaw)
    side_ratio = metrics.side_area / metrics.frontal_area
    cs = YAW["sideForce"] * side_ratio * sin_yaw * math.cos(yaw)
    centre_of_pressure = metrics.side_area_centroid_x - YAW["centreOfPressureLead"] * metrics.length
    mid_wheelbase = 0.5 * (shape.front_axle_x + shape.rear_axle_x)
    return YawEffects(
        cd_increment=cd_zero_yaw * YAW["dragGain"] * side_ratio * sin_yaw * sin_yaw,
        cl_increment=YAW["liftGain"] * side_ratio * sin_yaw * sin_yaw,
        cs=cs,
        cm_yaw=cs * (mid_wheelbase - centre_of_pressure) / shape.params["wheelbase"],
    )


def sum_lift(lift: list[Item]) -> tuple[float, float, float]:
    """Returns (cl, cl_front, cl_rear)."""
    cl = sum(item.value for item in lift)
    cl_front = sum(item.value * item.front for item in lift)
    return cl, cl_front, cl - cl_front


def analytical_raw(shape: BodyShape, metrics: GeometryMetrics, flow: FlowState) -> RawAero:
    """Uncalibrated Mode A coefficients for a geometry in a given onset flow."""
    rear_flow = compute_rear_flow(shape, metrics.frontal_area)
    diffuser_cl, diffuser_cd = diffuser_effect(shape)
    spoiler_cl, spoiler_cd = spoiler_effect(shape, metrics, rear_flow.separation_fraction)
    wing_cl, wing_cd = wing_effect(shape, metrics)
    splitter_cl, splitter_cd = splitter_effect(shape, metrics)
    cd_friction = friction_drag(metrics, flow)
    params, length = shape.params, shape.length

    drag = [
        Item("forebody", "Forebody pressure", forebody_drag(shape)),
        Item("base", "Base pressure (wake)", -rear_flow.base_pressure_coefficient * rear_flow.base_area / metrics.frontal_area),
        Item("vortex", "Rear-slant trailing vortices", rear_flow.vortex_drag),
        Item("underbody", "Underbody", underbody_drag(shape)),
        Item("wheels", "Wheels and wheelhouses", wheel_drag(shape, metrics)),
        Item("friction", "Skin friction", cd_friction),
        *detail_drag_items(shape, metrics),
        Item("diffuser", "Diffuser (induced)", diffuser_cd),
        Item("spoiler", "Rear spoiler", spoiler_cd),
        Item("wing", "Rear wing", wing_cd),
        Item("splitter", "Front splitter", splitter_cd),
    ]
    lift = [
        Item("bodyBase", "Body (baseline)", L["bodyBase"], DIST["bodyBase"]),
        Item("camber", "Body camber", L["camber"] * (params["roofHeight"] / length - L["camberRef"]), DIST["camber"]),
        Item("slant", "Rear window", slant_lift(rear_flow, metrics.frontal_area), DIST["slant"]),
        Item("underbody", "Underbody (ground effect)", underbody_lift(shape), DIST["underbody"]),
        Item("diffuser", "Diffuser", diffuser_cl, DIST["diffuser"]),
        Item("spoiler", "Rear spoiler", spoiler_cl, DIST["spoiler"]),
        Item("wing", "Rear wing", wing_cl, DIST["wing"]),
        Item("splitter", "Front splitter", splitter_cl, DIST["splitter"]),
    ]

    cd_zero_yaw = sum(item.value for item in drag)
    yaw = yaw_effects(shape, metrics, cd_zero_yaw, flow.yaw_deg)
    drag.append(Item("yaw", "Yaw-induced", yaw.cd_increment))
    lift.append(Item("yaw", "Yaw-induced", yaw.cl_increment, DIST["yaw"]))

    cl, cl_front, cl_rear = sum_lift(lift)
    return RawAero(
        cd=cd_zero_yaw + yaw.cd_increment,
        cl=cl,
        cl_front=cl_front,
        cl_rear=cl_rear,
        cs=yaw.cs,
        cm_yaw=yaw.cm_yaw,
        cd_friction=cd_friction,
        drag=drag,
        lift=lift,
        rear_flow=rear_flow,
    )
