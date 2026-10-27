/**
 * Mode A — analytical aerodynamic model.
 *
 * A semi-empirical component build-up: the drag and lift coefficients are
 * assembled from closed-form correlations for the forebody, rear end, underbody,
 * wheels, skin friction and aero devices. No flow field is solved. The
 * correlations and their constants live in shared/aero-model.json.
 *
 * This is NOT CFD. It captures first-order trends and is anchored to an
 * approximate class reference (see lib/simulation/assemble.ts).
 *
 * backend/physics/aero_analytical.py mirrors this file.
 */
import type { BreakdownItem, GeometryMetrics } from "@/lib/types";
import { DEG_TO_RAD, MODEL } from "@/lib/physics/model";
import { reynoldsNumber } from "@/lib/physics/atmosphere";
import { type BodyShape, mirrorGeometry, planHalfWidth, spoilerGeometry, wingGeometry } from "@/lib/geometry/profile";
import { computeRearFlow, type RearFlowDetail } from "@/lib/physics/rearFlow";

const D = MODEL.drag;
const L = MODEL.lift;
const W = MODEL.wing;
const DIST = MODEL.liftDistribution;
const YAW = MODEL.yaw;

/** Onset flow relative to the vehicle. */
export interface FlowState {
  /** Relative air speed, m/s. */
  speed: number;
  /** Aerodynamic yaw angle, deg. */
  yawDeg: number;
  density: number;
  viscosity: number;
}

export interface LiftComponent extends BreakdownItem {
  /** Fraction of this component carried by the front axle. */
  front: number;
}

export interface RawAero {
  cd: number;
  cl: number;
  clFront: number;
  clRear: number;
  cs: number;
  cmYaw: number;
  cdFriction: number;
  drag: BreakdownItem[];
  lift: LiftComponent[];
  rearFlow: RearFlowDetail;
}

// ---------------------------------------------------------------------------
// Component correlations (also reused by the reduced-order engine as closures)
// ---------------------------------------------------------------------------

/** Turbulent flat-plate skin friction applied to the wetted area, with a form factor. */
export function frictionDrag(metrics: GeometryMetrics, flow: FlowState): number {
  const reynolds = Math.max(
    reynoldsNumber(flow.density, Math.max(flow.speed, 1), metrics.length, flow.viscosity),
    1e4,
  );
  const cf = D.frictionCoefficient * Math.pow(reynolds, D.frictionExponent);
  return (cf * D.frictionFormFactor * metrics.wettedArea) / metrics.frontalArea;
}

/** Forebody pressure drag: nose bluntness, windshield rake and plan taper. */
export function forebodyDrag(shape: BodyShape): number {
  const { params } = shape;
  const noseRatio = params.frontBumperHeight / params.roofHeight;
  const greenhouse = Math.max(params.roofHeight - params.hoodHeight, 0) / params.roofHeight;
  const sinScreen = Math.sin(params.windshieldAngle * DEG_TO_RAD);
  const value =
    D.forebodyBase +
    D.noseBluntness * noseRatio * noseRatio +
    D.windshield * greenhouse * sinScreen * sinScreen -
    D.frontTaperRelief * params.frontTaper;
  return Math.max(value, 0.005);
}

/** Underbody roughness drag plus the effect of ride height on the underbody mass flow. */
export function underbodyDrag(shape: BodyShape): number {
  const { params } = shape;
  return (
    D.underbodyBase +
    D.underbodyRoughness * (1 - params.floorFlatness) +
    D.rideHeightSlope * (params.rideHeight - D.rideHeightRef) * (1 - 0.5 * params.floorFlatness)
  );
}

/** Exposed tyre drag plus wheelhouse ventilation drag. */
export function wheelDrag(shape: BodyShape, metrics: GeometryMetrics): number {
  const { params } = shape;
  const exposedHeight = Math.min(params.rideHeight + D.wheelExposedExtra, params.wheelDiameter / 2);
  const tyre =
    ((2 * D.wheelFrontCd + 2 * D.wheelRearCd) * params.tireWidth * exposedHeight) / metrics.frontalArea;
  // Open rims pump air through the rotating wheel into the wheelhouse; closed covers do not.
  const wheelhouse =
    (D.wheelhouseBase + D.wheelhouseExposure * params.wheelExposure + D.rimVentilation * params.rimOpenness) *
    (params.wheelDiameter / D.wheelDiameterRef) *
    Math.sqrt(params.tireWidth / D.tireWidthRef) *
    (D.wheelAreaRef / metrics.frontalArea);
  return tyre + wheelhouse;
}

/** Cooling drag: momentum lost by the air that goes through the radiator, in proportion to the open intake area. */
export function coolingDrag(shape: BodyShape): number {
  return D.coolingLoss * shape.params.grilleOpening;
}

/**
 * Drag of the two door mirrors: each is a bluff body in air that has speeded up round the A-pillar, and its
 * wake washes the side glass. Referenced to the vehicle's frontal area, of which the mirrors are part.
 */
export function mirrorDrag(shape: BodyShape, metrics: GeometryMetrics): number {
  const mirror = mirrorGeometry(shape);
  if (!mirror.present) return 0;
  return (2 * D.mirrorCd * mirror.area * D.mirrorSpeedFactor * D.mirrorSpeedFactor) / metrics.frontalArea;
}

/** Drag items of the details, shared by the analytical and the reduced-order build-up. */
export function detailDragItems(shape: BodyShape, metrics: GeometryMetrics): BreakdownItem[] {
  return [
    { id: "cooling", label: "Cooling air (grille and intakes)", value: coolingDrag(shape) },
    { id: "mirrors", label: "Door mirrors", value: mirrorDrag(shape, metrics) },
    { id: "detail", label: "Handles, shut lines, wipers (constant)", value: D.smallDetail },
  ];
}

/** Ground-proximity factors shared by the underbody, diffuser and splitter correlations. */
function groundFactors(shape: BodyShape) {
  const { params } = shape;
  const h = params.rideHeight;
  return {
    heightRatio: D.rideHeightRef / h,
    // Very small gaps choke with boundary-layer fluid, capping the suction.
    choke: 1 - Math.exp(-h / L.viscousChokeHeight),
    skirt: 1 + L.skirtGain * Math.min(params.sideSkirtDepth / h, L.skirtMaxRatio),
  };
}

/** Underbody (Venturi) lift: negative, stronger for smooth floors and low ride heights. */
export function underbodyLift(shape: BodyShape): number {
  const { params } = shape;
  const g = groundFactors(shape);
  const floor = L.underbodyRoughFloor + (1 - L.underbodyRoughFloor) * params.floorFlatness;
  const gain = Math.pow(Math.min(g.heightRatio, L.underbodyMaxGain), L.underbodyExponent);
  return -L.underbody * floor * gain * g.choke * g.skirt;
}

/** Diffuser lift (negative) and its induced drag. Efficiency falls beyond the optimum angle. */
export function diffuserEffect(shape: BodyShape): { cl: number; cd: number } {
  const { params, length } = shape;
  const diffuserLength = length - shape.xDiffuserStart;
  if (diffuserLength < 1e-6 || params.diffuserAngle < 1e-6) return { cl: 0, cd: 0 };
  const g = groundFactors(shape);
  const r = params.diffuserAngle / L.diffuserOptimumDeg;
  const efficiency = r * Math.exp((1 - r * r) / 2);
  const floor = L.diffuserRoughFloor + (1 - L.diffuserRoughFloor) * params.floorFlatness;
  const widthRatio = (2 * planHalfWidth(shape, length)) / params.width;
  const gain = Math.pow(Math.min(g.heightRatio, L.underbodyMaxGain), L.diffuserRideExponent);
  const cl =
    -L.diffuser * floor * efficiency * (diffuserLength / length) * widthRatio * gain * g.choke * g.skirt;
  return { cl, cd: D.diffuserInduced * Math.abs(cl) };
}

/** Lip spoiler: raises pressure on the deck (less lift); plate drag minus a small base-pressure benefit. */
export function spoilerEffect(
  shape: BodyShape,
  metrics: GeometryMetrics,
  separationFraction: number,
): { cl: number; cd: number } {
  const spoiler = spoilerGeometry(shape);
  if (!spoiler.present || spoiler.rise <= 0) return { cl: 0, cd: 0 };
  const areaRatio = (spoiler.rise * 2 * spoiler.halfWidth) / metrics.frontalArea;
  // A spoiler sitting in already-separated flow has much less to act on.
  const effectiveness = 1 - L.spoilerSeparatedLoss * separationFraction;
  const cl = -L.spoilerMax * (1 - Math.exp(-areaRatio / L.spoilerAreaRef)) * effectiveness;
  const x = spoiler.rise / D.spoilerOptimumHeight;
  const cd = D.spoilerPlate * areaRatio * effectiveness - D.spoilerBenefit * x * Math.exp(1 - x);
  return { cl, cd };
}

/**
 * Rear wing from finite-wing (lifting-line) theory:
 *   lift slope a = 2 pi AR / (AR + 2),  induced drag CL^2 / (pi AR e).
 * qRatio is the local-to-freestream dynamic pressure ratio at the wing.
 */
export function wingEffect(
  shape: BodyShape,
  metrics: GeometryMetrics,
  qRatio: number = W.dynamicPressureRatio,
): { cl: number; cd: number } {
  const wing = wingGeometry(shape);
  if (!wing.present) return { cl: 0, cd: 0 };
  const aspectRatio = wing.span / wing.chord;
  const slope = (2 * Math.PI * aspectRatio) / (aspectRatio + 2);
  const alpha = (wing.angleDeg + W.zeroLiftOffsetDeg) * DEG_TO_RAD;
  // Smooth saturation toward the section's maximum lift coefficient.
  const wingCl = W.clMax * Math.tanh((slope * alpha) / W.clMax);
  const stall = Math.max(wing.angleDeg - W.stallOnsetDeg, 0);
  const wingCd =
    W.profileCd + (wingCl * wingCl) / (Math.PI * aspectRatio * W.oswaldEfficiency) + W.stallDrag * stall * stall;
  const areaRatio = (qRatio * wing.span * wing.chord) / metrics.frontalArea;
  return { cl: -wingCl * areaRatio, cd: wingCd * areaRatio + W.supportDrag };
}

/** Front splitter: front downforce that strengthens near the ground, small plate drag. */
export function splitterEffect(shape: BodyShape, metrics: GeometryMetrics): { cl: number; cd: number } {
  const { params } = shape;
  if (params.splitterExtension < 1e-6) return { cl: 0, cd: 0 };
  const width = L.splitterWidthFactor * params.width * (1 - params.frontTaper);
  const areaRatio = (params.splitterExtension * width) / metrics.frontalArea;
  const gain = Math.min(D.rideHeightRef / params.rideHeight, L.splitterMaxGain);
  return { cl: -L.splitter * areaRatio * gain, cd: D.splitter * areaRatio };
}

/** Body lift from the upper-surface camber of the car shape. */
export function bodyCamberLift(shape: BodyShape): { base: number; camber: number } {
  const { params, length } = shape;
  return { base: L.bodyBase, camber: L.camber * (params.roofHeight / length - L.camberRef) };
}

/** Lift carried by the rear window: suction when attached, base pressure when separated. */
export function slantLift(rearFlow: RearFlowDetail, frontalArea: number): number {
  const attached =
    L.slantAttached * Math.min(rearFlow.effectiveSlantDeg / L.slantRefDeg, 1.2) * (1 - rearFlow.slantSeparated);
  const separated = -rearFlow.basePressureCoefficient * rearFlow.slantSeparated;
  return ((attached + separated) * rearFlow.slantPlanArea) / frontalArea;
}

export interface YawEffects {
  cdIncrement: number;
  clIncrement: number;
  cs: number;
  cmYaw: number;
}

/**
 * Crosswind sensitivity. Side force and yaw moment grow with the side area;
 * cmYaw > 0 means the nose is pushed downwind (centre of pressure ahead of mid-wheelbase).
 */
export function yawEffects(
  shape: BodyShape,
  metrics: GeometryMetrics,
  cdZeroYaw: number,
  yawDeg: number,
): YawEffects {
  const yaw = yawDeg * DEG_TO_RAD;
  const sinYaw = Math.sin(yaw);
  const sideRatio = metrics.sideArea / metrics.frontalArea;
  const cs = YAW.sideForce * sideRatio * sinYaw * Math.cos(yaw);
  const centreOfPressure = metrics.sideAreaCentroidX - YAW.centreOfPressureLead * metrics.length;
  const midWheelbase = 0.5 * (shape.frontAxleX + shape.rearAxleX);
  return {
    cdIncrement: cdZeroYaw * YAW.dragGain * sideRatio * sinYaw * sinYaw,
    clIncrement: YAW.liftGain * sideRatio * sinYaw * sinYaw,
    cs,
    cmYaw: (cs * (midWheelbase - centreOfPressure)) / shape.params.wheelbase,
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function sumLift(lift: LiftComponent[]): { cl: number; clFront: number; clRear: number } {
  let cl = 0;
  let clFront = 0;
  for (const component of lift) {
    cl += component.value;
    clFront += component.value * component.front;
  }
  return { cl, clFront, clRear: cl - clFront };
}

/** Uncalibrated Mode A coefficients for a geometry in a given onset flow. */
export function analyticalRaw(shape: BodyShape, metrics: GeometryMetrics, flow: FlowState): RawAero {
  const rearFlow = computeRearFlow(shape, metrics.frontalArea);
  const diffuser = diffuserEffect(shape);
  const spoiler = spoilerEffect(shape, metrics, rearFlow.separationFraction);
  const wing = wingEffect(shape, metrics);
  const splitter = splitterEffect(shape, metrics);
  const cdFriction = frictionDrag(metrics, flow);
  const camber = bodyCamberLift(shape);

  const drag: BreakdownItem[] = [
    { id: "forebody", label: "Forebody pressure", value: forebodyDrag(shape) },
    {
      id: "base",
      label: "Base pressure (wake)",
      value: (-rearFlow.basePressureCoefficient * rearFlow.baseArea) / metrics.frontalArea,
    },
    { id: "vortex", label: "Rear-slant trailing vortices", value: rearFlow.vortexDrag },
    { id: "underbody", label: "Underbody", value: underbodyDrag(shape) },
    { id: "wheels", label: "Wheels and wheelhouses", value: wheelDrag(shape, metrics) },
    { id: "friction", label: "Skin friction", value: cdFriction },
    ...detailDragItems(shape, metrics),
    { id: "diffuser", label: "Diffuser (induced)", value: diffuser.cd },
    { id: "spoiler", label: "Rear spoiler", value: spoiler.cd },
    { id: "wing", label: "Rear wing", value: wing.cd },
    { id: "splitter", label: "Front splitter", value: splitter.cd },
  ];

  const lift: LiftComponent[] = [
    { id: "bodyBase", label: "Body (baseline)", value: camber.base, front: DIST.bodyBase },
    { id: "camber", label: "Body camber", value: camber.camber, front: DIST.camber },
    { id: "slant", label: "Rear window", value: slantLift(rearFlow, metrics.frontalArea), front: DIST.slant },
    { id: "underbody", label: "Underbody (ground effect)", value: underbodyLift(shape), front: DIST.underbody },
    { id: "diffuser", label: "Diffuser", value: diffuser.cl, front: DIST.diffuser },
    { id: "spoiler", label: "Rear spoiler", value: spoiler.cl, front: DIST.spoiler },
    { id: "wing", label: "Rear wing", value: wing.cl, front: DIST.wing },
    { id: "splitter", label: "Front splitter", value: splitter.cl, front: DIST.splitter },
  ];

  const cdZeroYaw = drag.reduce((sum, item) => sum + item.value, 0);
  const yaw = yawEffects(shape, metrics, cdZeroYaw, flow.yawDeg);
  drag.push({ id: "yaw", label: "Yaw-induced", value: yaw.cdIncrement });
  lift.push({ id: "yaw", label: "Yaw-induced", value: yaw.clIncrement, front: DIST.yaw });

  const totals = sumLift(lift);
  return {
    cd: cdZeroYaw + yaw.cdIncrement,
    cl: totals.cl,
    clFront: totals.clFront,
    clRear: totals.clRear,
    cs: yaw.cs,
    cmYaw: yaw.cmYaw,
    cdFriction,
    drag,
    lift,
    rearFlow,
  };
}
