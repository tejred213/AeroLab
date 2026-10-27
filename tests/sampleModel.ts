/**
 * The bundled sample model: the simulator's own generic fastback written out as
 * a binary glTF file, the way a downloaded car model arrives (Y-up, nose toward
 * +Z, separate parts with materials, door mirrors, and a ground-shadow sheet).
 *
 * It exists so the 3D-model import can be tried and tested without any external
 * file, on a shape whose answer is known. It is not a model of a real car.
 */
import { buildBodyMesh } from "@/lib/geometry/mesh";
import { buildBodyShape, planHalfWidth, wheelGeometry } from "@/lib/geometry/profile";
import { getBuiltInVehicle } from "@/lib/vehicle/library";

export const SAMPLE_VEHICLE_ID = "fastback";
export const SAMPLE_FILE = "sample-fastback.glb";

interface Part {
  name: string;
  material: number;
  /** Tunnel coordinates, xyz per vertex. */
  positions: number[];
  indices: number[];
  /** Smooth shading across shared vertices; otherwise every triangle is flat. */
  smooth: boolean;
}

const MATERIALS = [
  { name: "paint", pbrMetallicRoughness: { baseColorFactor: [0.5, 0.035, 0.05, 1], metallicFactor: 0.65, roughnessFactor: 0.28 } },
  { name: "glass", pbrMetallicRoughness: { baseColorFactor: [0.03, 0.045, 0.06, 1], metallicFactor: 0.1, roughnessFactor: 0.06 } },
  { name: "tyre", pbrMetallicRoughness: { baseColorFactor: [0.02, 0.02, 0.022, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: "rim", pbrMetallicRoughness: { baseColorFactor: [0.75, 0.77, 0.8, 1], metallicFactor: 0.9, roughnessFactor: 0.3 } },
  { name: "shadow", alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 0.35], metallicFactor: 0, roughnessFactor: 1 } },
];
const [PAINT, GLASS, TYRE, RIM, SHADOW] = [0, 1, 2, 3, 4];

function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): { positions: number[]; indices: number[] } {
  const positions = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { positions, indices };
}

/** A cylinder along the Y axis (an axle), closed at both ends. */
function cylinder(x: number, y: number, z: number, radius: number, width: number, segments = 48): { positions: number[]; indices: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    const a = (2 * Math.PI * s) / segments;
    for (const side of [-0.5, 0.5]) positions.push(x + radius * Math.cos(a), y + side * width, z + radius * Math.sin(a));
  }
  const centre = positions.length / 3;
  positions.push(x, y - 0.5 * width, z, x, y + 0.5 * width, z);
  for (let s = 0; s < segments; s++) {
    const a = 2 * s;
    const b = 2 * ((s + 1) % segments);
    indices.push(a, b, b + 1, a, b + 1, a + 1, centre, b, a, centre + 1, a + 1, b + 1);
  }
  return { positions, indices };
}

function sampleParts(): Part[] {
  const geometry = getBuiltInVehicle(SAMPLE_VEHICLE_ID).geometry;
  const shape = buildBodyShape(geometry);
  const mesh = buildBodyMesh(shape);
  const paint: number[] = [];
  const glass: number[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    (mesh.glass[a] > 0.5 && mesh.glass[b] > 0.5 && mesh.glass[c] > 0.5 ? glass : paint).push(a, b, c);
  }
  const body = Array.from(mesh.positions);
  const parts: Part[] = [
    { name: "body_paint", material: PAINT, positions: body, indices: paint, smooth: true },
    { name: "body_glass", material: GLASS, positions: body, indices: glass, smooth: true },
  ];
  for (const [index, wheel] of wheelGeometry(shape).entries()) {
    for (const side of [1, -1]) {
      const label = `${index === 0 ? "front" : "rear"}_${side > 0 ? "left" : "right"}`;
      parts.push({ name: `tyre_${label}`, material: TYRE, smooth: false, ...cylinder(wheel.x, side * wheel.y, wheel.z, wheel.radius, wheel.width) });
      const face = side * (wheel.y + 0.5 * wheel.width + 0.003);
      parts.push({ name: `rim_${label}`, material: RIM, smooth: false, ...cylinder(wheel.x, face, wheel.z, 0.62 * wheel.radius, 0.008, 24) });
    }
  }
  // Door mirrors: the kind of attachment the measurement has to ignore.
  const xMirror = geometry.frontOverhang + 0.45 * geometry.wheelbase - 0.55;
  const zMirror = geometry.rideHeight + geometry.beltHeight + 0.02;
  for (const side of [1, -1]) {
    const inner = side * (planHalfWidth(shape, xMirror) - 0.03);
    const outer = side * (planHalfWidth(shape, xMirror) + 0.17);
    parts.push({
      name: `mirror_${side > 0 ? "left" : "right"}`,
      material: PAINT,
      smooth: false,
      ...box(xMirror, xMirror + 0.11, Math.min(inner, outer), Math.max(inner, outer), zMirror, zMirror + 0.12),
    });
  }
  // A shadow sheet under the car, larger than the car: it must be left out of the measurement.
  parts.push({
    name: "ground_shadow",
    material: SHADOW,
    smooth: false,
    positions: [-0.6, -1.5, 0.001, shape.length + 0.6, -1.5, 0.001, shape.length + 0.6, 1.5, 0.001, -0.6, 1.5, 0.001],
    indices: [0, 1, 2, 0, 2, 3],
  });
  return parts;
}

/** Tunnel coordinates to the file's frame: Y up, nose toward +Z (a rotation, not a mirror image). */
function toFile(x: number, y: number, z: number): [number, number, number] {
  return [-y, z, -x];
}

function vertexData(part: Part): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  let positions: number[] = [];
  let indices: number[] = [];
  if (part.smooth) {
    // Keep only the vertices this part uses.
    const remap = new Map<number, number>();
    for (const index of part.indices) {
      if (!remap.has(index)) {
        remap.set(index, positions.length / 3);
        positions.push(...toFile(part.positions[3 * index], part.positions[3 * index + 1], part.positions[3 * index + 2]));
      }
      indices.push(remap.get(index)!);
    }
  } else {
    for (const index of part.indices) {
      indices.push(positions.length / 3);
      positions.push(...toFile(part.positions[3 * index], part.positions[3 * index + 1], part.positions[3 * index + 2]));
    }
  }
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [3 * indices[i], 3 * indices[i + 1], 3 * indices[i + 2]];
    const u = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const v = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const o of [a, b, c]) for (let k = 0; k < 3; k++) normals[o + k] += n[k];
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    for (let k = 0; k < 3; k++) normals[i + k] /= length;
  }
  return { positions: new Float32Array(positions), normals, indices: new Uint32Array(indices) };
}

/** The sample model as the bytes of a .glb file. Deterministic. */
export function buildSampleGlb(): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let offset = 0;
  const add = (data: Float32Array | Uint32Array, target: number, accessor: object): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    offset += bytes.length;
    accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
    return accessors.length - 1;
  };

  const meshes: object[] = [];
  const nodes: object[] = [];
  for (const part of sampleParts()) {
    const { positions, normals, indices } = vertexData(part);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], positions[i]);
      max[i % 3] = Math.max(max[i % 3], positions[i]);
    }
    const count = positions.length / 3;
    const position = add(positions, 34962, { componentType: 5126, count, type: "VEC3", min, max });
    const normal = add(normals, 34962, { componentType: 5126, count, type: "VEC3" });
    const index = add(indices, 34963, { componentType: 5125, count: indices.length, type: "SCALAR" });
    meshes.push({ name: part.name, primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index, material: part.material }] });
    nodes.push({ name: part.name, mesh: meshes.length - 1 });
  }

  const json = {
    asset: { version: "2.0", generator: "AeroLab sample model (generic fastback, not a real car)" },
    scene: 0,
    scenes: [{ name: "AeroLab generic fastback", nodes: nodes.map((_, index) => index) }],
    nodes,
    meshes,
    materials: MATERIALS,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.length + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  let cursor = 20 + jsonBytes.length;
  view.setUint32(cursor, offset, true);
  view.setUint32(cursor + 4, 0x004e4942, true);
  cursor += 8;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/** Reads the parts of a .glb written by buildSampleGlb back as triangle soups in the file's coordinates. */
export function readGlbParts(bytes: Uint8Array): { name: string; triangles: Float32Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const binary = 20 + jsonLength + 8;
  const read = (accessorIndex: number): { offset: number; count: number } => {
    const accessor = json.accessors[accessorIndex];
    return { offset: binary + json.bufferViews[accessor.bufferView].byteOffset, count: accessor.count };
  };
  return json.nodes.map((node: { name: string; mesh: number }) => {
    const primitive = json.meshes[node.mesh].primitives[0];
    const position = read(primitive.attributes.POSITION);
    const index = read(primitive.indices);
    const triangles = new Float32Array(index.count * 3);
    for (let i = 0; i < index.count; i++) {
      const vertex = view.getUint32(index.offset + 4 * i, true);
      for (let k = 0; k < 3; k++) triangles[3 * i + k] = view.getFloat32(position.offset + 12 * vertex + 4 * k, true);
    }
    return { name: node.name, triangles };
  });
}
