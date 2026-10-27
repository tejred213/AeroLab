/**
 * Procedural geometry kernel.
 *
 * The body is described by three analytic functions of the longitudinal
 * coordinate x (0 at the nose, increasing toward the tail = downstream):
 *
 *   upperZ(x)        upper surface height above the body floor plane
 *   lowerZ(x)        underbody height above the body floor plane
 *   planHalfWidth(x) half-width of the body in plan view
 *
 * and a cross-section rule halfWidth(x, z) built from them. The 3D mesh, the
 * frontal-area integration and the flow solver's inside/outside test all use
 * these same functions, so what is drawn is exactly what is simulated.
 *
 * Coordinates: X longitudinal, Y lateral, Z vertical. "Body frame" heights are
 * measured from the floor plane; absolute height = rideHeight + body height.
 *
 * backend/geometry/profile.py mirrors this file; keep the two in step.
 */
import type { GeometryParams } from "@/lib/types";
import { DEG_TO_RAD, MODEL } from "@/lib/physics/model";
import { completeGeometry } from "@/lib/geometry/parameters";

const P = MODEL.profile;

/**
 * The outer envelope of a body measured from an imported 3D model, on a regular
 * grid of stations (x) and rows (z) in the body frame. When a shape carries one,
 * the profile functions below read it instead of the parametric description, so
 * the solver, the frontal area and the wake model all see the measured surface.
 *
 * The envelope is single-valued and symmetric: at each (x, z) the body occupies
 * |y| <= halfWidth. Mirrors, gaps and anything narrower than the sampling are
 * not represented.
 */
export interface SampledBody {
  /** Identifies the measured body in configurations and caches. */
  id: string;
  /** Station spacing along x and row spacing along z, m. */
  dx: number;
  dz: number;
  /** Stations at x = i dx (i < nx) and rows at zb = k dz (k < nz). */
  nx: number;
  nz: number;
  length: number;
  /** Upper and lower surface heights per station, body frame. */
  upper: Float32Array;
  lower: Float32Array;
  /** Largest half-width per station (the plan-view outline). */
  plan: Float32Array;
  /** Half-width at station i, row k: index i * nz + k. Zero outside the section. */
  halfWidth: Float32Array;
}

/** Linear interpolation in a table sampled at unit steps; the position is clamped to the table. */
function tableValue(values: Float32Array, position: number, count: number): number {
  const f = Math.min(Math.max(position, 0), count - 1);
  const i = Math.min(Math.floor(f), count - 2);
  if (i < 0) return values[0];
  const t = f - i;
  return values[i] + (values[i + 1] - values[i]) * t;
}

/**
 * Half-width of a sampled body at (x, zb), bilinear between the surrounding samples.
 *
 * A sample that lies above or below its own station's section says nothing about the width inside the
 * section, so it is left out of the blend: otherwise every sloping surface (a rear window, the hood) would
 * be shaved by half a cell. A station without any width (the nose tip) does take part, so the body closes there.
 */
function sampledHalfWidth(body: SampledBody, x: number, zb: number): number {
  const fx = Math.min(Math.max(x / body.dx, 0), body.nx - 1);
  const fz = zb / body.dz;
  if (fz < 0 || fz > body.nz - 1) return 0;
  const i = Math.min(Math.floor(fx), body.nx - 2);
  const k = Math.min(Math.floor(fz), body.nz - 2);
  const tx = fx - i;
  const tz = fz - k;
  const { halfWidth, nz, dz } = body;
  let sum = 0;
  let weight = 0;
  for (let a = 0; a < 2; a++) {
    const station = i + a;
    const wx = a === 0 ? 1 - tx : tx;
    const closed = body.plan[station] <= 0;
    for (let b = 0; b < 2; b++) {
      const w = wx * (b === 0 ? 1 - tz : tz);
      if (w <= 0) continue;
      const value = halfWidth[station * nz + k + b];
      const z = (k + b) * dz;
      const inSection = z >= body.lower[station] - 0.5 * dz && z <= body.upper[station] + 0.5 * dz;
      if (!closed && !(inSection && value > 0)) continue;
      sum += w * value;
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : 0;
}

/** Knots and derived dimensions of the body, precomputed once per geometry. */
export interface BodyShape {
  params: GeometryParams;
  /** Measured envelope that replaces the parametric profile, for an imported 3D model. */
  sampled?: SampledBody;
  length: number;
  /** Height of the roof edges (roof crown minus crown rise), body frame. */
  roofEdgeHeight: number;
  xCowl: number;
  xRoofStart: number;
  xRoofEnd: number;
  xDeckStart: number;
  deckHeight: number;
  /** Upper-surface height at the tail edge, body frame. */
  tailHeight: number;
  xDiffuserStart: number;
  diffuserExitHeight: number;
  diffuserSlope: number;
  stagnationHeight: number;
  frontAxleX: number;
  rearAxleX: number;
  /** Lateral position of the wheel centres. */
  wheelCentreY: number;
  /** Upper-profile knots (x, z) of the unsmoothed polyline. */
  knotsX: number[];
  knotsZ: number[];
  /** Index of the roof segment within the knot list. */
  roofSegment: number;
}

export function buildBodyShape(geometry: GeometryParams): BodyShape {
  const params = completeGeometry(geometry);
  const length = params.frontOverhang + params.wheelbase + params.rearOverhang;
  const roofEdgeHeight = params.roofHeight - P.roofCrown;
  const deckHeight = params.rearBumperHeight;

  const xCowl = params.hoodLength;
  const windshieldRun =
    Math.max(roofEdgeHeight - params.hoodHeight, 0) / Math.tan(params.windshieldAngle * DEG_TO_RAD);
  const xRoofStart = xCowl + windshieldRun;

  const xDeckStart = length - params.rearDeckLength;
  const rearWindowRun =
    Math.max(roofEdgeHeight - deckHeight, 0) / Math.tan(params.rearWindowAngle * DEG_TO_RAD);
  const xRoofEnd = xDeckStart - rearWindowRun;

  const knotsX = [0, xCowl, xRoofStart, xRoofEnd, xDeckStart];
  const knotsZ = [params.frontBumperHeight, params.hoodHeight, roofEdgeHeight, roofEdgeHeight, deckHeight];
  if (params.rearDeckLength > 1e-6) {
    knotsX.push(length);
    knotsZ.push(deckHeight - P.deckDrop);
  }

  const diffuserLength = Math.min(params.diffuserLength, length * 0.45);
  const diffuserSlope = Math.tan(params.diffuserAngle * DEG_TO_RAD);
  const diffuserExitHeight = Math.min(diffuserLength * diffuserSlope, 0.6 * deckHeight);
  const xDiffuserStart = length - diffuserLength;

  const shape: BodyShape = {
    params,
    length,
    roofEdgeHeight,
    xCowl,
    xRoofStart,
    xRoofEnd,
    xDeckStart,
    deckHeight,
    tailHeight: 0,
    xDiffuserStart,
    diffuserExitHeight,
    diffuserSlope: diffuserLength > 1e-6 ? diffuserExitHeight / diffuserLength : 0,
    stagnationHeight: P.noseStagnationFraction * params.frontBumperHeight,
    frontAxleX: params.frontOverhang,
    rearAxleX: params.frontOverhang + params.wheelbase,
    wheelCentreY: 0,
    knotsX,
    knotsZ,
    roofSegment: 2,
  };
  shape.tailHeight = upperZ(shape, length);
  const axleHalfWidth = Math.min(
    planHalfWidth(shape, shape.frontAxleX),
    planHalfWidth(shape, shape.rearAxleX),
  );
  shape.wheelCentreY =
    axleHalfWidth - params.tireWidth / 2 - P.wheelInset + P.wheelExposureOffset * params.wheelExposure;
  return shape;
}

/**
 * The shape of an imported 3D model: the measured envelope for everything that
 * reads the surface, on top of the parameters fitted to it, which still supply
 * the feature positions (roof ends, deck, diffuser) used by the empirical closures.
 */
export function withSampledBody(shape: BodyShape, body: SampledBody): BodyShape {
  const sampled: BodyShape = { ...shape, sampled: body };
  sampled.tailHeight = upperZ(sampled, sampled.length);
  return sampled;
}

/** Unsmoothed upper polyline with a parabolic roof crown. x is clamped to the body. */
function upperPolyline(shape: BodyShape, x: number): number {
  const { knotsX, knotsZ } = shape;
  const last = knotsX.length - 1;
  if (x <= knotsX[0]) return knotsZ[0];
  if (x >= knotsX[last]) return knotsZ[last];
  for (let i = 0; i < last; i++) {
    const x0 = knotsX[i];
    const x1 = knotsX[i + 1];
    if (x <= x1) {
      const span = x1 - x0;
      if (span <= 1e-9) return knotsZ[i + 1];
      const t = (x - x0) / span;
      let z = knotsZ[i] + (knotsZ[i + 1] - knotsZ[i]) * t;
      if (i === shape.roofSegment) {
        const u = 2 * t - 1;
        z += P.roofCrown * (1 - u * u);
      }
      return z;
    }
  }
  return knotsZ[last];
}

/** Quarter super-ellipse used to round the nose: 0 at t=0, 1 at t=1, vertical tangent at 0. */
function noseBlend(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(1 - Math.pow(1 - t, P.noseExponent), 1 / P.noseExponent);
}

const SMOOTH_OFFSETS = [-1, -0.5, 0, 0.5, 1];
const SMOOTH_WEIGHTS = [1 / 9, 2 / 9, 3 / 9, 2 / 9, 1 / 9];

/** Upper surface height above the floor plane at station x. */
export function upperZ(shape: BodyShape, x: number): number {
  if (shape.sampled) return tableValue(shape.sampled.upper, x / shape.sampled.dx, shape.sampled.nx);
  // Knees of the polyline are rounded with a compact 5-point kernel.
  let z = 0;
  for (let k = 0; k < 5; k++) {
    z += SMOOTH_WEIGHTS[k] * upperPolyline(shape, x + P.smoothRadius * SMOOTH_OFFSETS[k]);
  }
  if (x < P.noseRadiusUpper) {
    const zs = shape.stagnationHeight;
    z = zs + (z - zs) * noseBlend(x / P.noseRadiusUpper);
  }
  return z;
}

/** Underbody height above the floor plane at station x (0 on the flat floor). */
export function lowerZ(shape: BodyShape, x: number): number {
  if (shape.sampled) return tableValue(shape.sampled.lower, x / shape.sampled.dx, shape.sampled.nx);
  if (x < P.noseRadiusLower) {
    return shape.stagnationHeight * (1 - noseBlend(x / P.noseRadiusLower));
  }
  if (x > shape.xDiffuserStart) {
    return (x - shape.xDiffuserStart) * shape.diffuserSlope;
  }
  return 0;
}

/** Half-width of the body in plan view at station x (at beltline level). */
export function planHalfWidth(shape: BodyShape, x: number): number {
  if (shape.sampled) return tableValue(shape.sampled.plan, x / shape.sampled.dx, shape.sampled.nx);
  const { params, length } = shape;
  let factor = 1;
  const frontExtent = P.frontTaperExtent * length;
  if (x < frontExtent) {
    const u = 1 - x / frontExtent;
    factor -= params.frontTaper * u * u;
  }
  const rearStart = P.rearTaperStart * length;
  if (x > rearStart) {
    const u = (x - rearStart) / (length - rearStart);
    factor -= params.rearTaper * u * u;
  }
  if (x < P.planNoseRadius) {
    factor *= P.planNoseBluntness + (1 - P.planNoseBluntness) * noseBlend(x / P.planNoseRadius);
  }
  return 0.5 * params.width * factor;
}

/**
 * Cross-section rule: half-width at height zb (body frame) for a station whose
 * lower / upper surface heights are zl / zu and plan half-width is wb.
 * Returns 0 outside the section.
 */
export function sectionHalfWidth(
  params: GeometryParams,
  zl: number,
  zu: number,
  wb: number,
  zb: number,
): number {
  if (zb < zl || zb > zu) return 0;
  const height = zu - zl;
  let w = wb;
  // Greenhouse: above the beltline the sides lean inward at a constant angle (tumblehome),
  // reaching the cabin width ratio at roof-edge height.
  const greenhouse = params.roofHeight - P.roofCrown - params.beltHeight;
  if (zb > params.beltHeight && greenhouse > 1e-6) {
    const t = Math.min((zb - params.beltHeight) / greenhouse, 1);
    w = wb * (1 - (1 - params.cabinWidthRatio) * t);
  }
  // Rounded lower (sill) and upper (roof / shoulder) edges.
  const rb = Math.min(P.bottomEdgeRadius, 0.45 * height);
  const db = zb - zl;
  if (db < rb) w -= rb - Math.sqrt(Math.max(rb * rb - (rb - db) * (rb - db), 0));
  const rt = Math.min(P.topEdgeRadius, 0.45 * height);
  const dt = zu - zb;
  if (dt < rt) w -= rt - Math.sqrt(Math.max(rt * rt - (rt - dt) * (rt - dt), 0));
  return Math.max(w, 0);
}

/**
 * Half-width at body-frame height zb of the section at station x, given that
 * section's lower / upper heights and plan half-width. Use this, not
 * sectionHalfWidth, wherever the station is known: it also serves measured bodies.
 */
export function stationHalfWidth(shape: BodyShape, x: number, zl: number, zu: number, wb: number, zb: number): number {
  if (!shape.sampled) return sectionHalfWidth(shape.params, zl, zu, wb, zb);
  if (zb < zl || zb > zu) return 0;
  return sampledHalfWidth(shape.sampled, x, zb);
}

/** Half-width of the body at station x and body-frame height zb (0 outside the body). */
export function halfWidth(shape: BodyShape, x: number, zb: number): number {
  if (x < 0 || x > shape.length) return 0;
  return stationHalfWidth(shape, x, lowerZ(shape, x), upperZ(shape, x), planHalfWidth(shape, x), zb);
}

/** Per-station tables so repeated section queries avoid re-evaluating the profile. */
export interface StationTable {
  x: Float64Array;
  zLow: Float64Array;
  zUp: Float64Array;
  plan: Float64Array;
}

export function sampleStations(shape: BodyShape, xs: ArrayLike<number>): StationTable {
  const n = xs.length;
  const table: StationTable = {
    x: new Float64Array(n),
    zLow: new Float64Array(n),
    zUp: new Float64Array(n),
    plan: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    table.x[i] = x;
    if (x < 0 || x > shape.length) {
      // Outside the body: an empty section.
      table.zLow[i] = 1;
      table.zUp[i] = 0;
      table.plan[i] = 0;
    } else {
      table.zLow[i] = lowerZ(shape, x);
      table.zUp[i] = upperZ(shape, x);
      table.plan[i] = planHalfWidth(shape, x);
    }
  }
  return table;
}

// ---------------------------------------------------------------------------
// Aero devices and wheels. All heights are in the body frame unless noted.
// ---------------------------------------------------------------------------

export interface SpoilerGeometry {
  present: boolean;
  /** Hinge point at the tail edge. */
  x0: number;
  z0: number;
  /** Blade tip. */
  x1: number;
  z1: number;
  halfWidth: number;
  /** Vertical rise of the blade above the tail edge. */
  rise: number;
  thickness: number;
}

export function spoilerGeometry(shape: BodyShape): SpoilerGeometry {
  const { params, length } = shape;
  const blade = params.spoilerHeight;
  const angle = params.spoilerAngle * DEG_TO_RAD;
  const tailHalfWidth = planHalfWidth(shape, length);
  const x0 = length - 0.02;
  const z0 = shape.tailHeight;
  return {
    present: blade > 1e-4,
    x0,
    z0,
    x1: x0 + blade * Math.cos(angle),
    z1: z0 + blade * Math.sin(angle),
    halfWidth: Math.min(params.spoilerWidth / 2, tailHalfWidth),
    rise: blade * Math.sin(angle),
    thickness: P.spoilerThickness,
  };
}

export interface WingGeometry {
  present: boolean;
  /** Centre of the wing section. */
  xc: number;
  zc: number;
  chord: number;
  span: number;
  thickness: number;
  angleDeg: number;
}

export function wingGeometry(shape: BodyShape): WingGeometry {
  const { params, length } = shape;
  const chord = params.wingChord;
  return {
    present: chord > 1e-4,
    xc: length - 0.05 - chord / 2,
    zc: shape.tailHeight + P.wingMountHeight,
    chord,
    span: 2 * planHalfWidth(shape, length) * P.wingSpanRatio,
    thickness: chord * P.wingThicknessRatio,
    angleDeg: params.wingAngle,
  };
}

export interface SplitterGeometry {
  present: boolean;
  /** Leading edge (negative: ahead of the nose). */
  x0: number;
  x1: number;
  halfWidth: number;
  thickness: number;
}

export function splitterGeometry(shape: BodyShape): SplitterGeometry {
  const { params } = shape;
  return {
    present: params.splitterExtension > 1e-4,
    x0: -params.splitterExtension,
    x1: P.noseRadiusLower + 0.1,
    halfWidth: MODEL.lift.splitterWidthFactor * 0.5 * params.width * (1 - params.frontTaper),
    thickness: P.splitterThickness,
  };
}

export interface SkirtGeometry {
  present: boolean;
  x0: number;
  x1: number;
  /** Outer face lateral position. */
  yOuter: number;
  thickness: number;
  depth: number;
}

export function skirtGeometry(shape: BodyShape): SkirtGeometry {
  const { params } = shape;
  const radius = params.wheelDiameter / 2;
  const x0 = shape.frontAxleX + radius + 0.06;
  const x1 = shape.rearAxleX - radius - 0.06;
  return {
    present: params.sideSkirtDepth > 1e-4 && x1 > x0,
    x0,
    x1,
    yOuter: planHalfWidth(shape, 0.5 * (x0 + x1)) - 0.01,
    thickness: P.skirtThickness,
    depth: params.sideSkirtDepth,
  };
}

export interface MirrorGeometry {
  present: boolean;
  /** Extent of the housing along the car and in height (body frame). */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Lateral extent on the +Y side: from just inside the body side to the outer edge. */
  y0: number;
  y1: number;
  /** Frontal area of one mirror outside the body, m². */
  area: number;
}

/**
 * Door mirrors, as the box each housing fills: at the base of the A-pillar, just above the beltline. The
 * drawing, the frontal area and the flow solver all use this one description.
 */
export function mirrorGeometry(shape: BodyShape): MirrorGeometry {
  const { params } = shape;
  const width = params.mirrorWidth;
  const height = P.mirrorAspect * width;
  const x0 = shape.xCowl + P.mirrorBehindCowl;
  const x1 = x0 + P.mirrorDepthRatio * width;
  const side = planHalfWidth(shape, 0.5 * (x0 + x1));
  const z0 = params.beltHeight + P.mirrorAboveBelt;
  return {
    present: width > 0.01 && x1 < shape.length,
    x0,
    x1,
    z0,
    z1: z0 + height,
    y0: side - 0.02,
    y1: side + width,
    area: width * height,
  };
}

export interface WheelGeometry {
  /** Wheel centre, absolute coordinates (y is the +Y side; mirror for the other). */
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
}

export function wheelGeometry(shape: BodyShape): WheelGeometry[] {
  const { params } = shape;
  const radius = params.wheelDiameter / 2;
  return [shape.frontAxleX, shape.rearAxleX].map((x) => ({
    x,
    y: shape.wheelCentreY,
    z: radius,
    radius,
    width: params.tireWidth,
  }));
}
