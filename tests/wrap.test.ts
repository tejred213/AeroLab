/**
 * Shrink-wrapping loose geometry into a closed surface. The shapes are simple
 * enough that the right answer is known: closed, the right volume, the right
 * silhouette, gaps sealed up to the sealing size and no further.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guessOrientation, orientMesh } from "@/lib/geometry/meshImport";
import { computeMetrics } from "@/lib/geometry/metrics";
import { overallLength } from "@/lib/geometry/parameters";
import { buildBodyShape } from "@/lib/geometry/profile";
import { countOpenEdges, wrapModel, wrapToSoup } from "@/lib/geometry/wrap";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { parametricSoup } from "./meshSoup";
import { readGlbParts, SAMPLE_FILE } from "./sampleModel";

type Box = [number, number, number, number, number, number];

/** The six faces of a box as separate rectangles, each pulled in from the edges by `gap` (0 = they meet). */
function panels([x0, x1, y0, y1, z0, z1]: Box, gap = 0, skip: number[] = []): Float32Array {
  const g = gap;
  const faces: number[][][] = [
    [[x0, y0 + g, z0 + g], [x0, y1 - g, z0 + g], [x0, y1 - g, z1 - g], [x0, y0 + g, z1 - g]],
    [[x1, y0 + g, z0 + g], [x1, y1 - g, z0 + g], [x1, y1 - g, z1 - g], [x1, y0 + g, z1 - g]],
    [[x0 + g, y0, z0 + g], [x1 - g, y0, z0 + g], [x1 - g, y0, z1 - g], [x0 + g, y0, z1 - g]],
    [[x0 + g, y1, z0 + g], [x1 - g, y1, z0 + g], [x1 - g, y1, z1 - g], [x0 + g, y1, z1 - g]],
    [[x0 + g, y0 + g, z0], [x1 - g, y0 + g, z0], [x1 - g, y1 - g, z0], [x0 + g, y1 - g, z0]],
    [[x0 + g, y0 + g, z1], [x1 - g, y0 + g, z1], [x1 - g, y1 - g, z1], [x0 + g, y1 - g, z1]],
  ];
  const out: number[] = [];
  faces.forEach(([a, b, c, d], index) => {
    if (!skip.includes(index)) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  });
  return new Float32Array(out);
}

function join(...soups: Float32Array[]): Float32Array {
  const out = new Float32Array(soups.reduce((sum, soup) => sum + soup.length, 0));
  let offset = 0;
  for (const soup of soups) {
    out.set(soup, offset);
    offset += soup.length;
  }
  return out;
}

const BOX: Box = [0, 0.6, -0.2, 0.2, 0.1, 0.4];
const BOX_VOLUME = 0.6 * 0.4 * 0.3;

describe("wrapping simple shapes", () => {
  it("turns a box into a closed surface of the right size", () => {
    const wrap = wrapModel(panels(BOX), { voxel: 0.01, seal: 0 });
    expect(countOpenEdges(wrap.indices)).toBe(0);
    expect(wrap.triangles).toBe(wrap.indices.length / 3);
    expect(wrap.positions.length).toBe(3 * wrap.vertices);
    expect(Math.abs(wrap.volume / BOX_VOLUME - 1)).toBeLessThan(0.06);
    expect(Math.abs(wrap.frontalArea / (0.4 * 0.3) - 1)).toBeLessThan(0.06);
    expect(Math.abs(wrap.area / (2 * (0.6 * 0.4 + 0.6 * 0.3 + 0.4 * 0.3)) - 1)).toBeLessThan(0.1);
    BOX.forEach((value, index) => {
      const found = index % 2 === 0 ? wrap.min[index >> 1] : wrap.max[index >> 1];
      expect(Math.abs(found - value)).toBeLessThan(0.011);
    });
    expect(wrap.fill).toBeGreaterThan(0.95);
    expect(wrap.warnings).toEqual([]);
    expect(wrapToSoup(wrap).length).toBe(9 * wrap.triangles);
  });

  it("does not care how the triangles are wound or how often they are repeated", () => {
    const soup = panels(BOX);
    const flipped = new Float32Array(soup.length);
    for (let t = 0; t < soup.length; t += 9) {
      flipped.set(soup.subarray(t, t + 3), t);
      flipped.set(soup.subarray(t + 6, t + 9), t + 3);
      flipped.set(soup.subarray(t + 3, t + 6), t + 6);
    }
    const plain = wrapModel(soup, { voxel: 0.01, seal: 0 });
    const doubled = wrapModel(join(soup, flipped), { voxel: 0.01, seal: 0 });
    expect(doubled.volume).toBeCloseTo(plain.volume, 6);
    expect(doubled.triangles).toBe(plain.triangles);
  });

  it("seals the gaps between loose panels", () => {
    // Six separate sheets with a gap of about 14 mm along every edge: nothing closed at all.
    const wrap = wrapModel(panels(BOX, 0.01), { voxel: 0.01, seal: 0.03 });
    expect(countOpenEdges(wrap.indices)).toBe(0);
    expect(Math.abs(wrap.volume / BOX_VOLUME - 1)).toBeLessThan(0.08);
    expect(wrap.fill).toBeGreaterThan(0.95);
    expect(wrap.warnings).toEqual([]);
  });

  it("lets the air in through an opening wider than the sealing size, and says so", () => {
    // A box without its front face: hollow, open to the air.
    const open = panels(BOX, 0, [0]);
    const leaky = wrapModel(open, { voxel: 0.01, seal: 0.03 });
    expect(countOpenEdges(leaky.indices)).toBe(0);
    expect(leaky.volume).toBeLessThan(0.4 * BOX_VOLUME);
    expect(leaky.fill).toBeLessThan(0.8);
    expect(leaky.warnings.join(" ")).toMatch(/Air reached inside/);
    // Sealing gaps up to the size of the opening closes it.
    const sealed = wrapModel(open, { voxel: 0.01, seal: 0.45 });
    expect(Math.abs(sealed.volume / BOX_VOLUME - 1)).toBeLessThan(0.1);
    expect(sealed.warnings).toEqual([]);
  });

  it("gives a thin sheet a thickness instead of collapsing it", () => {
    const sheet = panels([0, 0.5, -0.15, 0.15, 0.3, 0.3], 0, [0, 1, 2, 3, 4]);
    const wrap = wrapModel(sheet, { voxel: 0.01, seal: 0 });
    expect(countOpenEdges(wrap.indices)).toBe(0);
    // About 0.3 of a voxel is kept between the two faces: 0.5 m x 0.3 m x 3 mm at least.
    expect(wrap.volume).toBeGreaterThan(0.5 * 0.3 * 0.002);
    expect(wrap.volume).toBeLessThan(0.5 * 0.3 * 0.012);
  });

  it("wraps separate bodies separately", () => {
    const second: Box = [1.0, 1.3, -0.1, 0.1, 0.1, 0.3];
    const wrap = wrapModel(join(panels(BOX), panels(second)), { voxel: 0.01, seal: 0.02 });
    expect(countOpenEdges(wrap.indices)).toBe(0);
    expect(Math.abs(wrap.volume / (BOX_VOLUME + 0.3 * 0.2 * 0.2) - 1)).toBeLessThan(0.07);
  });

  it("refuses an empty model, a meaningless voxel and a grid that would be too large", () => {
    expect(() => wrapModel(new Float32Array(0))).toThrow(/no triangles/);
    expect(() => wrapModel(panels(BOX), { voxel: 0.5 })).toThrow(/voxel size/);
    expect(() => wrapModel(panels([0, 6, -1.5, 1.5, 0, 2.5]), { voxel: 0.004 })).toThrow(/million voxels/);
  });
});

describe("wrapping a car", () => {
  it("encloses the parametric sedan with its wheels: closed, the right length and silhouette", () => {
    const geometry = { ...getBuiltInVehicle("sedan").geometry, mirrorWidth: 0 };
    const wrap = wrapModel(parametricSoup(geometry), { voxel: 0.02, seal: 0.04 });
    expect(countOpenEdges(wrap.indices)).toBe(0);
    expect(Math.abs(wrap.max[0] - wrap.min[0] - overallLength(geometry))).toBeLessThan(0.03);
    expect(Math.abs(wrap.max[1] - wrap.min[1] - geometry.width)).toBeLessThan(0.03);
    expect(wrap.min[2]).toBeLessThan(0.02);
    const area = computeMetrics(buildBodyShape(geometry)).frontalArea;
    expect(Math.abs(wrap.frontalArea / area - 1)).toBeLessThan(0.03);
    expect(wrap.fill).toBeGreaterThan(0.85);
    expect(wrap.warnings).toEqual([]);
  });

  it("keeps the door mirrors of the bundled sample model, which the solver envelope drops", () => {
    const stored = new Uint8Array(readFileSync(fileURLToPath(new URL(`../public/cars/${SAMPLE_FILE}`, import.meta.url))));
    const parts = readGlbParts(stored).filter((part) => part.name !== "ground_shadow");
    // As in the app: the file's triangles are turned into tunnel coordinates before they are wrapped.
    const soupOf = (keep: (name: string) => boolean) => {
      const file = join(...parts.filter((part) => keep(part.name)).map((part) => part.triangles));
      return orientMesh(file, guessOrientation(file, true)).positions;
    };
    const all = wrapModel(soupOf(() => true), { voxel: 0.02, seal: 0.04 });
    const bare = wrapModel(soupOf((name) => !name.startsWith("mirror")), { voxel: 0.02, seal: 0.04 });
    expect(countOpenEdges(all.indices)).toBe(0);
    // The sample's mirrors stick out 0.17 m a side and are 0.12 m tall.
    expect(all.max[0] - all.min[0]).toBeCloseTo(bare.max[0] - bare.min[0], 1);
    expect(all.max[1] - all.min[1] - (bare.max[1] - bare.min[1])).toBeGreaterThan(0.28);
    expect(all.frontalArea - bare.frontalArea).toBeGreaterThan(0.6 * 2 * 0.17 * 0.12);
    expect(all.frontalArea - bare.frontalArea).toBeLessThan(1.6 * 2 * 0.17 * 0.12);
  });
});
