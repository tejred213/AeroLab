/**
 * Mode B numerical core: steady incompressible potential flow about the vehicle
 * and its wake displacement body, on a rectilinear cut-cell finite-volume grid.
 *
 * Unknown: perturbation potential phi' with velocity  u = U_inf + grad(phi').
 * Each cell conserves volume flux through the open part of its faces:
 *
 *     sum_f a_f A_f (U_inf . n_f + d(phi')/dn_f) = 0
 *
 * where a_f is the open-area fraction ("aperture") of face f. Solid surfaces
 * are therefore impermeable without being resolved by the grid lines.
 *
 * Boundary conditions: ground and symmetry plane are walls (zero normal
 * perturbation flux); the inlet has uniform inflow; the side, top and outlet
 * boundaries are constant-pressure (open-jet) boundaries, phi' = 0.
 *
 * This is an inviscid model. Separation, base pressure and friction are NOT
 * solved; they are added as empirical closures in reducedOrder.ts.
 *
 * backend/engines/potential_flow.py mirrors this file.
 */
import type { Fidelity } from "@/lib/types";
import { DEG_TO_RAD, MODEL } from "@/lib/physics/model";
import {
  bodyIntervals,
  type SolidModel,
  wakeHalfWidth,
  xBreakpoints,
  zBreakpoints,
} from "@/lib/geometry/solids";

const RO = MODEL.reducedOrder;
const TUNNEL = MODEL.tunnel;

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  /** Face coordinates (length n + 1). */
  xf: Float64Array;
  yf: Float64Array;
  zf: Float64Array;
  /** Cell-centre coordinates (length n). */
  xc: Float64Array;
  yc: Float64Array;
  zc: Float64Array;
  symmetric: boolean;
}

export function fidelitySettings(fidelity: Fidelity) {
  return RO.fidelity[fidelity];
}

/**
 * One grid axis: uniform zones between fineLo and the last zone end, then cells
 * growing geometrically out to lo and hi.
 */
function buildAxis(
  lo: number,
  fineLo: number,
  zones: { to: number; h: number }[],
  hi: number,
  growth: number,
): Float64Array {
  const faces: number[] = [fineLo];
  let position = fineLo;
  for (const zone of zones) {
    const count = Math.max(1, Math.round((zone.to - position) / zone.h));
    const step = (zone.to - position) / count;
    for (let i = 1; i < count; i++) faces.push(position + step * i);
    faces.push(zone.to);
    position = zone.to;
  }
  let h = zones[zones.length - 1].h;
  while (position < hi - 1e-9) {
    h *= growth;
    position += h;
    if (hi - position < 0.5 * h) position = hi;
    faces.push(Math.min(position, hi));
  }
  if (lo < fineLo - 1e-9) {
    const lower: number[] = [];
    h = zones[0].h;
    position = fineLo;
    while (position > lo + 1e-9) {
      h *= growth;
      position -= h;
      if (position - lo < 0.5 * h) position = lo;
      lower.push(Math.max(position, lo));
    }
    lower.reverse();
    return Float64Array.from([...lower, ...faces]);
  }
  return Float64Array.from(faces);
}

function centres(faces: Float64Array): Float64Array {
  const c = new Float64Array(faces.length - 1);
  for (let i = 0; i < c.length; i++) c[i] = 0.5 * (faces[i] + faces[i + 1]);
  return c;
}

/**
 * Rectilinear grid around a vehicle. Grid faces are placed exactly on the floor
 * plane, the roof crown, the nose, the tail and the body sides, and the ground
 * gap always holds the same number of cells. The large flat surfaces are then
 * represented exactly and results vary smoothly with ride height.
 */
export function buildGrid(
  dimensions: { length: number; width: number; rideHeight: number; roofHeight: number },
  fidelity: Fidelity,
  symmetric: boolean,
): Grid {
  const f = fidelitySettings(fidelity);
  const { length, rideHeight } = dimensions;
  const halfWidth = dimensions.width / 2;
  const roof = rideHeight + dimensions.roofHeight;
  const xf = buildAxis(
    TUNNEL.xMin,
    -TUNNEL.upstreamFine,
    [
      { to: 0, h: f.hx },
      { to: length, h: f.hx },
      { to: length + TUNNEL.downstreamFine, h: f.hx },
    ],
    TUNNEL.xMax,
    RO.growth,
  );
  const lateral = halfWidth + TUNNEL.lateralFine;
  const yf = symmetric
    ? buildAxis(
        0,
        0,
        [
          { to: halfWidth, h: f.hy },
          { to: lateral, h: f.hy },
        ],
        TUNNEL.halfWidth,
        RO.growth,
      )
    : buildAxis(
        -TUNNEL.halfWidth,
        -lateral,
        [
          { to: -halfWidth, h: f.hy },
          { to: halfWidth, h: f.hy },
          { to: lateral, h: f.hy },
        ],
        TUNNEL.halfWidth,
        RO.growth,
      );
  const lowerBody = Math.min(rideHeight + TUNNEL.groundZone, 0.5 * (rideHeight + roof));
  const zf = buildAxis(
    0,
    0,
    [
      { to: rideHeight, h: rideHeight / f.gapCells },
      { to: lowerBody, h: f.hzGround },
      { to: roof, h: f.hzBody },
      { to: roof + TUNNEL.aboveFine, h: f.hzBody },
    ],
    TUNNEL.height,
    RO.growth,
  );
  return {
    nx: xf.length - 1,
    ny: yf.length - 1,
    nz: zf.length - 1,
    xf,
    yf,
    zf,
    xc: centres(xf),
    yc: centres(yf),
    zc: centres(zf),
    symmetric,
  };
}

// ---------------------------------------------------------------------------
// Apertures
// ---------------------------------------------------------------------------

export interface Apertures {
  /** Open fraction of each face with respect to the real solids only. */
  bx: Float32Array;
  by: Float32Array;
  bz: Float32Array;
  /** Open fraction with respect to real solids plus the wake displacement body. */
  ux: Float32Array;
  uy: Float32Array;
  uz: Float32Array;
}

const GAUSS = [0.5 - 0.5 / Math.sqrt(3), 0.5 + 0.5 / Math.sqrt(3)];
const GROUND_SAMPLE_HEIGHT = 0.01;

const clipped = new Float64Array(16);

/** Length of the union of the first n intervals of `iv`, restricted to [a, b]. */
function coveredLength(a: number, b: number, iv: Float64Array, n: number): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const start = Math.max(iv[2 * i], a);
    const end = Math.min(iv[2 * i + 1], b);
    if (end > start) {
      clipped[2 * m] = start;
      clipped[2 * m + 1] = end;
      m++;
    }
  }
  if (m === 0) return 0;
  if (m === 1) return clipped[1] - clipped[0];
  // Insertion sort by start, then merge.
  for (let i = 1; i < m; i++) {
    const s = clipped[2 * i];
    const e = clipped[2 * i + 1];
    let j = i - 1;
    while (j >= 0 && clipped[2 * j] > s) {
      clipped[2 * j + 2] = clipped[2 * j];
      clipped[2 * j + 3] = clipped[2 * j + 1];
      j--;
    }
    clipped[2 * j + 2] = s;
    clipped[2 * j + 3] = e;
  }
  let total = 0;
  let start = clipped[0];
  let end = clipped[1];
  for (let i = 1; i < m; i++) {
    if (clipped[2 * i] > end) {
      total += end - start;
      start = clipped[2 * i];
      end = clipped[2 * i + 1];
    } else if (clipped[2 * i + 1] > end) {
      end = clipped[2 * i + 1];
    }
  }
  return total + (end - start);
}

/** Covered length of the y segment [ya, yb] by |y| intervals (solids are symmetric about y = 0). */
function segmentCoverage(ya: number, yb: number, iv: Float64Array, n: number): number {
  if (ya >= 0) return coveredLength(ya, yb, iv, n);
  if (yb <= 0) return coveredLength(-yb, -ya, iv, n);
  return coveredLength(0, -ya, iv, n) + coveredLength(0, yb, iv, n);
}

/**
 * Splits [lo, hi] at the given points. Writes the boundaries (lo, ..., hi) to
 * `out` and returns how many there are.
 */
function subdivide(lo: number, hi: number, points: ArrayLike<number>, count: number, out: Float64Array): number {
  let n = 1;
  out[0] = lo;
  for (let i = 0; i < count; i++) {
    const p = points[i];
    if (p > lo + 1e-9 && p < hi - 1e-9) {
      let j = n;
      while (j > 1 && out[j - 1] > p) {
        out[j] = out[j - 1];
        j--;
      }
      out[j] = p;
      n++;
    }
  }
  out[n++] = hi;
  return n;
}

/** Range [start, end) of cells whose extent overlaps [lo, hi]. */
function cellRange(faces: Float64Array, lo: number, hi: number): [number, number] {
  const n = faces.length - 1;
  let start = 0;
  while (start < n && faces[start + 1] <= lo) start++;
  let end = n;
  while (end > start && faces[end - 1] >= hi) end--;
  return [start, end];
}

/**
 * Open-area fraction of every cell face near the vehicle. Coverage is
 * integrated exactly in y and by 2-point Gauss quadrature in x and z between
 * the stations where a solid starts or ends, so apertures vary smoothly with
 * the geometry parameters.
 */
export function computeApertures(grid: Grid, model: SolidModel): Apertures {
  const { nx, ny, nz, xf, yf, zf } = grid;
  const ap: Apertures = {
    bx: new Float32Array((nx + 1) * ny * nz).fill(1),
    by: new Float32Array(nx * (ny + 1) * nz).fill(1),
    bz: new Float32Array(nx * ny * (nz + 1)).fill(1),
    ux: new Float32Array((nx + 1) * ny * nz).fill(1),
    uy: new Float32Array(nx * (ny + 1) * nz).fill(1),
    uz: new Float32Array(nx * ny * (nz + 1)).fill(1),
  };

  const margin = 1e-6;
  const [i0, i1] = cellRange(xf, model.xMin - margin, model.xMax + margin);
  const [j0, j1] = cellRange(yf, -model.yMax, model.yMax);
  const zTop = Math.max(model.zMax, model.wake.zSepTop, model.wake.spoilerTipZ) + 0.02;
  const [k0, k1] = cellRange(zf, 0, zTop);

  const iv = new Float64Array(16);
  const zPoints = new Float64Array(16);
  const zBounds = new Float64Array(20);
  const xBounds = new Float64Array(24);
  const xPoints = Float64Array.from(xBreakpoints(model, true));
  const coverB = new Float64Array(ny + 1);
  const coverU = new Float64Array(ny + 1);

  /** Loads the |y| intervals at (x, z): body intervals first, wake appended last. Returns body count. */
  const loadIntervals = (x: number, z: number): number => {
    const n = bodyIntervals(model, x, z, iv);
    iv[2 * n] = 0;
    iv[2 * n + 1] = wakeHalfWidth(model, x, z);
    return n;
  };

  // ---- X faces (normal to the flow) ----
  for (let i = i0; i <= i1; i++) {
    const x = xf[i];
    const zCount = zBreakpoints(model, x, true, zPoints);
    for (let k = k0; k < k1; k++) {
      const dz = zf[k + 1] - zf[k];
      coverB.fill(0, j0, j1);
      coverU.fill(0, j0, j1);
      const segments = subdivide(zf[k], zf[k + 1], zPoints, zCount, zBounds);
      for (let s = 0; s < segments - 1; s++) {
        const a = zBounds[s];
        const weight = (zBounds[s + 1] - a) / dz / 2;
        for (let g = 0; g < 2; g++) {
          const z = a + (zBounds[s + 1] - a) * GAUSS[g];
          const n = loadIntervals(x, z);
          const hasWake = iv[2 * n + 1] > 0;
          if (n === 0 && !hasWake) continue;
          for (let j = j0; j < j1; j++) {
            const dy = yf[j + 1] - yf[j];
            if (n > 0) coverB[j] += (weight * segmentCoverage(yf[j], yf[j + 1], iv, n)) / dy;
            coverU[j] += (weight * segmentCoverage(yf[j], yf[j + 1], iv, hasWake ? n + 1 : n)) / dy;
          }
        }
      }
      for (let j = j0; j < j1; j++) {
        const index = i + (nx + 1) * (j + ny * k);
        ap.bx[index] = 1 - coverB[j];
        ap.ux[index] = 1 - coverU[j];
      }
    }
  }

  // ---- Z faces (horizontal) ----
  // The ground face (k = 0) is sampled just above the road so that tyre contact
  // patches count as covered; it only matters for the body-surface integration.
  for (let k = k0; k <= k1; k++) {
    const z = k === 0 ? GROUND_SAMPLE_HEIGHT : zf[k];
    for (let i = i0; i < i1; i++) {
      const dx = xf[i + 1] - xf[i];
      coverB.fill(0, j0, j1);
      coverU.fill(0, j0, j1);
      const segments = subdivide(xf[i], xf[i + 1], xPoints, xPoints.length, xBounds);
      for (let s = 0; s < segments - 1; s++) {
        const a = xBounds[s];
        const weight = (xBounds[s + 1] - a) / dx / 2;
        for (let g = 0; g < 2; g++) {
          const x = a + (xBounds[s + 1] - a) * GAUSS[g];
          const n = loadIntervals(x, z);
          const hasWake = iv[2 * n + 1] > 0;
          if (n === 0 && !hasWake) continue;
          for (let j = j0; j < j1; j++) {
            const dy = yf[j + 1] - yf[j];
            if (n > 0) coverB[j] += (weight * segmentCoverage(yf[j], yf[j + 1], iv, n)) / dy;
            coverU[j] += (weight * segmentCoverage(yf[j], yf[j + 1], iv, hasWake ? n + 1 : n)) / dy;
          }
        }
      }
      for (let j = j0; j < j1; j++) {
        const index = i + nx * (j + ny * k);
        ap.bz[index] = 1 - coverB[j];
        ap.uz[index] = 1 - coverU[j];
      }
    }
  }

  // ---- Y faces (vertical, parallel to the flow) ----
  const jFaceStart = grid.symmetric ? Math.max(j0, 1) : j0;
  for (let i = i0; i < i1; i++) {
    const dx = xf[i + 1] - xf[i];
    const xSegments = subdivide(xf[i], xf[i + 1], xPoints, xPoints.length, xBounds);
    for (let k = k0; k < k1; k++) {
      coverB.fill(0, j0, j1 + 1);
      coverU.fill(0, j0, j1 + 1);
      const dz = zf[k + 1] - zf[k];
      for (let sx = 0; sx < xSegments - 1; sx++) {
        const xa = xBounds[sx];
        const xWeight = (xBounds[sx + 1] - xa) / dx / 2;
        for (let gx = 0; gx < 2; gx++) {
          const x = xa + (xBounds[sx + 1] - xa) * GAUSS[gx];
          const zCount = zBreakpoints(model, x, true, zPoints);
          const zSegments = subdivide(zf[k], zf[k + 1], zPoints, zCount, zBounds);
          for (let sz = 0; sz < zSegments - 1; sz++) {
            const za = zBounds[sz];
            const weight = (xWeight * (zBounds[sz + 1] - za)) / dz / 2;
            for (let gz = 0; gz < 2; gz++) {
              const z = za + (zBounds[sz + 1] - za) * GAUSS[gz];
              const n = loadIntervals(x, z);
              const wakeWidth = iv[2 * n + 1];
              if (n === 0 && wakeWidth <= 0) continue;
              for (let j = jFaceStart; j <= j1; j++) {
                const ay = Math.abs(yf[j]);
                let inBody = false;
                for (let q = 0; q < n; q++) {
                  if (ay >= iv[2 * q] && ay <= iv[2 * q + 1]) {
                    inBody = true;
                    break;
                  }
                }
                if (inBody) coverB[j] += weight;
                if (inBody || (wakeWidth > 0 && ay <= wakeWidth)) coverU[j] += weight;
              }
            }
          }
        }
      }
      for (let j = jFaceStart; j <= j1; j++) {
        if (j > ny) break;
        const index = i + nx * (j + (ny + 1) * k);
        ap.by[index] = 1 - coverB[j];
        ap.uy[index] = 1 - coverU[j];
      }
    }
  }

  // Remove vanishing openings, which would only harm the conditioning.
  for (const array of [ap.bx, ap.by, ap.bz, ap.ux, ap.uy, ap.uz]) {
    for (let n = 0; n < array.length; n++) {
      if (array[n] < RO.minAperture) array[n] = 0;
      else if (array[n] > 1) array[n] = 1;
    }
  }
  return ap;
}

// ---------------------------------------------------------------------------
// Fluid cells
// ---------------------------------------------------------------------------

/**
 * Marks the cells that take part in the solve: those with an opening that are
 * connected to the far field. Openings into unreachable pockets are closed.
 */
export function markActiveCells(grid: Grid, ap: Apertures): Uint8Array {
  const { nx, ny, nz } = grid;
  const nxy = nx * ny;
  const total = nxy * nz;
  const reached = new Uint8Array(total);
  const stack = new Int32Array(total);
  let top = 0;
  const seed = 0 + nx * (ny - 1 + ny * (nz - 1));
  reached[seed] = 1;
  stack[top++] = seed;
  while (top > 0) {
    const c = stack[--top];
    const i = c % nx;
    const j = ((c - i) / nx) % ny;
    const k = (c - i - nx * j) / nxy;
    const fx = i + (nx + 1) * (j + ny * k);
    const fy = i + nx * (j + (ny + 1) * k);
    if (i > 0 && ap.ux[fx] > 0 && !reached[c - 1]) { reached[c - 1] = 1; stack[top++] = c - 1; }
    if (i < nx - 1 && ap.ux[fx + 1] > 0 && !reached[c + 1]) { reached[c + 1] = 1; stack[top++] = c + 1; }
    if (j > 0 && ap.uy[fy] > 0 && !reached[c - nx]) { reached[c - nx] = 1; stack[top++] = c - nx; }
    if (j < ny - 1 && ap.uy[fy + nx] > 0 && !reached[c + nx]) { reached[c + nx] = 1; stack[top++] = c + nx; }
    if (k > 0 && ap.uz[c] > 0 && !reached[c - nxy]) { reached[c - nxy] = 1; stack[top++] = c - nxy; }
    if (k < nz - 1 && ap.uz[c + nxy] > 0 && !reached[c + nxy]) { reached[c + nxy] = 1; stack[top++] = c + nxy; }
  }
  // Close faces between reached and unreached cells.
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (reached[c]) continue;
        const fx = i + (nx + 1) * (j + ny * k);
        const fy = i + nx * (j + (ny + 1) * k);
        ap.ux[fx] = 0;
        ap.ux[fx + 1] = 0;
        ap.uy[fy] = 0;
        ap.uy[fy + nx] = 0;
        ap.uz[c] = 0;
        ap.uz[c + nxy] = 0;
      }
    }
  }
  return reached;
}

// ---------------------------------------------------------------------------
// Linear solve
// ---------------------------------------------------------------------------

export interface PotentialSolution {
  /** Perturbation potential per cell for a unit freestream speed. */
  phi: Float64Array;
  iterations: number;
  residual: number;
  converged: boolean;
}

export interface SolveOptions {
  yawDeg: number;
  tolerance: number;
  maxIterations?: number;
  onProgress?: (fraction: number, iteration: number, residual: number) => void;
}

/** Jacobi-preconditioned conjugate gradients on the symmetric positive-definite flux system. */
export function solvePotential(
  grid: Grid,
  ap: Apertures,
  active: Uint8Array,
  options: SolveOptions,
): PotentialSolution {
  const { nx, ny, nz, xf, yf, zf, xc, yc, zc } = grid;
  const nxy = nx * ny;
  const total = nxy * nz;
  const ux = Math.cos(options.yawDeg * DEG_TO_RAD);
  const uy = Math.sin(options.yawDeg * DEG_TO_RAD);

  // Face conductances g = a A / d for interior faces (0 on boundaries).
  const gx = new Float64Array((nx + 1) * ny * nz);
  const gy = new Float64Array(nx * (ny + 1) * nz);
  const gz = new Float64Array(nx * ny * (nz + 1));
  const diag = new Float64Array(total);
  const rhs = new Float64Array(total);

  for (let k = 0; k < nz; k++) {
    const dz = zf[k + 1] - zf[k];
    for (let j = 0; j < ny; j++) {
      const dy = yf[j + 1] - yf[j];
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!active[c]) {
          diag[c] = 1;
          continue;
        }
        const dx = xf[i + 1] - xf[i];
        const areaX = dy * dz;
        const areaY = dx * dz;
        const areaZ = dx * dy;
        const fx = i + (nx + 1) * (j + ny * k);
        const fy = i + nx * (j + (ny + 1) * k);
        let d = 0;
        let flux = 0;

        // x- face: inlet (uniform inflow) at i = 0.
        if (i > 0) {
          const g = (ap.ux[fx] * areaX) / (xc[i] - xc[i - 1]);
          gx[fx] = g;
          d += g;
          flux -= ap.ux[fx] * areaX * ux;
        } else {
          flux -= areaX * ux;
        }
        // x+ face: outlet (constant pressure) at i = nx - 1.
        if (i < nx - 1) {
          d += (ap.ux[fx + 1] * areaX) / (xc[i + 1] - xc[i]);
          flux += ap.ux[fx + 1] * areaX * ux;
        } else {
          d += areaX / (0.5 * dx);
          flux += areaX * ux;
        }
        // y- face: symmetry wall, or open-jet boundary when the full width is solved.
        if (j > 0) {
          const g = (ap.uy[fy] * areaY) / (yc[j] - yc[j - 1]);
          gy[fy] = g;
          d += g;
          flux -= ap.uy[fy] * areaY * uy;
        } else if (!grid.symmetric) {
          d += areaY / (0.5 * dy);
          flux -= areaY * uy;
        }
        // y+ face: open-jet boundary at j = ny - 1.
        if (j < ny - 1) {
          d += (ap.uy[fy + nx] * areaY) / (yc[j + 1] - yc[j]);
          flux += ap.uy[fy + nx] * areaY * uy;
        } else {
          d += areaY / (0.5 * dy);
          flux += areaY * uy;
        }
        // z- face: ground wall at k = 0 (no freestream component in z).
        if (k > 0) {
          const g = (ap.uz[c] * areaZ) / (zc[k] - zc[k - 1]);
          gz[c] = g;
          d += g;
        }
        // z+ face: open-jet boundary at k = nz - 1.
        if (k < nz - 1) {
          d += (ap.uz[c + nxy] * areaZ) / (zc[k + 1] - zc[k]);
        } else {
          d += areaZ / (0.5 * dz);
        }
        diag[c] = d;
        rhs[c] = flux;
      }
    }
  }

  // Vectors are padded by one k-plane on each side so neighbour reads never leave the buffer.
  const pad = nxy;
  const phi = new Float64Array(total + 2 * pad);
  const p = new Float64Array(total + 2 * pad);
  const r = new Float64Array(total);
  const zv = new Float64Array(total);
  const q = new Float64Array(total);

  let rhsNorm = 0;
  for (let c = 0; c < total; c++) {
    r[c] = rhs[c];
    rhsNorm += rhs[c] * rhs[c];
  }
  rhsNorm = Math.sqrt(rhsNorm);
  if (rhsNorm === 0) {
    return { phi: phi.slice(pad, pad + total), iterations: 0, residual: 0, converged: true };
  }

  let rz = 0;
  for (let c = 0; c < total; c++) {
    zv[c] = r[c] / diag[c];
    p[c + pad] = zv[c];
    rz += r[c] * zv[c];
  }

  const maxIterations = options.maxIterations ?? RO.maxIterations;
  const logTarget = Math.log(1 / options.tolerance);
  let iterations = 0;
  let residual = 1;

  while (iterations < maxIterations) {
    // q = A p
    let pq = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        const row = nx * (j + ny * k);
        const rowX = (nx + 1) * (j + ny * k);
        const rowY = nx * (j + (ny + 1) * k);
        for (let i = 0; i < nx; i++) {
          const c = row + i;
          const cp = c + pad;
          const value =
            diag[c] * p[cp] -
            gx[rowX + i] * p[cp - 1] -
            gx[rowX + i + 1] * p[cp + 1] -
            gy[rowY + i] * p[cp - nx] -
            gy[rowY + i + nx] * p[cp + nx] -
            gz[c] * p[cp - nxy] -
            gz[c + nxy] * p[cp + nxy];
          q[c] = value;
          pq += value * p[cp];
        }
      }
    }
    const alpha = rz / pq;
    let rr = 0;
    let rzNew = 0;
    for (let c = 0; c < total; c++) {
      phi[c + pad] += alpha * p[c + pad];
      const rc = r[c] - alpha * q[c];
      r[c] = rc;
      rr += rc * rc;
      const zc2 = rc / diag[c];
      zv[c] = zc2;
      rzNew += rc * zc2;
    }
    iterations++;
    residual = Math.sqrt(rr) / rhsNorm;
    if (residual <= options.tolerance) break;
    const beta = rzNew / rz;
    rz = rzNew;
    for (let c = 0; c < total; c++) p[c + pad] = zv[c] + beta * p[c + pad];
    if (options.onProgress && iterations % 20 === 0) {
      options.onProgress(Math.min(Math.log(1 / residual) / logTarget, 0.99), iterations, residual);
    }
  }

  return {
    phi: phi.slice(pad, pad + total),
    iterations,
    residual,
    converged: residual <= options.tolerance,
  };
}

// ---------------------------------------------------------------------------
// Velocities
// ---------------------------------------------------------------------------

export interface CellVelocities {
  /** Velocity components (ratio to freestream speed) at cell centres; 0 in inactive cells. */
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  /** Mean of the six union apertures: a cheap proxy for the cell's fluid volume fraction. */
  fluidFraction: Float32Array;
}

/**
 * Cell-centre velocities reconstructed from the face fluxes of each cell.
 */
export function cellVelocities(
  grid: Grid,
  ap: Apertures,
  active: Uint8Array,
  phi: Float64Array,
  yawDeg: number,
): CellVelocities {
  const { nx, ny, nz, xf, yf, zf, xc, yc, zc } = grid;
  const nxy = nx * ny;
  const total = nxy * nz;
  const ux = Math.cos(yawDeg * DEG_TO_RAD);
  const uy = Math.sin(yawDeg * DEG_TO_RAD);
  const out: CellVelocities = {
    u: new Float32Array(total),
    v: new Float32Array(total),
    w: new Float32Array(total),
    fluidFraction: new Float32Array(total),
  };
  const CUT = 0;
  const OPEN = 1;
  const FILLED_FIRST = 2;
  const FILLED_SECOND = 3;
  const state = new Uint8Array(total);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * (j + ny * k);
        if (!active[c]) continue;
        const fx = i + (nx + 1) * (j + ny * k);
        const fy = i + nx * (j + (ny + 1) * k);
        const value = phi[c];

        const axm = i > 0 ? ap.ux[fx] : 1;
        const axp = i < nx - 1 ? ap.ux[fx + 1] : 1;
        const aym = j > 0 ? ap.uy[fy] : 1;
        const ayp = j < ny - 1 ? ap.uy[fy + nx] : 1;
        const azm = k > 0 ? ap.uz[c] : 1;
        const azp = k < nz - 1 ? ap.uz[c + nxy] : 1;

        // Normal velocity through the open part of each face.
        const fxm = i > 0 ? ux + (value - phi[c - 1]) / (xc[i] - xc[i - 1]) : ux;
        const fxp =
          i < nx - 1
            ? ux + (phi[c + 1] - value) / (xc[i + 1] - xc[i])
            : ux - value / (0.5 * (xf[i + 1] - xf[i]));
        let fym: number;
        if (j > 0) fym = uy + (value - phi[c - nx]) / (yc[j] - yc[j - 1]);
        else if (grid.symmetric) fym = 0;
        else fym = uy + value / (0.5 * (yf[j + 1] - yf[j]));
        const fyp =
          j < ny - 1
            ? uy + (phi[c + nx] - value) / (yc[j + 1] - yc[j])
            : uy - value / (0.5 * (yf[j + 1] - yf[j]));
        const fzm = k > 0 ? (value - phi[c - nxy]) / (zc[k] - zc[k - 1]) : 0;
        const fzp =
          k < nz - 1 ? (phi[c + nxy] - value) / (zc[k + 1] - zc[k]) : -value / (0.5 * (zf[k + 1] - zf[k]));

        out.fluidFraction[c] = (axm + axp + aym + ayp + azm + azp) / 6;
        // Flux through the pair of faces divided by twice the larger opening: equals the face
        // velocity when both faces are equally open, and half of it next to a wall (where the
        // wall-normal velocity falls to zero).
        const openX = Math.max(axm, axp);
        const openY = Math.max(aym, ayp);
        const openZ = Math.max(azm, azp);
        out.u[c] = openX > 0 ? (axm * fxm + axp * fxp) / (2 * openX) : 0;
        out.v[c] = openY > 0 ? (aym * fym + ayp * fyp) / (2 * openY) : 0;
        out.w[c] = openZ > 0 ? (azm * fzm + azp * fzp) / (2 * openZ) : 0;
        if (Math.min(axm, axp, aym, ayp, azm, azp) >= 0.999) state[c] = OPEN;
      }
    }
  }

  // The flux-based estimate is poor in cells cut by an inclined surface (the two opposite
  // faces have very different openings). Replace it there by an inverse-distance-weighted
  // extrapolation from the neighbouring uncut cells; a second pass reaches cells that
  // only touch cells filled in the first pass.
  for (let pass = 1; pass <= 2; pass++) {
    const marker = pass === 1 ? FILLED_FIRST : FILLED_SECOND;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          if (!active[c] || state[c] !== CUT) continue;
          let weightSum = 0;
          let su = 0;
          let sv = 0;
          let sw = 0;
          for (let dk = -1; dk <= 1; dk++) {
            const kk = k + dk;
            if (kk < 0 || kk >= nz) continue;
            for (let dj = -1; dj <= 1; dj++) {
              const jj = j + dj;
              if (jj < 0 || jj >= ny) continue;
              for (let di = -1; di <= 1; di++) {
                const ii = i + di;
                if (ii < 0 || ii >= nx || (di === 0 && dj === 0 && dk === 0)) continue;
                const n = ii + nx * (jj + ny * kk);
                const source = state[n];
                if (source !== OPEN && !(pass === 2 && source === FILLED_FIRST)) continue;
                const ex = xc[ii] - xc[i];
                const ey = yc[jj] - yc[j];
                const ez = zc[kk] - zc[k];
                const weight = 1 / (ex * ex + ey * ey + ez * ez);
                weightSum += weight;
                su += weight * out.u[n];
                sv += weight * out.v[n];
                sw += weight * out.w[n];
              }
            }
          }
          if (weightSum > 0) {
            out.u[c] = su / weightSum;
            out.v[c] = sv / weightSum;
            out.w[c] = sw / weightSum;
            state[c] = marker;
          }
        }
      }
    }
  }
  return out;
}
