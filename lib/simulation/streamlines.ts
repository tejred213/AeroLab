/**
 * Streamlines of a flow field: curves tangent to the velocity, integrated from a
 * rake of seed points upstream of the car (midpoint rule, fixed arc-length step).
 * Pure data, no three.js.
 *
 * Besides its position and speed every point carries its travel: the distance
 * the undisturbed flow covers in the time the air needs to reach that point from
 * the seed. Travel divided by a speed is a time, which is what lets a drawing
 * move pulses along a line at the local flow speed.
 */
import { CELL_SOLID, CELL_WAKE, createFieldSample, type FlowField, sampleField } from "@/lib/simulation/field";

export interface Streamline {
  /** xyz per point. */
  positions: number[];
  /** Speed as a ratio to the freestream speed, per point. */
  speeds: number[];
  /** Freestream distance equivalent to the time of flight from the seed, m, per point. */
  travel: number[];
}

export interface StreamlineWindow {
  halfWidth: number;
  height: number;
  xStart: number;
  xEnd: number;
}

export const STREAMLINE_STEP = 0.05;
const MAX_STEPS = 420;

/** Seed points (y, z) at the upstream end of the window. */
export function streamlineSeeds(halfWidth: number, height: number): [number, number][] {
  const seeds: [number, number][] = [];
  // Dense fan in the symmetry plane, where the profile shapes the flow most clearly…
  for (let k = 0; k < 16; k++) seeds.push([0.02, 0.04 + height * Math.pow((k + 0.5) / 16, 1.25)]);
  // …plus rows at several heights across the width.
  for (const z of [0.08, 0.35, 0.7, 1.05, 1.4]) {
    for (let j = 1; j <= 6; j++) {
      const y = (halfWidth * j) / 6;
      seeds.push([y, z], [-y, z]);
    }
  }
  return seeds;
}

export function traceStreamlines(field: FlowField, window: StreamlineWindow): Streamline[] {
  const sample = createFieldSample();
  const lines: Streamline[] = [];
  for (const [seedY, seedZ] of streamlineSeeds(window.halfWidth, window.height)) {
    const line: Streamline = { positions: [], speeds: [], travel: [] };
    let x = window.xStart;
    let y = seedY;
    let z = seedZ;
    let travel = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      sampleField(field, x, y, z, sample);
      if (!sample.inside || sample.kind === CELL_SOLID) break;
      const speed = Math.sqrt(sample.u * sample.u + sample.v * sample.v + sample.w * sample.w);
      if (speed < 0.02) break;
      // Streamlines that enter the wake are ended there: its interior velocity is synthetic.
      if (sample.kind === CELL_WAKE && step > 4) break;
      line.positions.push(x, y, z);
      line.speeds.push(speed);
      line.travel.push(travel);
      // Midpoint step of fixed arc length.
      const mx = x + (0.5 * STREAMLINE_STEP * sample.u) / speed;
      const my = y + (0.5 * STREAMLINE_STEP * sample.v) / speed;
      const mz = Math.max(z + (0.5 * STREAMLINE_STEP * sample.w) / speed, 0.005);
      sampleField(field, mx, my, mz, sample);
      const midSpeed = Math.max(Math.sqrt(sample.u * sample.u + sample.v * sample.v + sample.w * sample.w), 1e-3);
      x += (STREAMLINE_STEP * sample.u) / midSpeed;
      y += (STREAMLINE_STEP * sample.v) / midSpeed;
      z = Math.max(z + (STREAMLINE_STEP * sample.w) / midSpeed, 0.005);
      // The step is covered at the speed found at its midpoint.
      travel += STREAMLINE_STEP / midSpeed;
      if (x > window.xEnd) break;
    }
    if (line.speeds.length >= 2) lines.push(line);
  }
  return lines;
}
