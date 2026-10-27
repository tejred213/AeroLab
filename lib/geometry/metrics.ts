/**
 * Integral properties of the generated geometry (areas, clearances).
 * backend/geometry/metrics.py mirrors this file.
 */
import type { GeometryMetrics } from "@/lib/types";
import { DEG_TO_RAD, MODEL, RAD_TO_DEG } from "@/lib/physics/model";
import {
  type BodyShape,
  sampleStations,
  stationHalfWidth,
  mirrorGeometry,
  skirtGeometry,
  splitterGeometry,
  spoilerGeometry,
  wheelGeometry,
  wingGeometry,
} from "@/lib/geometry/profile";

const STATION_COUNT = 96;
const ROW_HEIGHT = 0.004;

/** Total length of the union of [start, end] intervals. */
function unionLength(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [currentStart, currentEnd] = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    if (start > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }
  return total + (currentEnd - currentStart);
}

/** Effective rear slope: roof trailing edge to the tail edge, in degrees. */
export function effectiveSlantDeg(shape: BodyShape): number {
  const drop = Math.max(shape.roofEdgeHeight - shape.deckHeight, 0);
  const run = shape.length - shape.xRoofEnd;
  if (run <= 1e-6) return 90;
  return Math.atan2(drop, run) * RAD_TO_DEG;
}

export function computeMetrics(shape: BodyShape): GeometryMetrics {
  const { params, length } = shape;
  const ride = params.rideHeight;

  const xs = new Float64Array(STATION_COUNT + 1);
  for (let i = 0; i <= STATION_COUNT; i++) xs[i] = (length * i) / STATION_COUNT;
  const stations = sampleStations(shape, xs);

  const spoiler = spoilerGeometry(shape);
  const wing = wingGeometry(shape);
  const splitter = splitterGeometry(shape);
  const skirt = skirtGeometry(shape);
  const mirror = mirrorGeometry(shape);
  const wheels = wheelGeometry(shape);

  // --- Frontal area: project every solid onto the Y-Z plane, row by row. ---
  const wingAngle = wing.angleDeg * DEG_TO_RAD;
  const wingProjected = wing.chord * Math.abs(Math.sin(wingAngle)) + wing.thickness * Math.cos(wingAngle);
  let top = ride + params.roofHeight;
  if (spoiler.present) top = Math.max(top, ride + spoiler.z1 + spoiler.thickness);
  if (wing.present) top = Math.max(top, ride + wing.zc + wingProjected / 2);

  const rows = Math.ceil(top / ROW_HEIGHT);
  let frontalArea = 0;
  for (let r = 0; r < rows; r++) {
    const z = (r + 0.5) * ROW_HEIGHT;
    const zb = z - ride;
    const intervals: [number, number][] = [];

    let bodyHalfWidth = 0;
    for (let i = 0; i <= STATION_COUNT; i++) {
      const w = stationHalfWidth(shape, xs[i], stations.zLow[i], stations.zUp[i], stations.plan[i], zb);
      if (w > bodyHalfWidth) bodyHalfWidth = w;
    }
    if (bodyHalfWidth > 0) intervals.push([0, bodyHalfWidth]);

    const wheel = wheels[0];
    if (z <= 2 * wheel.radius) intervals.push([wheel.y - wheel.width / 2, wheel.y + wheel.width / 2]);
    if (spoiler.present && zb >= spoiler.z0 && zb <= spoiler.z1 + spoiler.thickness) {
      intervals.push([0, spoiler.halfWidth]);
    }
    if (wing.present && Math.abs(zb - wing.zc) <= wingProjected / 2) {
      intervals.push([0, wing.span / 2]);
    }
    if (skirt.present && zb >= -skirt.depth && zb <= 0) {
      intervals.push([skirt.yOuter - skirt.thickness, skirt.yOuter]);
    }
    if (splitter.present && zb >= 0 && zb <= splitter.thickness) {
      intervals.push([0, splitter.halfWidth]);
    }
    if (mirror.present && zb >= mirror.z0 && zb <= mirror.z1) {
      intervals.push([mirror.y0, mirror.y1]);
    }
    frontalArea += unionLength(intervals) * ROW_HEIGHT;
  }
  frontalArea *= 2;

  // --- Side area, its centroid, and wetted area (upper surface and flanks). ---
  let sideArea = 0;
  let sideMoment = 0;
  let wetted = 0;
  const dx = length / STATION_COUNT;
  for (let i = 0; i <= STATION_COUNT; i++) {
    const weight = i === 0 || i === STATION_COUNT ? 0.5 : 1;
    const height = Math.max(stations.zUp[i] - stations.zLow[i], 0);
    sideArea += weight * height * dx;
    sideMoment += weight * height * dx * xs[i];
    wetted += weight * (2 * height + 2 * stations.plan[i]) * dx;
  }
  // Tyre segments visible below the floor (two wheels per side view).
  const radius = params.wheelDiameter / 2;
  const exposed = Math.min(ride, radius);
  const segment =
    radius * radius * Math.acos((radius - exposed) / radius) -
    (radius - exposed) * Math.sqrt(Math.max(2 * radius * exposed - exposed * exposed, 0));
  sideArea += 2 * segment;
  sideMoment += segment * (shape.frontAxleX + shape.rearAxleX);

  return {
    length,
    overallHeight: top,
    frontalArea,
    sideArea,
    sideAreaCentroidX: sideMoment / sideArea,
    wettedArea: MODEL.drag.wettedAreaFactor * wetted,
    groundClearance: ride - (skirt.present ? skirt.depth : 0),
    roofLength: shape.xRoofEnd - shape.xRoofStart,
    trackWidth: 2 * shape.wheelCentreY,
    effectiveSlantDeg: effectiveSlantDeg(shape),
  };
}
