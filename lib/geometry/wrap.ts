/**
 * Shrink-wrapping an imported 3D model into one closed surface for CFD.
 *
 * A model made for drawing is a pile of loose panels: open edges, duplicated
 * faces, parts that overlap or merely sit next to each other. A CFD mesher
 * needs a single closed skin. The wrap makes one:
 *
 *   1. mark every voxel of a fine grid that the model's surface passes through;
 *   2. thicken those marks by the sealing radius, so gaps narrower than the
 *      sealing size close up;
 *   3. flood the air from a corner of the grid: whatever the flood cannot reach
 *      is the car, cabin and all;
 *   4. shrink the flooded region's complement back by the same radius;
 *   5. take the boundary between car and air as a mesh of voxel faces, and pull
 *      its vertices back onto the model's own surface (sub-voxel accuracy).
 *
 * The result is closed by construction: every edge of it is shared by an even
 * number of faces. It keeps what the flood could reach (mirrors, wheel arches,
 * spokes, the underbody as modelled) and loses whatever is finer than a voxel.
 *
 * Pure functions on typed arrays: no three.js, so this runs in the worker and in tests.
 */

export interface WrapOptions {
  /** Edge of a voxel, m. Features smaller than this are not kept. */
  voxel?: number;
  /** Gaps up to this wide are sealed, m (panel gaps, grille meshes). 0 seals nothing wider than a voxel. */
  seal?: number;
}

export interface WrappedSurface {
  /** xyz per vertex, in the coordinates of the input. */
  positions: Float32Array;
  /** Three vertex indices per triangle, wound so that normals point into the air. */
  indices: Uint32Array;
  voxel: number;
  seal: number;
  vertices: number;
  triangles: number;
  /** Enclosed volume, m³, and surface area, m². */
  volume: number;
  area: number;
  /** Area of the silhouette seen from the front (projection on the Y-Z plane), m². */
  frontalArea: number;
  min: [number, number, number];
  max: [number, number, number];
  /**
   * Volume of this wrap relative to one that seals every gap up to 0.3 m. A car whose cabin stayed sealed
   * scores about 0.9; a low value means the flood got inside through an opening.
   */
  fill: number;
  warnings: string[];
}

export const DEFAULT_WRAP: Required<WrapOptions> = { voxel: 0.015, seal: 0.03 };
/** Largest grid the wrap will build; a finer voxel than this allows is refused. */
const MAX_VOXELS = 40_000_000;
/** Sealing size of the reference wrap that the fill ratio compares with, m. */
const REFERENCE_SEAL = 0.3;
/** A one-voxel-thick part keeps this share of a voxel between its two faces when vertices are snapped. */
const THIN_LIMIT = 0.3;

/** In place: sets a voxel when any voxel within `radius` along the given axis is set. */
function dilateAxis(data: Uint8Array, nx: number, ny: number, nz: number, axis: 0 | 1 | 2, radius: number): void {
  const count = [nx, ny, nz][axis];
  const stride = [1, nx, nx * ny][axis];
  const [na, nb] = axis === 0 ? [ny, nz] : axis === 1 ? [nx, nz] : [nx, ny];
  const [sa, sb] = axis === 0 ? [nx, nx * ny] : axis === 1 ? [1, nx * ny] : [1, nx];
  const line = new Uint8Array(count);
  for (let b = 0; b < nb; b++) {
    for (let a = 0; a < na; a++) {
      const base = a * sa + b * sb;
      // Distance to the nearest set voxel behind, then ahead.
      let since = radius + 1;
      for (let i = 0; i < count; i++) {
        since = data[base + i * stride] ? 0 : since + 1;
        line[i] = since <= radius ? 1 : 0;
      }
      since = radius + 1;
      for (let i = count - 1; i >= 0; i--) {
        since = data[base + i * stride] ? 0 : since + 1;
        if (since <= radius) line[i] = 1;
      }
      for (let i = 0; i < count; i++) data[base + i * stride] = line[i];
    }
  }
}

function dilate(source: Uint8Array, nx: number, ny: number, nz: number, radius: number): Uint8Array {
  const out = source.slice();
  if (radius > 0) {
    dilateAxis(out, nx, ny, nz, 0, radius);
    dilateAxis(out, nx, ny, nz, 1, radius);
    dilateAxis(out, nx, ny, nz, 2, radius);
  }
  return out;
}

/** The voxels reachable from the grid's corner without crossing a blocked voxel (6-connected). */
function floodOutside(blocked: Uint8Array, nx: number, ny: number, nz: number): Uint8Array {
  const outside = new Uint8Array(blocked.length);
  const stack = new Int32Array(blocked.length);
  const nxy = nx * ny;
  let top = 0;
  outside[0] = 1;
  stack[top++] = 0;
  while (top > 0) {
    const c = stack[--top];
    const i = c % nx;
    const j = ((c - i) / nx) % ny;
    const k = (c - i - j * nx) / nxy;
    const visit = (n: number) => {
      if (!blocked[n] && !outside[n]) {
        outside[n] = 1;
        stack[top++] = n;
      }
    };
    if (i > 0) visit(c - 1);
    if (i < nx - 1) visit(c + 1);
    if (j > 0) visit(c - nx);
    if (j < ny - 1) visit(c + nx);
    if (k > 0) visit(c - nxy);
    if (k < nz - 1) visit(c + nxy);
  }
  return outside;
}

/** Car = everything the flood cannot reach once gaps up to 2 x radius are closed. Returns 1 for car. */
function sealedSolid(surface: Uint8Array, nx: number, ny: number, nz: number, radius: number): Uint8Array {
  const outside = floodOutside(dilate(surface, nx, ny, nz, radius), nx, ny, nz);
  // Shrinking the car back by the radius is the same as growing the air by it.
  const air = dilate(outside, nx, ny, nz, radius);
  for (let c = 0; c < air.length; c++) air[c] = air[c] ? 0 : 1;
  return air;
}

/**
 * Wraps a triangle soup (9 numbers per triangle) into a closed surface.
 * @param report called with a fraction of the work done and a short label.
 */
export function wrapModel(
  soup: Float32Array,
  options: WrapOptions = {},
  report: (fraction: number, label: string) => void = () => {},
): WrappedSurface {
  const h = options.voxel ?? DEFAULT_WRAP.voxel;
  const seal = options.seal ?? DEFAULT_WRAP.seal;
  const triangleCount = Math.floor(soup.length / 9);
  if (triangleCount === 0) throw new Error("The model contains no triangles to wrap.");
  if (!(h >= 0.004 && h <= 0.1)) throw new Error("The voxel size must be between 4 mm and 100 mm.");

  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i++) {
    const value = soup[i];
    if (!Number.isFinite(value)) throw new Error("The model contains coordinates that are not numbers.");
    if (value < lo[i % 3]) lo[i % 3] = value;
    if (value > hi[i % 3]) hi[i % 3] = value;
  }
  const radius = Math.ceil(seal / (2 * h) - 1e-9);
  const referenceRadius = Math.max(Math.ceil(REFERENCE_SEAL / (2 * h)), radius);
  // Room around the model for the thickening, plus a layer of free air for the flood to start in.
  const pad = referenceRadius + 2;
  const origin = [lo[0] - pad * h, lo[1] - pad * h, lo[2] - pad * h];
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 2 * pad + 1;
  const ny = Math.ceil((hi[1] - lo[1]) / h) + 2 * pad + 1;
  const nz = Math.ceil((hi[2] - lo[2]) / h) + 2 * pad + 1;
  const total = nx * ny * nz;
  if (total > MAX_VOXELS) {
    throw new Error(
      `A ${Math.round(h * 1000)} mm grid over this model has ${(total / 1e6).toFixed(0)} million voxels; the limit is ${MAX_VOXELS / 1e6} million. Use a larger voxel.`,
    );
  }
  const nxy = nx * ny;

  // --- 1. Voxels the surface passes through, with the mean of the surface points inside each. ---
  report(0.02, "Sampling the surface");
  const surface = new Uint8Array(total);
  const sampleId = new Int32Array(total).fill(-1);
  let sums = new Float32Array(4 * 65536);
  let sampled = 0;
  const mark = (x: number, y: number, z: number) => {
    const i = Math.floor((x - origin[0]) / h);
    const j = Math.floor((y - origin[1]) / h);
    const k = Math.floor((z - origin[2]) / h);
    const c = i + nx * j + nxy * k;
    let id = sampleId[c];
    if (id < 0) {
      id = sampled++;
      sampleId[c] = id;
      surface[c] = 1;
      if (4 * sampled > sums.length) {
        const grown = new Float32Array(2 * sums.length);
        grown.set(sums);
        sums = grown;
      }
    }
    sums[4 * id] += x;
    sums[4 * id + 1] += y;
    sums[4 * id + 2] += z;
    sums[4 * id + 3] += 1;
  };
  const spacing = 0.5 * h;
  for (let t = 0; t < triangleCount; t++) {
    const o = 9 * t;
    const ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    const ux = soup[o + 3] - ax, uy = soup[o + 4] - ay, uz = soup[o + 5] - az;
    const vx = soup[o + 6] - ax, vy = soup[o + 7] - ay, vz = soup[o + 8] - az;
    const edge = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz));
    const n = Math.min(Math.max(Math.ceil(edge / spacing), 1), 4000);
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const a = i / n;
        const b = j / n;
        mark(ax + ux * a + vx * b, ay + uy * a + vy * b, az + uz * a + vz * b);
      }
    }
  }

  // --- 2 to 4. Seal, flood, shrink back. ---
  report(0.3, "Sealing gaps and flooding the air");
  const solid = sealedSolid(surface, nx, ny, nz, radius);
  let solidCount = 0;
  for (let c = 0; c < total; c++) solidCount += solid[c];
  report(0.5, "Checking for leaks");
  let referenceCount = solidCount;
  if (referenceRadius > radius) {
    const reference = sealedSolid(surface, nx, ny, nz, referenceRadius);
    referenceCount = 0;
    for (let c = 0; c < total; c++) referenceCount += reference[c];
  }

  // --- 5. Boundary faces between car and air. ---
  report(0.62, "Building the surface");
  const isSolid = (i: number, j: number, k: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && solid[i + nx * j + nxy * k] === 1;
  const DIRECTIONS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  // Corner offsets of each face, ordered so that the face normal points away from the solid voxel.
  const CORNERS: number[][][] = [
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  ];
  let faceCount = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!solid[i + nx * j + nxy * k]) continue;
        for (const [di, dj, dk] of DIRECTIONS) if (!isSolid(i + di, j + dj, k + dk)) faceCount++;
      }
    }
  }
  if (faceCount === 0) throw new Error("The wrap is empty: nothing in the model encloses a volume at this voxel size.");

  const mx = nx + 1;
  const mxy = mx * (ny + 1);
  const nodeId = new Int32Array(mxy * (nz + 1)).fill(-1);
  const quads = new Uint32Array(4 * faceCount);
  let nodeGrid = new Int32Array(3 * 65536);
  // Per vertex: how far it may be moved when snapped (thin parts must keep a thickness).
  let limit = new Float32Array(65536);
  let vertexCount = 0;
  const vertexAt = (a: number, b: number, c: number, allowed: number) => {
    const key = a + mx * b + mxy * c;
    let id = nodeId[key];
    if (id < 0) {
      id = vertexCount++;
      nodeId[key] = id;
      if (3 * vertexCount > nodeGrid.length) {
        const grown = new Int32Array(2 * nodeGrid.length);
        grown.set(nodeGrid);
        nodeGrid = grown;
        const grownLimit = new Float32Array(2 * limit.length);
        grownLimit.set(limit);
        limit = grownLimit;
      }
      nodeGrid[3 * id] = a;
      nodeGrid[3 * id + 1] = b;
      nodeGrid[3 * id + 2] = c;
      limit[id] = allowed;
    } else if (allowed < limit[id]) {
      limit[id] = allowed;
    }
    return id;
  };
  let q = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!solid[i + nx * j + nxy * k]) continue;
        for (let d = 0; d < 6; d++) {
          const [di, dj, dk] = DIRECTIONS[d];
          if (isSolid(i + di, j + dj, k + dk)) continue;
          // Solid behind the voxel: the surface may move a full voxel. Air behind it: a thin part.
          const allowed = isSolid(i - di, j - dj, k - dk) ? h : THIN_LIMIT * h;
          for (const corner of CORNERS[d]) quads[q++] = vertexAt(i + corner[0], j + corner[1], k + corner[2], allowed);
        }
      }
    }
  }

  // Vertices start on the grid and are pulled onto the model's surface: toward the mean of the surface
  // points in the solid voxels around them. Vertices over sealed gaps have nothing to snap to.
  report(0.78, "Fitting the surface to the model");
  const positions = new Float32Array(3 * vertexCount);
  const free = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const a = nodeGrid[3 * v], b = nodeGrid[3 * v + 1], c = nodeGrid[3 * v + 2];
    const x = origin[0] + a * h, y = origin[1] + b * h, z = origin[2] + c * h;
    let sx = 0, sy = 0, sz = 0, weight = 0;
    for (let dk = -1; dk <= 0; dk++) {
      for (let dj = -1; dj <= 0; dj++) {
        for (let di = -1; di <= 0; di++) {
          const i = a + di, j = b + dj, k = c + dk;
          if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) continue;
          const cell = i + nx * j + nxy * k;
          const id = sampleId[cell];
          if (id < 0 || !solid[cell]) continue;
          const n = sums[4 * id + 3];
          sx += sums[4 * id] / n;
          sy += sums[4 * id + 1] / n;
          sz += sums[4 * id + 2] / n;
          weight++;
        }
      }
    }
    let px = x, py = y, pz = z;
    if (weight > 0) {
      const mx2 = sx / weight - x, my2 = sy / weight - y, mz2 = sz / weight - z;
      const distance = Math.hypot(mx2, my2, mz2);
      const scale = distance > limit[v] ? limit[v] / distance : 1;
      px += mx2 * scale;
      py += my2 * scale;
      pz += mz2 * scale;
    } else {
      free[v] = 1;
    }
    positions[3 * v] = px;
    positions[3 * v + 1] = py;
    positions[3 * v + 2] = pz;
  }
  // The vertices over sealed gaps are relaxed between their neighbours, so the patch blends in.
  const sum = new Float64Array(3 * vertexCount);
  const degree = new Uint16Array(vertexCount);
  for (let pass = 0; pass < 4; pass++) {
    sum.fill(0);
    degree.fill(0);
    for (let f = 0; f < faceCount; f++) {
      for (let e = 0; e < 4; e++) {
        const a = quads[4 * f + e];
        const b = quads[4 * f + ((e + 1) % 4)];
        if (free[a]) {
          sum[3 * a] += positions[3 * b];
          sum[3 * a + 1] += positions[3 * b + 1];
          sum[3 * a + 2] += positions[3 * b + 2];
          degree[a]++;
        }
        if (free[b]) {
          sum[3 * b] += positions[3 * a];
          sum[3 * b + 1] += positions[3 * a + 1];
          sum[3 * b + 2] += positions[3 * a + 2];
          degree[b]++;
        }
      }
    }
    for (let v = 0; v < vertexCount; v++) {
      if (!free[v] || degree[v] === 0) continue;
      positions[3 * v] = sum[3 * v] / degree[v];
      positions[3 * v + 1] = sum[3 * v + 1] / degree[v];
      positions[3 * v + 2] = sum[3 * v + 2] / degree[v];
    }
  }

  // --- Triangles and what they enclose. ---
  report(0.9, "Measuring the wrapped surface");
  const indices = new Uint32Array(6 * faceCount);
  for (let f = 0; f < faceCount; f++) {
    const a = quads[4 * f], b = quads[4 * f + 1], c = quads[4 * f + 2], d = quads[4 * f + 3];
    indices.set([a, b, c, a, c, d], 6 * f);
  }
  let volume = 0;
  let area = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < 3 * vertexCount; v++) {
    if (positions[v] < min[v % 3]) min[v % 3] = positions[v];
    if (positions[v] > max[v % 3]) max[v % 3] = positions[v];
  }
  // Silhouette from the front, on a grid of half a voxel.
  const pixel = 0.5 * h;
  const py0 = min[1] - pixel, pz0 = min[2] - pixel;
  const pw = Math.ceil((max[1] - py0) / pixel) + 2;
  const ph = Math.ceil((max[2] - pz0) / pixel) + 2;
  const silhouette = new Uint8Array(pw * ph);
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t], b = 3 * indices[t + 1], c = 3 * indices[t + 2];
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const ux = positions[b] - ax, uy = positions[b + 1] - ay, uz = positions[b + 2] - az;
    const vx = positions[c] - ax, vy = positions[c + 1] - ay, vz = positions[c + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += 0.5 * Math.hypot(cx, cy, cz);
    volume += (ax * cx + ay * cy + az * cz) / 6;
    const n = Math.max(Math.ceil(Math.max(Math.hypot(uy, uz), Math.hypot(vy, vz), Math.hypot(uy - vy, uz - vz)) / (0.5 * pixel)), 1);
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const y = ay + (uy * i + vy * j) / n;
        const z = az + (uz * i + vz * j) / n;
        silhouette[Math.floor((y - py0) / pixel) + pw * Math.floor((z - pz0) / pixel)] = 1;
      }
    }
  }
  let lit = 0;
  for (let c = 0; c < silhouette.length; c++) lit += silhouette[c];

  const fill = solidCount / referenceCount;
  const warnings: string[] = [];
  if (fill < 0.8) {
    warnings.push(
      `Air reached inside the model: this wrap holds ${Math.round(fill * 100)} % of the volume of a fully sealed one. ` +
        "Somewhere there is an opening wider than the sealing size (an open window, a grille without a radiator behind it). Seal larger gaps and wrap again.",
    );
  }
  report(1, "Done");
  return {
    positions,
    indices,
    voxel: h,
    seal,
    vertices: vertexCount,
    triangles: indices.length / 3,
    volume,
    area,
    frontalArea: lit * pixel * pixel,
    min,
    max,
    fill,
    warnings,
  };
}

/** Number of edges of an indexed triangle mesh that are not shared by an even number of triangles (0 = closed). */
export function countOpenEdges(indices: Uint32Array): number {
  const uses = new Map<number, number>();
  // Vertex ids fit in 26 bits for any wrap this module produces, so a pair packs into one safe integer.
  const key = (a: number, b: number) => (a < b ? a * 67108864 + b : b * 67108864 + a);
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = key(indices[t + e], indices[t + ((e + 1) % 3)]);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of uses.values()) if (count % 2 === 1) open++;
  return open;
}

/** The wrapped surface as a triangle soup (9 numbers per triangle), the form the CFD backend takes. */
export function wrapToSoup(wrap: Pick<WrappedSurface, "positions" | "indices">): Float32Array {
  const out = new Float32Array(3 * wrap.indices.length);
  for (let i = 0; i < wrap.indices.length; i++) {
    const v = 3 * wrap.indices[i];
    out[3 * i] = wrap.positions[v];
    out[3 * i + 1] = wrap.positions[v + 1];
    out[3 * i + 2] = wrap.positions[v + 2];
  }
  return out;
}
