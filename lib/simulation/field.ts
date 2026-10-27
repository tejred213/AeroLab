/**
 * Flow-field container used by every visualisation, whatever produced it
 * (reduced-order solve today; imported CFD fields in the future).
 */
import type { Fidelity } from "@/lib/types";

export const CELL_FLUID = 0;
export const CELL_SOLID = 1;
export const CELL_WAKE = 2;

export interface FlowField {
  nx: number;
  ny: number;
  nz: number;
  /** Cell-centre coordinates along each axis, m (rectilinear, non-uniform). */
  xc: Float32Array;
  yc: Float32Array;
  zc: Float32Array;
  /** Velocity components as a ratio to the freestream speed. */
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  /** Pressure coefficient Cp = (p - p_inf) / q_inf. */
  cp: Float32Array;
  /** Turbulence-intensity estimate (0..1). Empirical, not solved. */
  ti: Float32Array;
  /** CELL_FLUID | CELL_SOLID | CELL_WAKE per cell. */
  kind: Uint8Array;
  /** True when only y >= 0 is stored and the field is mirror-symmetric about y = 0. */
  symmetric: boolean;
  bounds: { xMin: number; xMax: number; yMax: number; zMax: number };
  /** Freestream relative to the vehicle. */
  freestream: { speed: number; yawDeg: number };
  /** What produced this field; always shown next to the visualisation. */
  provenance: string;
  fidelity: Fidelity;
  /** Hash of the geometry + conditions the field belongs to. */
  hash: string;
}

/** Index of the cell-centre interval containing `value` (clamped), plus the interpolation weight. */
function locate(axis: Float32Array, value: number, out: { index: number; t: number }): void {
  const last = axis.length - 1;
  if (value <= axis[0]) {
    out.index = 0;
    out.t = 0;
    return;
  }
  if (value >= axis[last]) {
    out.index = last - 1;
    out.t = 1;
    return;
  }
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (axis[mid] <= value) low = mid;
    else high = mid;
  }
  out.index = low;
  out.t = (value - axis[low]) / (axis[low + 1] - axis[low]);
}

const lx = { index: 0, t: 0 };
const ly = { index: 0, t: 0 };
const lz = { index: 0, t: 0 };

export interface FieldSample {
  u: number;
  v: number;
  w: number;
  cp: number;
  ti: number;
  /** Cell kind at the nearest cell centre. */
  kind: number;
  /** False when the point is outside the stored domain. */
  inside: boolean;
}

/** Trilinear interpolation of the field at a point. Writes into `out` (no allocation). */
export function sampleField(field: FlowField, x: number, y: number, z: number, out: FieldSample): FieldSample {
  const { bounds } = field;
  const mirror = field.symmetric && y < 0;
  const yy = mirror ? -y : y;
  if (x < bounds.xMin || x > bounds.xMax || Math.abs(y) > bounds.yMax || z < 0 || z > bounds.zMax) {
    out.inside = false;
    out.u = Math.cos((field.freestream.yawDeg * Math.PI) / 180);
    out.v = Math.sin((field.freestream.yawDeg * Math.PI) / 180);
    out.w = 0;
    out.cp = 0;
    out.ti = 0;
    out.kind = CELL_FLUID;
    return out;
  }
  locate(field.xc, x, lx);
  locate(field.yc, yy, ly);
  locate(field.zc, z, lz);
  const { nx, ny } = field;
  const i = lx.index;
  const j = ly.index;
  const k = lz.index;
  const tx = lx.t;
  const ty = ly.t;
  const tz = lz.t;
  const c000 = i + nx * (j + ny * k);
  const c100 = c000 + 1;
  const c010 = c000 + nx;
  const c110 = c010 + 1;
  const c001 = c000 + nx * ny;
  const c101 = c001 + 1;
  const c011 = c001 + nx;
  const c111 = c011 + 1;
  const w000 = (1 - tx) * (1 - ty) * (1 - tz);
  const w100 = tx * (1 - ty) * (1 - tz);
  const w010 = (1 - tx) * ty * (1 - tz);
  const w110 = tx * ty * (1 - tz);
  const w001 = (1 - tx) * (1 - ty) * tz;
  const w101 = tx * (1 - ty) * tz;
  const w011 = (1 - tx) * ty * tz;
  const w111 = tx * ty * tz;
  const mix = (a: Float32Array) =>
    a[c000] * w000 + a[c100] * w100 + a[c010] * w010 + a[c110] * w110 +
    a[c001] * w001 + a[c101] * w101 + a[c011] * w011 + a[c111] * w111;
  out.u = mix(field.u);
  out.v = mirror ? -mix(field.v) : mix(field.v);
  out.w = mix(field.w);
  out.cp = mix(field.cp);
  out.ti = mix(field.ti);
  const nearest =
    (tx > 0.5 ? i + 1 : i) + nx * ((ty > 0.5 ? j + 1 : j) + ny * (tz > 0.5 ? k + 1 : k));
  out.kind = field.kind[nearest];
  out.inside = true;
  return out;
}

export function createFieldSample(): FieldSample {
  return { u: 1, v: 0, w: 0, cp: 0, ti: 0, kind: CELL_FLUID, inside: true };
}

/** Buffers that can be transferred between threads without copying. */
export function fieldTransferables(field: FlowField): ArrayBuffer[] {
  return [field.xc, field.yc, field.zc, field.u, field.v, field.w, field.cp, field.ti, field.kind].map(
    (array) => array.buffer as ArrayBuffer,
  );
}
