/**
 * Surface mesh of the body, lofted through cross-sections of the geometry kernel.
 * Pure data (typed arrays): no three.js dependency, so it can run in a worker
 * and be unit-tested. Coordinates are absolute (ground at z = 0).
 */
import { MODEL } from "@/lib/physics/model";
import { type BodyShape, lowerZ, planHalfWidth, stationHalfWidth, upperZ } from "@/lib/geometry/profile";

export interface BodyMesh {
  /** xyz per vertex, absolute coordinates. */
  positions: Float32Array;
  indices: Uint32Array;
  /** 1 where the vertex belongs to glazing, 0 for painted body. */
  glass: Float32Array;
  /** Number of longitudinal stations and vertices per ring (for consumers that need the structure). */
  stationCount: number;
  ringSize: number;
}

/** Ring points per side: below and above the beltline (the paint / glazing boundary). */
const LOWER_POINTS = 8;
const UPPER_POINTS = 8;
const SIDE_POINTS = LOWER_POINTS + UPPER_POINTS;
const STATION_SPACING = 0.05;
const NOSE_STATIONS = 9;
/** Gap between the last painted and the first glazed vertex at the beltline, m. */
const BELT_GAP = 0.012;

/** Longitudinal stations: clustered in the rounded nose, with tight pairs where glazing starts and ends. */
export function meshStations(shape: BodyShape): number[] {
  const noseEnd = MODEL.profile.noseRadiusUpper;
  const xs: number[] = [];
  for (let k = 0; k < NOSE_STATIONS; k++) {
    const t = k / NOSE_STATIONS;
    xs.push(noseEnd * t * t);
  }
  const remaining = shape.length - noseEnd;
  const count = Math.max(Math.round(remaining / STATION_SPACING), 8);
  for (let k = 0; k <= count; k++) xs.push(noseEnd + (remaining * k) / count);
  for (const edge of glazingEdges(shape)) {
    if (edge > noseEnd + 0.02 && edge < shape.length - 0.02) xs.push(edge - 0.006, edge + 0.006);
  }
  xs.sort((a, b) => a - b);
  return xs.filter((x, index) => index === 0 || x - xs[index - 1] > 1e-4);
}

/** Stations where the windshield and the rear window begin and end. */
function glazingEdges(shape: BodyShape): number[] {
  return [shape.xCowl + 0.08, shape.xRoofStart - 0.02, shape.xRoofEnd + 0.02, shape.xDeckStart - 0.08];
}

export function buildBodyMesh(shape: BodyShape): BodyMesh {
  const { params } = shape;
  const ride = params.rideHeight;
  const xs = meshStations(shape);
  const stationCount = xs.length;
  const ringSize = 2 * SIDE_POINTS + 2;
  // Body rings + a duplicated last ring and a centre vertex for the flat tail cap.
  const vertexCount = stationCount * ringSize + ringSize + 1;
  const positions = new Float32Array(vertexCount * 3);
  const glass = new Float32Array(vertexCount);

  const [screenStart, screenEnd, backlightStart, backlightEnd] = glazingEdges(shape);
  const sideZ = new Float64Array(SIDE_POINTS);
  const sideY = new Float64Array(SIDE_POINTS);
  const sideGlass = new Float32Array(SIDE_POINTS);

  for (let i = 0; i < stationCount; i++) {
    const x = xs[i];
    const zl = lowerZ(shape, x);
    const zu = Math.max(upperZ(shape, x), zl);
    const wb = planHalfWidth(shape, x);
    // The ring always has a vertex pair at the beltline, so the paint / glazing edge is straight.
    const split = Math.min(Math.max(params.beltHeight, zl), zu);
    const upperStart = Math.min(split + BELT_GAP, zu);

    const onScreen = x > screenStart && x < screenEnd;
    const onBacklight = x > backlightStart && x < backlightEnd;
    const inCabin = x > screenStart && x < backlightEnd;

    for (let j = 0; j < LOWER_POINTS; j++) {
      const t = j / (LOWER_POINTS - 1);
      sideZ[j] = zl + ((split - zl) * (1 - Math.cos(Math.PI * t))) / 2;
      sideGlass[j] = 0;
    }
    for (let j = 0; j < UPPER_POINTS; j++) {
      const t = j / (UPPER_POINTS - 1);
      // Clustered toward the roof edge, where the section is rounded.
      sideZ[LOWER_POINTS + j] = upperStart + (zu - upperStart) * Math.sin((Math.PI * t) / 2);
      // Side glass stops short of the roof; the windshield and rear window run over the top.
      sideGlass[LOWER_POINTS + j] = inCabin && zu - split > 0.05 && (onScreen || onBacklight || t < 0.7) ? 1 : 0;
    }
    for (let j = 0; j < SIDE_POINTS; j++) sideY[j] = stationHalfWidth(shape, x, zl, zu, wb, sideZ[j]);

    const base = i * ringSize;
    const put = (slot: number, y: number, z: number, glazed: number) => {
      const v = (base + slot) * 3;
      positions[v] = x;
      positions[v + 1] = y;
      positions[v + 2] = z + ride;
      glass[base + slot] = glazed;
    };
    put(0, 0, zl, 0);
    for (let j = 0; j < SIDE_POINTS; j++) put(1 + j, sideY[j], sideZ[j], sideGlass[j]);
    put(SIDE_POINTS + 1, 0, zu, (onScreen || onBacklight) && zu - split > 0.05 ? 1 : 0);
    for (let j = 0; j < SIDE_POINTS; j++) {
      const k = SIDE_POINTS - 1 - j;
      put(SIDE_POINTS + 2 + j, -sideY[k], sideZ[k], sideGlass[k]);
    }
  }

  // Tail cap: duplicate the last ring so the base has its own (flat) normals.
  const lastRing = (stationCount - 1) * ringSize;
  const capRing = stationCount * ringSize;
  const capCentre = capRing + ringSize;
  let centreZ = 0;
  for (let r = 0; r < ringSize; r++) {
    for (let c = 0; c < 3; c++) positions[(capRing + r) * 3 + c] = positions[(lastRing + r) * 3 + c];
    centreZ += positions[(lastRing + r) * 3 + 2];
  }
  positions[capCentre * 3] = shape.length;
  positions[capCentre * 3 + 1] = 0;
  positions[capCentre * 3 + 2] = centreZ / ringSize;

  const quadCount = (stationCount - 1) * ringSize;
  const indices = new Uint32Array(quadCount * 6 + ringSize * 3);
  let n = 0;
  for (let i = 0; i < stationCount - 1; i++) {
    const a = i * ringSize;
    const b = a + ringSize;
    for (let r = 0; r < ringSize; r++) {
      const r1 = (r + 1) % ringSize;
      indices[n++] = a + r;
      indices[n++] = a + r1;
      indices[n++] = b + r;
      indices[n++] = a + r1;
      indices[n++] = b + r1;
      indices[n++] = b + r;
    }
  }
  for (let r = 0; r < ringSize; r++) {
    indices[n++] = capCentre;
    indices[n++] = capRing + r;
    indices[n++] = capRing + ((r + 1) % ringSize);
  }

  return { positions, indices, glass, stationCount, ringSize };
}

/** Side-view outline of the body (upper and lower curves) in absolute coordinates, for 2D drawings. */
export function sideOutline(shape: BodyShape, samples = 120): { x: number; zUp: number; zLow: number }[] {
  const outline: { x: number; zUp: number; zLow: number }[] = [];
  const ride = shape.params.rideHeight;
  for (let i = 0; i <= samples; i++) {
    // Square-root spacing near the nose resolves its rounding.
    const t = i / samples;
    const x = shape.length * (t < 0.1 ? 10 * t * t : t);
    outline.push({ x, zUp: upperZ(shape, x) + ride, zLow: lowerZ(shape, x) + ride });
  }
  return outline;
}
