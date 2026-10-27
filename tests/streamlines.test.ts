/** Streamlines and the time of flight along them, which is what the animated pulses follow. */
import { beforeAll, describe, expect, it } from "vitest";
import { overallLength } from "@/lib/geometry/parameters";
import { runLocal } from "@/lib/simulation/engine";
import type { FlowField } from "@/lib/simulation/field";
import { type Streamline, STREAMLINE_STEP, streamlineSeeds, traceStreamlines } from "@/lib/simulation/streamlines";
import { configFor } from "./helpers";

describe("streamlines", () => {
  let lines: Streamline[];
  let seedCount: number;

  beforeAll(() => {
    const config = configFor("fastback");
    const field = runLocal(config, true).field as FlowField;
    const window = {
      halfWidth: config.geometry.width / 2 + 0.9,
      height: config.geometry.rideHeight + config.geometry.roofHeight + 0.75,
      xStart: -2.8,
      xEnd: overallLength(config.geometry) + 6,
    };
    seedCount = streamlineSeeds(window.halfWidth, window.height).length;
    lines = traceStreamlines(field, window);
  });

  it("traces a line from most seeds, in steps of fixed length", () => {
    expect(lines.length).toBeGreaterThan(0.8 * seedCount);
    expect(lines.length).toBeLessThanOrEqual(seedCount);
    for (const line of lines) {
      expect(line.positions.length).toBe(3 * line.speeds.length);
      expect(line.travel.length).toBe(line.speeds.length);
      for (let i = 1; i < Math.min(line.speeds.length, 40); i++) {
        const step = Math.hypot(
          line.positions[3 * i] - line.positions[3 * i - 3],
          line.positions[3 * i + 1] - line.positions[3 * i - 2],
          line.positions[3 * i + 2] - line.positions[3 * i - 1],
        );
        expect(step).toBeGreaterThan(0.5 * STREAMLINE_STEP);
        expect(step).toBeLessThan(1.5 * STREAMLINE_STEP);
      }
    }
  });

  it("accumulates the time of flight: it only grows, by step over local speed", () => {
    for (const line of lines) {
      expect(line.travel[0]).toBe(0);
      for (let i = 1; i < line.travel.length; i++) expect(line.travel[i]).toBeGreaterThan(line.travel[i - 1]);
    }
    // Far upstream the flow is nearly undisturbed, so one step takes about one step of freestream travel.
    const upstream = lines.map((line) => line.travel[1]);
    for (const first of upstream) {
      expect(first).toBeGreaterThan(0.85 * STREAMLINE_STEP);
      expect(first).toBeLessThan(1.25 * STREAMLINE_STEP);
    }
  });

  it("lets pulses run faster where the air is faster and slower where it is slower", () => {
    let fastest = Infinity;
    let slowest = 0;
    for (const line of lines) {
      for (let i = 1; i < line.travel.length; i++) {
        const interval = line.travel[i] - line.travel[i - 1];
        fastest = Math.min(fastest, interval);
        slowest = Math.max(slowest, interval);
      }
    }
    // Over the roof the air is quicker than the freestream; ahead of the nose it is slower.
    expect(fastest).toBeLessThan(0.92 * STREAMLINE_STEP);
    expect(slowest).toBeGreaterThan(1.3 * STREAMLINE_STEP);
  });
});
