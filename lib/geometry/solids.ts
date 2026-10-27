/**
 * Solid model used by the flow solver: the body, wheels, spoiler and skirts,
 * plus the wake displacement body that stands in for the separated region.
 *
 * Every solid is symmetric about Y = 0 and is described, for a given (x, z),
 * as an interval of |y|. That lets the solver integrate face apertures exactly
 * in y, which keeps results smooth as parameters change.
 *
 * backend/geometry/solids.py mirrors this file.
 */
import { MODEL } from "@/lib/physics/model";
import {
  type BodyShape,
  lowerZ,
  planHalfWidth,
  stationHalfWidth,
  mirrorGeometry,
  skirtGeometry,
  spoilerGeometry,
  upperZ,
  wheelGeometry,
} from "@/lib/geometry/profile";
import type { RearFlowDetail } from "@/lib/physics/rearFlow";

const RO = MODEL.reducedOrder;
const R = MODEL.rearFlow;

/** Tabulated profile functions (linear interpolation), so section queries are cheap. */
export interface ProfileTable {
  step: number;
  count: number;
  zLow: Float64Array;
  zUp: Float64Array;
  plan: Float64Array;
}

export function buildProfileTable(shape: BodyShape): ProfileTable {
  const step = RO.tableStep;
  const count = Math.ceil(shape.length / step) + 1;
  const table: ProfileTable = {
    step,
    count,
    zLow: new Float64Array(count),
    zUp: new Float64Array(count),
    plan: new Float64Array(count),
  };
  for (let i = 0; i < count; i++) {
    const x = Math.min(i * step, shape.length);
    table.zLow[i] = lowerZ(shape, x);
    table.zUp[i] = upperZ(shape, x);
    table.plan[i] = planHalfWidth(shape, x);
  }
  return table;
}

interface WakeModel {
  /** First station covered by separated flow (bubble or wake). */
  xStart: number;
  /** Upper separation station of the main wake. */
  xs: number;
  /** Closure station. */
  xc: number;
  /** Absolute heights. */
  zSepTop: number;
  zBaseBottom: number;
  zClosure: number;
  /** Section at the separation station (body frame). */
  sepLow: number;
  sepUp: number;
  sepPlan: number;
  /** Section at the tail (body frame). */
  tailLow: number;
  tailUp: number;
  tailPlan: number;
  hasSpoiler: boolean;
  spoilerTipX: number;
  spoilerTipZ: number;
  spoilerHalfWidth: number;
  /** Separation bubble on the rear window (0 = none). */
  bubble: number;
  xBubbleStart: number;
  zBubbleStart: number;
  /** Slope of the straight dividing streamline from the roof edge to the tail edge. */
  bubbleSlope: number;
  /** Section at the roof trailing edge (body frame). */
  roofLow: number;
  roofUp: number;
  roofPlan: number;
}

export interface SolidModel {
  shape: BodyShape;
  ride: number;
  length: number;
  table: ProfileTable;
  wheels: { x: number; y0: number; y1: number; radius: number }[];
  spoiler: { present: boolean; x0: number; x1: number; xEnd: number; zBottom: number; z0: number; rise: number; top: number; halfWidth: number };
  skirt: { present: boolean; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  /** Door mirror housing (absolute heights): the body is that much wider where it sits. */
  mirror: { present: boolean; x0: number; x1: number; y1: number; z0: number; z1: number };
  wake: WakeModel;
  /** Bounding box of all solids including the wake (|y| <= yMax). */
  xMin: number;
  xMax: number;
  yMax: number;
  zMax: number;
}

/**
 * @param minThickness smallest dimension a thin device may have in the solver
 *   (thin plates narrower than a cell would otherwise be invisible to the grid).
 */
export function buildSolidModel(
  shape: BodyShape,
  rearFlow: RearFlowDetail,
  minThickness: { x: number; y: number },
): SolidModel {
  const { params, length } = shape;
  const ride = params.rideHeight;
  const table = buildProfileTable(shape);

  const wheels = wheelGeometry(shape).map((wheel) => ({
    x: wheel.x,
    y0: wheel.y - wheel.width / 2,
    y1: wheel.y + wheel.width / 2,
    radius: wheel.radius,
  }));

  const blade = spoilerGeometry(shape);
  const spoiler = {
    present: blade.present,
    x0: blade.x0,
    x1: Math.max(blade.x1, blade.x0 + 1e-4),
    xEnd: Math.max(blade.x1, blade.x0 + minThickness.x),
    zBottom: ride + blade.z0 - 0.05,
    z0: ride + blade.z0,
    rise: blade.rise,
    top: ride + blade.z1 + blade.thickness,
    halfWidth: blade.halfWidth,
  };

  const sill = skirtGeometry(shape);
  const skirtThickness = Math.max(sill.thickness, minThickness.y);
  const skirt = {
    present: sill.present,
    x0: sill.x0,
    x1: sill.x1,
    y0: sill.yOuter - skirtThickness,
    y1: sill.yOuter,
    z0: ride - sill.depth,
    z1: ride + 0.03,
  };

  // A mirror is smaller than a coarse cell in two directions; like the other thin parts it is given at
  // least the size the grid can see, so its blockage is not lost.
  const housing = mirrorGeometry(shape);
  const mirror = {
    present: housing.present,
    x0: housing.x0,
    x1: Math.max(housing.x1, housing.x0 + minThickness.x),
    y1: housing.y1,
    z0: ride + housing.z0,
    z1: ride + housing.z1,
  };

  const xs = Math.min(rearFlow.separationX, length);
  const sepUp = upperZ(shape, xs);
  const zSepTop = ride + sepUp;
  const zBaseBottom = ride + shape.diffuserExitHeight;
  const attached = 1 - rearFlow.separationFraction;
  const bubble = rearFlow.bubbleFraction > 0.02 ? rearFlow.bubbleFraction : 0;
  const xBubbleStart = shape.xRoofEnd;
  const roofUp = upperZ(shape, xBubbleStart);
  const wake: WakeModel = {
    xStart: bubble > 0 ? Math.min(xs, xBubbleStart) : xs,
    xs,
    xc: length + Math.max(rearFlow.wakeLength, 0.3),
    zSepTop,
    zBaseBottom,
    zClosure: zBaseBottom + R.wakeClosureHeightFraction * (zSepTop - zBaseBottom),
    sepLow: lowerZ(shape, xs),
    sepUp,
    sepPlan: planHalfWidth(shape, xs),
    tailLow: lowerZ(shape, length),
    tailUp: shape.tailHeight,
    tailPlan: planHalfWidth(shape, length),
    hasSpoiler: blade.present && blade.rise > 1e-4 && attached > 0.05,
    spoilerTipX: spoiler.xEnd,
    spoilerTipZ: ride + shape.tailHeight + attached * blade.rise,
    spoilerHalfWidth: blade.halfWidth,
    bubble,
    xBubbleStart,
    zBubbleStart: ride + roofUp,
    bubbleSlope: (roofUp - shape.tailHeight) / Math.max(length - xBubbleStart, 1e-6),
    roofLow: lowerZ(shape, xBubbleStart),
    roofUp,
    roofPlan: planHalfWidth(shape, xBubbleStart),
  };

  let zMax = ride + params.roofHeight;
  if (spoiler.present) zMax = Math.max(zMax, spoiler.top);
  return {
    shape,
    ride,
    length,
    table,
    wheels,
    spoiler,
    skirt,
    mirror,
    wake,
    xMin: 0,
    xMax: wake.xc,
    yMax: Math.max(0.5 * params.width + (skirt.present ? 0.02 : 0), mirror.present ? mirror.y1 : 0) + 0.06,
    zMax,
  };
}

/** Section of the body at station x from the table. Writes [zLow, zUp, plan] (body frame). */
function tableSection(model: SolidModel, x: number, out: Float64Array): boolean {
  if (x < -EDGE_TOLERANCE || x > model.length + EDGE_TOLERANCE) return false;
  const { table } = model;
  const f = Math.min(Math.max(x, 0), model.length) / table.step;
  const i = Math.min(Math.floor(f), table.count - 2);
  const t = f - i;
  out[0] = table.zLow[i] + (table.zLow[i + 1] - table.zLow[i]) * t;
  out[1] = table.zUp[i] + (table.zUp[i + 1] - table.zUp[i]) * t;
  out[2] = table.plan[i] + (table.plan[i + 1] - table.plan[i]) * t;
  return true;
}

const section = new Float64Array(3);

/** Grid faces are aligned with the floor, roof, nose and tail; tolerate round-off there. */
const EDGE_TOLERANCE = 1e-7;

/** Height of the spoiler solid's upper surface at station x (absolute). */
function spoilerTop(model: SolidModel, x: number): number {
  const { spoiler } = model;
  const t = Math.min((x - spoiler.x0) / (spoiler.x1 - spoiler.x0), 1);
  return spoiler.z0 + spoiler.rise * t + (spoiler.top - spoiler.z0 - spoiler.rise);
}

/**
 * |y| intervals occupied by the real solids at (x, z). Intervals are written
 * to `out` as consecutive [start, end] pairs; returns the number of intervals.
 */
export function bodyIntervals(model: SolidModel, x: number, z: number, out: Float64Array): number {
  let n = 0;
  if (tableSection(model, x, section)) {
    let zb = z - model.ride;
    if (zb < section[0] && zb > section[0] - EDGE_TOLERANCE) zb = section[0];
    else if (zb > section[1] && zb < section[1] + EDGE_TOLERANCE) zb = section[1];
    let w = stationHalfWidth(model.shape, x, section[0], section[1], section[2], zb);
    const { mirror } = model;
    if (mirror.present && w > 0 && x >= mirror.x0 && x <= mirror.x1 && z >= mirror.z0 && z <= mirror.z1) w = Math.max(w, mirror.y1);
    if (w > 0) {
      out[0] = 0;
      out[1] = w;
      n = 1;
    }
  }
  for (const wheel of model.wheels) {
    const dx = x - wheel.x;
    const dz = z - wheel.radius;
    if (dx * dx + dz * dz <= wheel.radius * wheel.radius) {
      out[2 * n] = wheel.y0;
      out[2 * n + 1] = wheel.y1;
      n++;
    }
  }
  const { spoiler, skirt } = model;
  if (spoiler.present && x >= spoiler.x0 && x <= spoiler.xEnd && z >= spoiler.zBottom && z <= spoilerTop(model, x)) {
    out[2 * n] = 0;
    out[2 * n + 1] = spoiler.halfWidth;
    n++;
  }
  if (skirt.present && x >= skirt.x0 && x <= skirt.x1 && z >= skirt.z0 && z <= skirt.z1) {
    out[2 * n] = skirt.y0;
    out[2 * n + 1] = skirt.y1;
    n++;
  }
  return n;
}

/** Upper and lower bounds of the wake displacement body at station x (absolute). */
export function wakeBounds(model: SolidModel, x: number, out: Float64Array): boolean {
  const { wake, length } = model;
  if (x < wake.xStart || x > wake.xc) return false;
  let top = Number.NEGATIVE_INFINITY;
  if (x >= wake.xs) {
    // Main wake: leaves the surface tangentially (horizontal) and closes at zClosure.
    const xi = (x - wake.xs) / (wake.xc - wake.xs);
    top = wake.zSepTop - (wake.zSepTop - wake.zClosure) * xi * xi;
  }
  if (wake.hasSpoiler && x >= wake.spoilerTipX) {
    const xt = (x - wake.spoilerTipX) / (wake.xc - wake.spoilerTipX);
    top = Math.max(top, wake.zClosure + (wake.spoilerTipZ - wake.zClosure) * (1 - xt * xt));
  }
  let bottom: number;
  if (x <= length) {
    // Over the body the separated region sits on top of the upper surface.
    tableSection(model, x, section);
    bottom = model.ride + section[1];
    if (wake.bubble > 0 && x >= wake.xBubbleStart) {
      // Separation bubble: bounded by the straight streamline from the roof edge to the tail edge.
      const line = wake.zBubbleStart - (x - wake.xBubbleStart) * wake.bubbleSlope;
      top = Math.max(top, bottom + wake.bubble * Math.max(line - bottom, 0));
    }
  } else {
    const xl = (x - length) / (wake.xc - length);
    bottom = wake.zBaseBottom + (wake.zClosure - wake.zBaseBottom) * xl * xl;
  }
  if (top <= bottom) return false;
  out[0] = bottom;
  out[1] = top;
  return true;
}

const bounds = new Float64Array(2);

/** Half-width of the wake displacement body at (x, z); 0 outside it. */
export function wakeHalfWidth(model: SolidModel, x: number, z: number): number {
  if (!wakeBounds(model, x, bounds) || z < bounds[0] || z > bounds[1]) return 0;
  const { wake, shape, length, ride } = model;
  const zb = z - ride;
  const params = shape.params;
  // The wake inherits the cross-section of the body where the flow separated.
  let w = stationHalfWidth(shape, wake.xs, wake.sepLow, wake.sepUp, wake.sepPlan, Math.min(zb, wake.sepUp - 1e-6));
  w = Math.max(w, stationHalfWidth(shape, length, wake.tailLow, wake.tailUp, wake.tailPlan, zb));
  if (wake.hasSpoiler && zb >= wake.tailUp - 0.05 && z <= wake.spoilerTipZ + 0.02) {
    w = Math.max(w, wake.spoilerHalfWidth);
  }
  if (wake.bubble > 0 && x <= length) {
    w = Math.max(
      w,
      stationHalfWidth(shape, wake.xBubbleStart, wake.roofLow, wake.roofUp, wake.roofPlan, Math.min(zb, wake.roofUp - 1e-6)),
    );
  }
  if (x > length) {
    const xl = (x - length) / (wake.xc - length);
    w *= 1 - RO.wakeWidthTaper * xl * xl;
  }
  return w;
}

/** Normalised wake coordinates for the synthetic recirculation model. */
export function wakeCoordinates(
  model: SolidModel,
  x: number,
  y: number,
  z: number,
): { xi: number; zeta: number; eta: number; height: number; length: number } | null {
  const halfWidth = wakeHalfWidth(model, x, z);
  if (halfWidth <= 0 || Math.abs(y) > halfWidth) return null;
  wakeBounds(model, x, bounds);
  const { wake } = model;
  return {
    xi: (x - wake.xStart) / (wake.xc - wake.xStart),
    zeta: (z - bounds[0]) / (bounds[1] - bounds[0]),
    eta: Math.abs(y) / halfWidth,
    height: bounds[1] - bounds[0],
    length: wake.xc - wake.xStart,
  };
}

/** Stations in x where a solid starts or ends (used to place integration samples). */
export function xBreakpoints(model: SolidModel, includeWake: boolean): number[] {
  const points = [0, model.length];
  for (const wheel of model.wheels) points.push(wheel.x - wheel.radius, wheel.x + wheel.radius);
  if (model.spoiler.present) points.push(model.spoiler.x0, model.spoiler.xEnd);
  if (model.skirt.present) points.push(model.skirt.x0, model.skirt.x1);
  if (model.mirror.present) points.push(model.mirror.x0, model.mirror.x1);
  if (includeWake) points.push(model.wake.xStart, model.wake.xs, model.wake.xc);
  return points.sort((a, b) => a - b);
}

/**
 * Heights at station x where a solid starts or ends. Written to `out`;
 * returns the count. (Unsorted; callers clip and sort the few values.)
 */
export function zBreakpoints(model: SolidModel, x: number, includeWake: boolean, out: Float64Array): number {
  let n = 0;
  if (tableSection(model, x, section)) {
    out[n++] = model.ride + section[0];
    out[n++] = model.ride + section[1];
  }
  for (const wheel of model.wheels) {
    const dx = x - wheel.x;
    const h2 = wheel.radius * wheel.radius - dx * dx;
    if (h2 > 0) {
      const h = Math.sqrt(h2);
      out[n++] = wheel.radius - h;
      out[n++] = wheel.radius + h;
    }
  }
  const { spoiler, skirt } = model;
  if (spoiler.present && x >= spoiler.x0 && x <= spoiler.xEnd) {
    out[n++] = spoiler.zBottom;
    out[n++] = spoilerTop(model, x);
  }
  if (skirt.present && x >= skirt.x0 && x <= skirt.x1) {
    out[n++] = skirt.z0;
    out[n++] = skirt.z1;
  }
  const { mirror } = model;
  if (mirror.present && x >= mirror.x0 && x <= mirror.x1) {
    out[n++] = mirror.z0;
    out[n++] = mirror.z1;
  }
  if (includeWake && wakeBounds(model, x, bounds)) {
    out[n++] = bounds[0];
    out[n++] = bounds[1];
  }
  return n;
}

/** True when the point lies inside a real solid (not the wake). */
export function insideBody(model: SolidModel, x: number, y: number, z: number, scratch: Float64Array): boolean {
  const n = bodyIntervals(model, x, z, scratch);
  const ay = Math.abs(y);
  for (let i = 0; i < n; i++) {
    if (ay >= scratch[2 * i] && ay <= scratch[2 * i + 1]) return true;
  }
  return false;
}
