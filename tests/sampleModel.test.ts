/** The bundled sample model: the stored file is current, and importing it recovers the fastback it was made from. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fitGeometry, guessOrientation, measureModel, orientMesh } from "@/lib/geometry/meshImport";
import { overallLength } from "@/lib/geometry/parameters";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { buildSampleGlb, readGlbParts, SAMPLE_FILE, SAMPLE_VEHICLE_ID } from "./sampleModel";

const stored = new Uint8Array(readFileSync(fileURLToPath(new URL(`../public/cars/${SAMPLE_FILE}`, import.meta.url))));

function soupOf(parts: { name: string; triangles: Float32Array }[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.triangles.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part.triangles, offset);
    offset += part.triangles.length;
  }
  return out;
}

describe("bundled sample model", () => {
  it("is the file the generator writes (run `npm run golden` after changing it)", () => {
    expect(Buffer.from(stored).equals(Buffer.from(buildSampleGlb()))).toBe(true);
  });

  it("measures as the fastback it was made from once the shadow sheet is left out", () => {
    const geometry = getBuiltInVehicle(SAMPLE_VEHICLE_ID).geometry;
    const parts = readGlbParts(stored);
    expect(parts.map((part) => part.name)).toContain("ground_shadow");
    const soup = soupOf(parts.filter((part) => part.name !== "ground_shadow"));
    const oriented = orientMesh(soup, guessOrientation(soup, true));
    const measured = measureModel(oriented.positions, "sample");
    expect(measured.length).toBeCloseTo(overallLength(geometry), 2);
    // The door mirrors stick out 0.17 m a side and are not part of the envelope.
    expect(Math.abs(measured.width - geometry.width)).toBeLessThan(0.02);
    expect(measured.wheels).not.toBeNull();
    expect(Math.abs(measured.wheels!.rearAxleX - measured.wheels!.frontAxleX - geometry.wheelbase)).toBeLessThan(0.03);
    const fitted = fitGeometry(measured, geometry).geometry;
    expect(Math.abs(fitted.roofHeight - geometry.roofHeight)).toBeLessThan(0.02);
    expect(Math.abs(fitted.rideHeight - geometry.rideHeight)).toBeLessThan(0.015);
  });

  it("is mis-measured when the shadow sheet is left in, which is why sheets are excluded by default", () => {
    const soup = soupOf(readGlbParts(stored));
    const oriented = orientMesh(soup, guessOrientation(soup, true));
    expect(oriented.length).toBeGreaterThan(overallLength(getBuiltInVehicle(SAMPLE_VEHICLE_ID).geometry) + 1);
  });
});
