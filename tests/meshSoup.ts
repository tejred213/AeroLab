/**
 * Triangle soups for testing the 3D-model importer without any external file:
 * one of the simulator's own parametric cars, written out as a plain mesh the
 * way a model file would deliver it (body shell plus four wheels).
 */
import { buildBodyMesh } from "@/lib/geometry/mesh";
import { buildBodyShape, wheelGeometry } from "@/lib/geometry/profile";
import type { GeometryParams } from "@/lib/types";

function cylinder(x: number, y: number, z: number, radius: number, width: number, segments = 48): number[] {
  const out: number[] = [];
  const y0 = y - width / 2;
  const y1 = y + width / 2;
  for (let s = 0; s < segments; s++) {
    const a0 = (2 * Math.PI * s) / segments;
    const a1 = (2 * Math.PI * (s + 1)) / segments;
    const p0 = [x + radius * Math.cos(a0), z + radius * Math.sin(a0)];
    const p1 = [x + radius * Math.cos(a1), z + radius * Math.sin(a1)];
    // Tread.
    out.push(p0[0], y0, p0[1], p1[0], y0, p1[1], p1[0], y1, p1[1]);
    out.push(p0[0], y0, p0[1], p1[0], y1, p1[1], p0[0], y1, p0[1]);
    // Both sidewalls.
    out.push(x, y0, z, p1[0], y0, p1[1], p0[0], y0, p0[1]);
    out.push(x, y1, z, p0[0], y1, p0[1], p1[0], y1, p1[1]);
  }
  return out;
}

/** The parametric car as a triangle soup in tunnel coordinates (9 numbers per triangle). */
export function parametricSoup(geometry: GeometryParams): Float32Array {
  const shape = buildBodyShape(geometry);
  const mesh = buildBodyMesh(shape);
  const soup: number[] = [];
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i] * 3;
    soup.push(mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]);
  }
  for (const wheel of wheelGeometry(shape)) {
    for (const side of [1, -1]) soup.push(...cylinder(wheel.x, side * wheel.y, wheel.z, wheel.radius, wheel.width));
  }
  return new Float32Array(soup);
}

/** Applies a rotation that puts a tunnel-coordinate soup into a Y-up, nose-toward-+Z model frame, scaled. */
export function asModelFile(soup: Float32Array, scale: number, offset: [number, number, number]): Float32Array {
  const out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    // model X = -tunnel Y, model Y = tunnel Z (up), model Z = -tunnel X (nose forward): a rotation, not a mirror image.
    out[i] = -soup[i + 1] * scale + offset[0];
    out[i + 1] = soup[i + 2] * scale + offset[1];
    out[i + 2] = -soup[i] * scale + offset[2];
  }
  return out;
}
