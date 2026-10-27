/**
 * Measuring an imported 3D model of a car.
 *
 * Input is a triangle soup (9 numbers per triangle). Nothing is assumed about
 * the mesh being closed: artist-made models have gaps, interiors and open
 * underbodies. The surface is therefore sampled with points and only its outer
 * envelope is kept:
 *
 *   halfWidth(x, z)   the largest |y| of any surface point in that (x, z) cell
 *
 * from which the upper profile, the sill line, the wheels and a frontal
 * silhouette follow. Mirrors, antennas and other features shorter than the
 * opening window are removed; the solver cannot resolve them anyway.
 *
 * Pure functions on typed arrays: no three.js, so they run in tests and workers.
 */
import { clampParam, PARAM_DEFINITIONS } from "@/lib/geometry/parameters";
import type { SampledBody } from "@/lib/geometry/profile";
import { DEG_TO_RAD, MODEL, RAD_TO_DEG } from "@/lib/physics/model";
import type { GeometryParams, ParamBasis, ParamId } from "@/lib/types";

const P = MODEL.profile;

/** How the axes of a model file map onto the tunnel's (X downstream, Y lateral, Z up). */
export interface Orientation {
  /** Index (0, 1, 2) of the model axis that points up, and of the one that runs along the car. */
  upAxis: number;
  lengthAxis: number;
  /** True when the model's nose is at the high end of its length axis. */
  reverse: boolean;
}

export interface OrientedMesh {
  /** Triangle soup in tunnel coordinates: nose at x = 0, centred on y = 0, lowest point at z = 0. */
  positions: Float32Array;
  /** Row-major 4 x 4 matrix taking model coordinates to tunnel coordinates (a rotation, uniform scale and shift). */
  matrix: number[];
  scale: number;
  length: number;
  width: number;
  height: number;
}

export function bounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const value = positions[i + c];
      if (value < min[c]) min[c] = value;
      if (value > max[c]) max[c] = value;
    }
  }
  return { min, max };
}

/**
 * Rotates, scales and shifts a model into tunnel coordinates.
 * @param targetLength overall length to scale the model to, m; omit to keep the file's units.
 */
export function orientMesh(positions: Float32Array, orientation: Orientation, targetLength?: number): OrientedMesh {
  const { upAxis, lengthAxis, reverse } = orientation;
  if (upAxis === lengthAxis || upAxis < 0 || upAxis > 2 || lengthAxis < 0 || lengthAxis > 2) {
    throw new Error("The up axis and the length axis must be two different axes.");
  }
  const lateralAxis = 3 - upAxis - lengthAxis;
  const { min, max } = bounds(positions);
  const extent = max[lengthAxis] - min[lengthAxis];
  if (!(extent > 0)) throw new Error("The model has no extent along its length axis.");
  const scale = targetLength ? targetLength / extent : 1;

  // x runs from the nose to the tail. The sign of y is chosen so that the map is a rotation, not a mirror image.
  const sx = reverse ? -1 : 1;
  const basis = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  basis[0][lengthAxis] = sx;
  basis[2][upAxis] = 1;
  const sy = signOfPermutation(lengthAxis, lateralAxis, upAxis) * sx > 0 ? 1 : -1;
  basis[1][lateralAxis] = sy;

  const x0 = reverse ? -max[lengthAxis] : min[lengthAxis];
  const yMid = sy * 0.5 * (min[lateralAxis] + max[lateralAxis]);
  const z0 = min[upAxis];
  const shift = [-x0 * scale, -yMid * scale, -z0 * scale];

  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    out[i] = sx * positions[i + lengthAxis] * scale + shift[0];
    out[i + 1] = sy * positions[i + lateralAxis] * scale + shift[1];
    out[i + 2] = positions[i + upAxis] * scale + shift[2];
  }
  const matrix: number[] = [];
  for (let r = 0; r < 3; r++) matrix.push(basis[r][0] * scale, basis[r][1] * scale, basis[r][2] * scale, shift[r]);
  matrix.push(0, 0, 0, 1);
  return {
    positions: out,
    matrix,
    scale,
    length: extent * scale,
    width: (max[lateralAxis] - min[lateralAxis]) * scale,
    height: (max[upAxis] - min[upAxis]) * scale,
  };
}

/**
 * The matrix orientMesh would apply, from the model's bounding box alone (for previews: no vertex is touched).
 * Exact for the bounding box of the same triangles.
 */
export function orientationMatrix(
  box: { min: number[]; max: number[] },
  orientation: Orientation,
  targetLength?: number,
): { matrix: number[]; scale: number; length: number; width: number; height: number } {
  const corners = new Float32Array([...box.min, ...box.max, ...box.min]);
  const { matrix, scale, length, width, height } = orientMesh(corners, orientation, targetLength);
  return { matrix, scale, length, width, height };
}

/** +1 when (a, b, c) is an even permutation of (0, 1, 2), -1 when odd. */
function signOfPermutation(a: number, b: number, c: number): number {
  return (b - a) * (c - a) * (c - b) > 0 ? 1 : -1;
}

/**
 * A first guess at the orientation: glTF files are Y-up by convention; otherwise
 * the shortest extent is taken as up. The longest remaining extent is the length,
 * and the nose is taken to be the end with the lower bodywork (the hood).
 */
export function guessOrientation(positions: Float32Array, yUp: boolean): Orientation {
  const { min, max } = bounds(positions);
  const extent = [0, 1, 2].map((c) => max[c] - min[c]);
  const upAxis = yUp ? 1 : extent.indexOf(Math.min(...extent));
  const others = [0, 1, 2].filter((c) => c !== upAxis);
  const lengthAxis = extent[others[0]] >= extent[others[1]] ? others[0] : others[1];

  // Highest point in the first and in the last fifth of the length, away from the very ends.
  let low = -Infinity;
  let high = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const t = (positions[i + lengthAxis] - min[lengthAxis]) / extent[lengthAxis];
    const z = positions[i + upAxis];
    if (t > 0.08 && t < 0.22 && z > low) low = z;
    if (t > 0.78 && t < 0.92 && z > high) high = z;
  }
  return { upAxis, lengthAxis, reverse: high < low };
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

export interface MeasuredWheels {
  frontAxleX: number;
  rearAxleX: number;
  diameter: number;
  tireWidth: number;
  /** Lateral position of the tyre centre. */
  centreY: number;
}

export interface MeasuredModel {
  body: SampledBody;
  /** Length at the tail over which a rounded rear end was replaced by a constant section (a blunt base), m. */
  tailSquared: number;
  /** Depth of a rear-mounted attachment (spare wheel, carrier) that was left out of the body, m; 0 without one. */
  rearAttachment: number;
  /** Length of everything in the model, attachments included, m. */
  overallLength: number;
  /** Height of the sill line (the body floor plane) above the ground, m. */
  rideHeight: number;
  /** Length of the body the solver uses (without a rear attachment), m. */
  length: number;
  /** Width of the envelope, mirrors excluded. */
  width: number;
  height: number;
  /** null when no tyre contact patches were found on the ground. */
  wheels: MeasuredWheels | null;
  /** Frontal silhouette of everything in the model, mirrors and wheels included, m². */
  silhouetteArea: number;
  triangles: number;
  resolution: number;
}

/** Features shorter than this along the car are treated as attachments (mirrors, antennas) and removed, m. */
const OPENING_WINDOW = 0.3;
/**
 * A tail counts as rounded where its plan width or its height falls below these fractions of the section
 * BASE_LOOKBACK ahead of it.
 */
const BASE_LOOKBACK = 0.3;
/** A rear attachment is at least this deep (a rounded bumper is not) and at most this deep (a pickup bed is not), m. */
const ATTACHMENT_MIN = 0.12;
const ATTACHMENT_MAX = 0.5;
/** ... and less than this fraction of the body's width, or of its height (rounded rear corners keep more). */
const ATTACHMENT_WIDTH = 0.5;
const ATTACHMENT_HEIGHT = 0.5;
const BASE_WIDTH_FRACTION = 0.9;
const BASE_HEIGHT_FRACTION = 0.6;
/** Surface points this close to the ground belong to tyre contact patches, m. */
const CONTACT_BAND = 0.03;

function slidingExtreme(values: Float32Array, radius: number, useMax: boolean): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let best = values[i];
    for (let k = Math.max(i - radius, 0); k <= Math.min(i + radius, n - 1); k++) {
      if (useMax ? values[k] > best : values[k] < best) best = values[k];
    }
    out[i] = best;
  }
  return out;
}

/**
 * Removes peaks narrower than the window (opening), or fills dips narrower than it (closing).
 * @param outside value of the quantity beyond both ends of the array. With null the window is simply clipped
 *   to the array, which leaves a profile that runs monotonically into an end unchanged.
 */
function morphology(values: Float32Array, radius: number, opening: boolean, outside: number | null = null): Float32Array {
  if (outside === null) return slidingExtreme(slidingExtreme(values, radius, !opening), radius, opening);
  // Work on a copy padded with the outside value, so that both passes see it, then cut the padding off again.
  const padded = new Float32Array(values.length + 2 * radius).fill(outside);
  padded.set(values, radius);
  const result = slidingExtreme(slidingExtreme(padded, radius, !opening), radius, opening);
  return result.slice(radius, radius + values.length);
}

function smooth(values: Float32Array, radius: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(i - radius, 0); k <= Math.min(i + radius, n - 1); k++) {
      sum += values[k];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Measures a model that is already in tunnel coordinates (see orientMesh).
 * @param resolution spacing of the stations and rows of the envelope, m.
 */
export function measureModel(positions: Float32Array, id: string, resolution = 0.02): MeasuredModel {
  const h = resolution;
  const triangles = Math.floor(positions.length / 9);
  if (triangles === 0) throw new Error("The model contains no triangles.");
  const { min, max } = bounds(positions);
  const length = max[0];
  const height = max[2];
  const yExtent = Math.max(Math.abs(min[1]), Math.abs(max[1]));
  if (!(length > 0.5 && height > 0.2 && yExtent > 0.2)) throw new Error("The model is too small to be a car; check its scale and orientation.");

  // Stations at i h; the last one lies at or just inside the tail, so no station is left without surface.
  const nx = Math.floor(length / h + 1e-3) + 1;
  const rows = Math.ceil(height / h) + 1;
  const ny = Math.ceil((2 * yExtent) / h) + 2;
  /**
   * Largest |y| in each (slab, row) cell, absolute heights. Slab j covers x in [j h, (j + 1) h); a last slab
   * thinner than half a step is merged into the one before it.
   */
  const lastSlab = length - (nx - 1) * h < 0.5 * h ? Math.max(nx - 2, 0) : nx - 1;
  const slabs = lastSlab + 1;
  const slabWidth = new Float32Array(slabs * rows);
  /** Highest and lowest surface point in each cell, so the profiles are not quantised to the row height. */
  const slabTop = new Float32Array(slabs * rows).fill(-Infinity);
  const slabBottom = new Float32Array(slabs * rows).fill(Infinity);
  const silhouette = new Uint8Array(ny * rows);
  /** Tyre contact: extent of |y| and of x among the points near the ground, per station. */
  const contactInner = new Float32Array(nx).fill(Infinity);
  const contactOuter = new Float32Array(nx).fill(-Infinity);

  const mark = (x: number, y: number, z: number) => {
    const i = Math.min(Math.max(Math.round(x / h), 0), nx - 1);
    const s = Math.min(Math.max(Math.floor(x / h), 0), lastSlab);
    const k = Math.min(Math.max(Math.floor(z / h), 0), rows - 1);
    const ay = Math.abs(y);
    const c = s * rows + k;
    if (ay > slabWidth[c]) slabWidth[c] = ay;
    if (z > slabTop[c]) slabTop[c] = z;
    if (z < slabBottom[c]) slabBottom[c] = z;
    const j = Math.min(Math.max(Math.floor((y + yExtent) / h), 0), ny - 1);
    silhouette[j * rows + k] = 1;
    if (z < CONTACT_BAND && ay > 0.3 * yExtent) {
      if (ay < contactInner[i]) contactInner[i] = ay;
      if (ay > contactOuter[i]) contactOuter[i] = ay;
    }
  };

  // Sample every triangle on a barycentric lattice finer than half a cell.
  const spacing = 0.5 * h;
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const ux = positions[o + 3] - ax, uy = positions[o + 4] - ay, uz = positions[o + 5] - az;
    const vx = positions[o + 6] - ax, vy = positions[o + 7] - ay, vz = positions[o + 8] - az;
    const edge = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz));
    if (!Number.isFinite(edge)) continue;
    const n = Math.min(Math.max(Math.ceil(edge / spacing), 1), 2000);
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const a = i / n;
        const b = j / n;
        mark(ax + ux * a + vx * b, ay + uy * a + vy * b, az + uz * a + vz * b);
      }
    }
  }

  let filled = 0;
  for (let c = 0; c < silhouette.length; c++) filled += silhouette[c];
  const silhouetteArea = filled * h * h;

  // Envelope at the stations. The largest width within a slab is the width at its wider end, so the smaller of
  // the two slabs that meet at a station is the width at the station itself, without the half-step dilation
  // that taking one maximum per station would add (it turns a rounded nose into a flat face). Station 0 gets
  // zero width: the nose closes in plan over the first step. The last station repeats the one before it.
  const envelope = new Float32Array(nx * rows);
  const cellTop = new Float32Array(nx * rows).fill(-Infinity);
  const cellBottom = new Float32Array(nx * rows).fill(Infinity);
  for (let i = 1; i < nx; i++) {
    const before = Math.min(i - 1, lastSlab) * rows;
    const after = Math.min(i, lastSlab) * rows;
    const source = i === nx - 1 ? Math.min(nx - 2, lastSlab) * rows : -1;
    for (let k = 0; k < rows; k++) {
      const c = i * rows + k;
      if (source >= 0 && nx > 2) {
        const previous = (i - 1) * rows + k;
        envelope[c] = envelope[previous];
        cellTop[c] = cellTop[previous];
        cellBottom[c] = cellBottom[previous];
        continue;
      }
      envelope[c] = Math.min(slabWidth[before + k], slabWidth[after + k]);
      if (envelope[c] > 0) {
        cellTop[c] = Math.min(slabTop[before + k], slabTop[after + k]);
        cellBottom[c] = Math.max(slabBottom[before + k], slabBottom[after + k]);
      }
    }
  }

  // Envelope per row: drop short protrusions (mirrors), then fill short dips (open windows, panel gaps).
  const radius = Math.max(Math.round((0.5 * OPENING_WINDOW) / h), 1);
  const row = new Float32Array(nx);
  for (let k = 0; k < rows; k++) {
    for (let i = 0; i < nx; i++) row[i] = envelope[i * rows + k];
    // Beyond the nose and the tail there is no body: without that, closing would stretch a row to the end of the car.
    const cleaned = morphology(morphology(row, radius, true, 0), radius, false, 0);
    for (let i = 0; i < nx; i++) envelope[i * rows + k] = cleaned[i];
  }

  let halfWidthMax = 0;
  const planAbsolute = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    for (let k = 0; k < rows; k++) if (envelope[i * rows + k] > planAbsolute[i]) planAbsolute[i] = envelope[i * rows + k];
    if (planAbsolute[i] > halfWidthMax) halfWidthMax = planAbsolute[i];
  }

  // Upper profile: the highest row the body reaches, with roof attachments removed.
  let upperAbsolute: Float32Array = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    for (let k = rows - 1; k >= 0; k--) {
      if (envelope[i * rows + k] > 0.05) {
        // A cell filled in by the closing pass holds no surface point of its own: use its mid-height.
        const top = cellTop[i * rows + k];
        upperAbsolute[i] = Number.isFinite(top) ? top : (k + 0.5) * h;
        break;
      }
    }
  }
  // Station 0 has no width, hence no height of its own; without this the opening would erode the nose.
  if (nx > 1) upperAbsolute[0] = upperAbsolute[1];
  upperAbsolute = smooth(morphology(upperAbsolute, radius, true), 1);

  // Wheels: runs of stations with tyre contact on the ground.
  const wheels = findWheels(positions, contactInner, contactOuter, h, nx, yExtent);

  // Sill line: the lowest row at which the section is nearly as wide as the body, between and beyond the wheels.
  const lowerRaw = new Float32Array(nx);
  const valid = new Uint8Array(nx);
  for (let i = 0; i < nx; i++) {
    const x = i * h;
    const inWheelZone =
      wheels !== null &&
      (Math.abs(x - wheels.frontAxleX) < 0.5 * wheels.diameter + 0.06 || Math.abs(x - wheels.rearAxleX) < 0.5 * wheels.diameter + 0.06);
    if (inWheelZone || planAbsolute[i] <= 0) continue;
    for (let k = 0; k < rows; k++) {
      if (envelope[i * rows + k] >= 0.7 * planAbsolute[i]) {
        const bottom = cellBottom[i * rows + k];
        lowerRaw[i] = Number.isFinite(bottom) ? bottom : (k + 0.5) * h;
        valid[i] = 1;
        break;
      }
    }
  }
  let lowerAbsolute: Float32Array = interpolateGaps(lowerRaw, valid);
  lowerAbsolute = smooth(lowerAbsolute, 2);

  // The floor plane is the sill between the axles (or over the middle of the car when no wheels were found).
  const from = Math.round((wheels ? wheels.frontAxleX + 0.5 * wheels.diameter + 0.1 : 0.35 * length) / h);
  const to = Math.round((wheels ? wheels.rearAxleX - 0.5 * wheels.diameter - 0.1 : 0.65 * length) / h);
  const middle = Array.from(lowerAbsolute.slice(Math.min(from, to), Math.max(from, to) + 1)).sort((a, b) => a - b);
  const rideHeight = middle.length > 0 ? middle[Math.floor(middle.length / 2)] : Math.min(...lowerAbsolute);

  // Body frame: heights above the floor plane.
  const nz = Math.ceil((height - rideHeight) / h) + 2;
  const upper = new Float32Array(nx);
  const lower = new Float32Array(nx);
  const halfWidth = new Float32Array(nx * nz);
  const plan = new Float32Array(nx);
  // The nose station has no width of its own; it takes the heights of the next station.
  if (nx > 1) {
    upperAbsolute[0] = upperAbsolute[1];
    lowerAbsolute[0] = lowerAbsolute[1];
  }
  for (let i = 0; i < nx; i++) {
    upper[i] = Math.max(upperAbsolute[i] - rideHeight, 0);
    lower[i] = Math.min(Math.max(lowerAbsolute[i] - rideHeight, 0), upper[i]);
    for (let k = 0; k < nz; k++) {
      const zb = k * h;
      if (zb < lower[i] - 0.5 * h || zb > upper[i] + 0.5 * h) continue;
      // Rows are cells centred at (r + 0.5) h; read the one containing this height.
      const r = Math.min(Math.max(Math.floor((rideHeight + zb) / h), 0), rows - 1);
      const w = envelope[i * rows + r];
      halfWidth[i * nz + k] = w;
      if (w > plan[i]) plan[i] = w;
    }
  }

  // A rear-mounted spare wheel, carrier or tow bar: a terminal stretch that is much narrower or lower than the
  // body ahead of it and at most half a metre deep. It sits in the wake and is not part of the body the
  // aerodynamic models describe (published lengths leave a spare wheel out too), so the envelope ends where
  // the body does. A rounded tail is narrow only over its last few centimetres and is handled below.
  let n = nx;
  const refFrom = Math.max(nx - 1 - Math.round(1.0 / h), 0);
  const refTo = Math.max(nx - 1 - Math.round(ATTACHMENT_MAX / h), 0);
  let planRef = 0;
  let heightRef = 0;
  for (let i = refFrom; i <= refTo; i++) {
    planRef = Math.max(planRef, plan[i]);
    heightRef = Math.max(heightRef, upper[i] - lower[i]);
  }
  let bodyEnd = nx - 1;
  while (bodyEnd > refTo && (plan[bodyEnd] < ATTACHMENT_WIDTH * planRef || upper[bodyEnd] - lower[bodyEnd] < ATTACHMENT_HEIGHT * heightRef)) bodyEnd--;
  const attachment = (nx - 1 - bodyEnd) * h;
  if (bodyEnd > refTo && attachment >= ATTACHMENT_MIN) n = bodyEnd + 1;
  const bodyLength = n === nx ? length : (n - 1) * h;

  // A rounded tail. The aerodynamic models treat the rear end as a blunt base that the wake starts from, so
  // the section is held constant from the station where the body closes in plan view or in side view. A rear
  // window that slopes all the way to the tail keeps its width and most of its height, and is left alone.
  const ahead = Math.max(n - 1 - Math.round(BASE_LOOKBACK / h), 0);
  let base = n - 1;
  while (
    base > ahead &&
    (plan[base] < BASE_WIDTH_FRACTION * plan[ahead] ||
      upper[base] - lower[base] < BASE_HEIGHT_FRACTION * (upper[ahead] - lower[ahead]))
  ) {
    base--;
  }
  for (let i = base + 1; i < n; i++) {
    upper[i] = upper[base];
    lower[i] = lower[base];
    plan[i] = plan[base];
    for (let k = 0; k < nz; k++) halfWidth[i * nz + k] = halfWidth[base * nz + k];
  }

  return {
    body: {
      id,
      dx: h,
      dz: h,
      nx: n,
      nz,
      length: bodyLength,
      upper: upper.slice(0, n),
      lower: lower.slice(0, n),
      plan: plan.slice(0, n),
      halfWidth: halfWidth.slice(0, n * nz),
    },
    tailSquared: (n - 1 - base) * h,
    rearAttachment: n === nx ? 0 : length - bodyLength,
    overallLength: length,
    rideHeight,
    length: bodyLength,
    width: 2 * halfWidthMax,
    height,
    wheels,
    silhouetteArea,
    triangles,
    resolution: h,
  };
}

/** Size at which a model is first measured when it is to be scaled by its wheelbase, m. */
const PROVISIONAL_LENGTH = 4.5;

/** Thrown when a model is to be scaled by its wheelbase but has no wheels standing on the ground. */
export class NoWheelsError extends Error {
  constructor() {
    super(
      "No tyre contact patches were found on the ground, so the model cannot be scaled by its wheelbase. Scale it by its overall length instead.",
    );
    this.name = "NoWheelsError";
  }
}

/**
 * Orients a model, brings it to real size and measures it.
 *
 * The size comes from a known wheelbase when one is given: it is the one published dimension that bumpers,
 * a rear-mounted spare wheel or a tow bar cannot change. The model is measured once at a provisional size
 * to find its axles and then again at the real one. Otherwise the overall length is used, or the file's units.
 */
export function measureAtScale(
  positions: Float32Array,
  orientation: Orientation,
  size: { targetLength?: number; targetWheelbase?: number },
  id: string,
): { oriented: OrientedMesh; measured: MeasuredModel } {
  let oriented = orientMesh(positions, orientation, size.targetWheelbase ? PROVISIONAL_LENGTH : size.targetLength);
  let measured = measureModel(oriented.positions, id);
  if (size.targetWheelbase) {
    if (!measured.wheels) throw new NoWheelsError();
    const wheelbase = measured.wheels.rearAxleX - measured.wheels.frontAxleX;
    oriented = orientMesh(positions, orientation, (oriented.length * size.targetWheelbase) / wheelbase);
    measured = measureModel(oriented.positions, id);
  }
  return { oriented, measured };
}

/** Linear interpolation across stations that have no valid value; the ends repeat the nearest valid value. */
function interpolateGaps(values: Float32Array, valid: Uint8Array): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  let previous = -1;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    out[i] = values[i];
    if (previous < 0) {
      for (let k = 0; k < i; k++) out[k] = values[i];
    } else {
      for (let k = previous + 1; k < i; k++) {
        const t = (k - previous) / (i - previous);
        out[k] = values[previous] + (values[i] - values[previous]) * t;
      }
    }
    previous = i;
  }
  if (previous >= 0) for (let k = previous + 1; k < n; k++) out[k] = values[previous];
  return out;
}

function findWheels(
  positions: Float32Array,
  contactInner: Float32Array,
  contactOuter: Float32Array,
  h: number,
  nx: number,
  yExtent: number,
): MeasuredWheels | null {
  // Runs of stations with contact points, merged across gaps of a few cells (tread grooves).
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < nx; i++) {
    if (!(contactOuter[i] > 0)) continue;
    const last = runs[runs.length - 1];
    if (last && i - last.end <= 4) last.end = i;
    else runs.push({ start: i, end: i });
  }
  const patches = runs.filter((run) => (run.end - run.start + 1) * h >= 0.06).sort((a, b) => b.end - b.start - (a.end - a.start));
  if (patches.length < 2) return null;
  const [first, second] = patches.slice(0, 2).sort((a, b) => a.start - b.start);
  const axle = (run: { start: number; end: number }) => 0.5 * (run.start + run.end) * h;
  const frontAxleX = axle(first);
  const rearAxleX = axle(second);
  if (rearAxleX - frontAxleX < 1.2) return null;

  let inner = Infinity;
  let outer = -Infinity;
  for (const run of [first, second]) {
    for (let i = run.start; i <= run.end; i++) {
      if (contactInner[i] < inner) inner = contactInner[i];
      if (contactOuter[i] > outer) outer = contactOuter[i];
    }
  }

  // Diameter: a tyre standing on the ground is a circle through the contact point, so a tread point at distance
  // dx from the axle and height z gives D = (dx² + z²) / z. Points on the sidewalls lie inside that circle and
  // give less, so the upper end of the estimates is the tread. Ahead of and behind the axle are averaged, which
  // cancels a small error in the axle position.
  const estimates: number[] = [];
  for (const centre of [frontAxleX, rearAxleX]) {
    const ahead: number[] = [];
    const behind: number[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const z = positions[i + 2];
      if (z < 0.03 || z > 0.1) continue;
      const ay = Math.abs(positions[i + 1]);
      if (ay < inner - 0.01 || ay > outer + 0.01) continue;
      const dx = positions[i] - centre;
      if (Math.abs(dx) < 0.05 || Math.abs(dx) > 0.42) continue;
      (dx < 0 ? ahead : behind).push((dx * dx + z * z) / z);
    }
    if (ahead.length < 4 || behind.length < 4) continue;
    const upperEnd = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(0.9 * (values.length - 1))];
    estimates.push(0.5 * (upperEnd(ahead) + upperEnd(behind)));
  }
  if (estimates.length === 0) return null;
  const diameter = estimates.reduce((sum, value) => sum + value, 0) / estimates.length;
  if (!(diameter > 0.4 && diameter < 1.1) || !(outer > inner) || outer > yExtent + 1e-6) return null;
  return { frontAxleX, rearAxleX, diameter, tireWidth: outer - inner, centreY: 0.5 * (inner + outer) };
}

// ---------------------------------------------------------------------------
// Fitting the simulator's parameters to a measured model
// ---------------------------------------------------------------------------

/**
 * Parameters that describe the surface a measured body replaces. While they keep
 * their fitted values the solver uses the measured envelope; editing one of them
 * means the user wants a different shape, and the parametric body takes over.
 */
export const SHAPE_PARAMS: ParamId[] = [
  "wheelbase", "frontOverhang", "rearOverhang", "width", "roofHeight", "beltHeight", "hoodLength", "hoodHeight",
  "frontBumperHeight", "rearBumperHeight", "windshieldAngle", "rearWindowAngle", "rearDeckLength", "frontTaper",
  "rearTaper", "cabinWidthRatio", "diffuserAngle", "diffuserLength",
];

/** Best two-segment straight-line fit to (xs, zs): returns the breakpoint index and both segments' end heights. */
function twoSegmentFit(xs: number[], zs: number[]): { split: number; slopeA: number; slopeB: number; zSplit: number; error: number } {
  const n = xs.length;
  let best = { split: Math.floor(n / 2), slopeA: 0, slopeB: 0, zSplit: zs[Math.floor(n / 2)], error: Infinity };
  // Continuous piecewise-linear fit through (x0, z0), (xb, zb), (x1, z1); zb is solved by least squares for each split.
  const x0 = xs[0];
  const x1 = xs[n - 1];
  for (let s = 2; s < n - 2; s++) {
    const xb = xs[s];
    // Unknowns: the heights at the three knots. Solve the 3 x 3 normal equations.
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const rhs = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const w = [0, 0, 0];
      if (xs[i] <= xb) {
        const t = (xs[i] - x0) / (xb - x0);
        w[0] = 1 - t;
        w[1] = t;
      } else {
        const t = (xs[i] - xb) / (x1 - xb);
        w[1] = 1 - t;
        w[2] = t;
      }
      for (let r = 0; r < 3; r++) {
        rhs[r] += w[r] * zs[i];
        for (let c = 0; c < 3; c++) A[r * 3 + c] += w[r] * w[c];
      }
    }
    const knots = solve3(A, rhs);
    if (!knots) continue;
    let error = 0;
    for (let i = 0; i < n; i++) {
      const fit =
        xs[i] <= xb
          ? knots[0] + ((knots[1] - knots[0]) * (xs[i] - x0)) / (xb - x0)
          : knots[1] + ((knots[2] - knots[1]) * (xs[i] - xb)) / (x1 - xb);
      error += (fit - zs[i]) ** 2;
    }
    if (error < best.error) {
      best = { split: s, slopeA: (knots[1] - knots[0]) / (xb - x0), slopeB: (knots[2] - knots[1]) / (x1 - xb), zSplit: knots[1], error };
    }
  }
  return best;
}

function solve3(A: number[], b: number[]): number[] | null {
  const m = [A.slice(0, 3).concat(b[0]), A.slice(3, 6).concat(b[1]), A.slice(6, 9).concat(b[2])];
  for (let c = 0; c < 3; c++) {
    let pivot = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

export interface FittedGeometry {
  geometry: GeometryParams;
  /** Where each parameter comes from: "measured" from the model, or "class" (the anchor class value). */
  basis: Record<ParamId, ParamBasis>;
  notes: string[];
}

/**
 * Fits the simulator's shape parameters to a measured model. Parameters that a
 * surface cannot tell (floor detail, wheel exposure, aero devices) come from
 * the anchor class; devices are removed, since the model's own are part of its surface.
 */
export function fitGeometry(measured: MeasuredModel, anchor: GeometryParams): FittedGeometry {
  const { body, length, wheels } = measured;
  const { dx, nx, nz } = body;
  const notes: string[] = [];
  const geometry: GeometryParams = { ...anchor };
  const basis = Object.fromEntries(PARAM_DEFINITIONS.map((definition) => [definition.id, "class"])) as Record<ParamId, ParamBasis>;
  const set = (id: ParamId, value: number) => {
    const clamped = clampParam(id, value);
    if (Math.abs(clamped - value) > 1e-9) {
      const definition = PARAM_DEFINITIONS.find((entry) => entry.id === id)!;
      notes.push(`${definition.label} measures ${value.toFixed(3)}, outside the simulator's range; ${clamped.toFixed(3)} is used.`);
    }
    geometry[id] = clamped;
    basis[id] = "measured";
  };
  const at = (table: Float32Array, x: number) => table[Math.min(Math.max(Math.round(x / dx), 0), nx - 1)];

  // Lengths. The three must add up to the measured length, so the rear overhang takes the remainder.
  let frontOverhang: number;
  let wheelbase: number;
  if (wheels) {
    frontOverhang = wheels.frontAxleX;
    wheelbase = wheels.rearAxleX - wheels.frontAxleX;
    set("wheelDiameter", wheels.diameter);
    set("tireWidth", wheels.tireWidth);
  } else {
    const total = anchor.frontOverhang + anchor.wheelbase + anchor.rearOverhang;
    frontOverhang = (length * anchor.frontOverhang) / total;
    wheelbase = (length * anchor.wheelbase) / total;
    notes.push("No tyre contact patches were found on the ground, so the wheel positions and sizes follow the class proportions.");
  }
  set("frontOverhang", frontOverhang);
  set("wheelbase", wheelbase);
  set("rearOverhang", length - geometry.frontOverhang - geometry.wheelbase);

  set("width", measured.width);
  set("rideHeight", measured.rideHeight);
  let roofHeight = 0;
  let xTop = 0;
  for (let i = 0; i < nx; i++) {
    if (body.upper[i] > roofHeight) {
      roofHeight = body.upper[i];
      xTop = i * dx;
    }
  }
  set("roofHeight", roofHeight);
  geometry.minGroundClearance = clampParam("minGroundClearance", Math.min(anchor.minGroundClearance, measured.rideHeight - 0.02));

  // Roof: the stretch around the highest point that stays within a few centimetres of it.
  const roofBand = Math.max(0.03, 0.025 * roofHeight);
  let roofStart = xTop;
  let roofEnd = xTop;
  while (roofStart - dx > 0 && at(body.upper, roofStart - dx) >= roofHeight - roofBand) roofStart -= dx;
  while (roofEnd + dx < length && at(body.upper, roofEnd + dx) >= roofHeight - roofBand) roofEnd += dx;

  // Front: hood then windshield, as two straight segments from behind the nose rounding to the roof.
  const frontXs: number[] = [];
  const frontZs: number[] = [];
  for (let x = Math.min(P.noseRadiusUpper, 0.3 * roofStart); x <= roofStart + 1e-9; x += dx) {
    frontXs.push(x);
    frontZs.push(at(body.upper, x));
  }
  if (frontXs.length >= 8) {
    const fit = twoSegmentFit(frontXs, frontZs);
    const cowlX = frontXs[fit.split];
    set("hoodLength", cowlX);
    set("hoodHeight", Math.min(fit.zSplit, roofHeight - 0.05));
    // Slope of the screen itself: between 20 % and 80 % of the rise from the hood to the roof edge, which
    // leaves out the cowl and the rounding into the roof (a straight-line fit through both reads too flat).
    const rise = roofHeight - P.roofCrown - geometry.hoodHeight;
    let xLow = cowlX;
    let xHigh = roofStart;
    for (let x = roofStart; x >= cowlX; x -= dx) {
      const z = at(body.upper, x);
      if (z >= geometry.hoodHeight + 0.8 * rise) xHigh = x;
      if (z >= geometry.hoodHeight + 0.2 * rise) xLow = x;
    }
    const screen = rise > 0.08 && xHigh - xLow > 0.5 * dx ? Math.atan2(0.6 * rise, xHigh - xLow) : Math.atan(Math.max(fit.slopeB, 0.05));
    set("windshieldAngle", screen * RAD_TO_DEG);
    set("frontBumperHeight", Math.min(fit.zSplit - fit.slopeA * cowlX, geometry.hoodHeight));
  } else {
    notes.push("The front of the model is too short to separate hood and windshield; the class values are kept.");
  }

  // Rear: rear window then deck, from the roof to the tail.
  const rearXs: number[] = [];
  const rearZs: number[] = [];
  for (let x = roofEnd; x <= length - 0.04; x += dx) {
    rearXs.push(x);
    rearZs.push(at(body.upper, x));
  }
  if (rearXs.length >= 8) {
    const fit = twoSegmentFit(rearXs, rearZs);
    const kneeX = rearXs[fit.split];
    const deckLength = length - kneeX;
    const windowSlope = Math.max(-fit.slopeA, 0.02);
    const deckSlope = Math.abs(fit.slopeB);
    // A deck is a clearly level stretch behind the window. A tail that merely rounds off is not one:
    // without a deck the window runs to the tail.
    if (deckLength >= 0.2 && deckSlope < Math.tan(8 * DEG_TO_RAD) && windowSlope > 3 * deckSlope) {
      set("rearDeckLength", deckLength);
      set("rearBumperHeight", fit.zSplit);
      set("rearWindowAngle", Math.atan(windowSlope) * RAD_TO_DEG);
    } else {
      const tail = at(body.upper, length - 0.02);
      set("rearDeckLength", 0);
      set("rearBumperHeight", tail);
      // Slope of the window itself: between 80 % and 20 % of the drop from the roof to the tail,
      // which leaves out the rounding at both ends.
      const drop = roofHeight - P.roofCrown - tail;
      let xHigh = roofEnd;
      let xLow = length - 0.02;
      for (let x = roofEnd; x <= length - 0.02; x += dx) {
        const z = at(body.upper, x);
        if (z >= tail + 0.8 * drop) xHigh = x;
        if (z >= tail + 0.2 * drop) xLow = x;
      }
      const run = Math.max(xLow - xHigh, 0.5 * dx);
      // A roof that only dips a little before a vertical tail (a van, an off-roader) has an upright rear end:
      // the upper profile never shows its rear window, and the gentle dip is not one.
      const upright = drop < Math.max(0.12, 0.08 * roofHeight);
      set("rearWindowAngle", upright ? 85 : Math.atan2(0.6 * drop, run) * RAD_TO_DEG);
    }
  } else {
    // The roof runs to the tail: an upright rear end.
    set("rearDeckLength", 0);
    set("rearBumperHeight", Math.min(at(body.upper, length - 0.04), roofHeight - 0.1));
    set("rearWindowAngle", 85);
  }

  // Section through the middle of the cabin: beltline and how much the greenhouse narrows.
  const cabin = Math.min(Math.max(Math.round((0.5 * (roofStart + roofEnd)) / dx), 0), nx - 1);
  let widest = 0;
  let widestRow = 0;
  for (let k = 0; k < nz; k++) {
    if (body.halfWidth[cabin * nz + k] > widest) {
      widest = body.halfWidth[cabin * nz + k];
      widestRow = k;
    }
  }
  if (widest > 0) {
    let belt = widestRow;
    for (let k = widestRow; k < nz; k++) {
      if (body.halfWidth[cabin * nz + k] < 0.97 * widest) break;
      belt = k;
    }
    set("beltHeight", Math.min(belt * body.dz, roofHeight - 0.15));
    const roofEdgeRow = Math.max(Math.floor((roofHeight - P.roofCrown - P.topEdgeRadius) / body.dz), 0);
    set("cabinWidthRatio", body.halfWidth[cabin * nz + roofEdgeRow] / widest);
  }

  // Plan taper, read where the simulator's own taper law is evaluated.
  const halfWidth = 0.5 * geometry.width;
  const frontExtent = P.frontTaperExtent * length;
  const xFront = Math.max(P.planNoseRadius, 0.25 * frontExtent);
  const u = 1 - xFront / frontExtent;
  set("frontTaper", (1 - at(body.plan, xFront) / halfWidth) / (u * u));
  set("rearTaper", 1 - at(body.plan, length - 0.06) / halfWidth);

  // Rear floor: where the sill line starts to rise toward the tail.
  const rise = at(body.lower, length - 0.04);
  if (rise > 0.03) {
    let start = length - 0.04;
    while (start - dx > 0.5 * length && at(body.lower, start - dx) > 0.015) start -= dx;
    const run = Math.max(length - start, 0.1);
    set("diffuserLength", run);
    set("diffuserAngle", Math.atan(rise / run) * RAD_TO_DEG);
  } else {
    set("diffuserAngle", 0);
    set("diffuserLength", anchor.diffuserLength);
  }

  // Devices in the model are part of its measured surface; separate ones start switched off.
  geometry.spoilerHeight = 0;
  geometry.wingChord = 0;
  geometry.splitterExtension = 0;
  geometry.sideSkirtDepth = 0;
  return { geometry, basis, notes };
}
