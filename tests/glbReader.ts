/**
 * Minimal reader for uncompressed .glb files: the world-space triangles of every
 * mesh node, 9 numbers per triangle. Enough to put a downloaded model through
 * the measuring code from the command line (see realModel.test.ts); the app
 * itself reads models with three.js.
 */
import { readFileSync } from "node:fs";

type Matrix = number[]; // column-major 4 x 4

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

function localMatrix(node: GltfNode): Matrix {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export function readGlbTriangles(path: string): { triangles: Float32Array; parts: number; asset: unknown } {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("Not a .glb file.");
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const binary = 20 + jsonLength + 8;
  if ((json.extensionsRequired ?? []).some((name: string) => /draco|meshopt/i.test(name))) {
    throw new Error("Compressed geometry is not supported by this reader; import the model in the app instead.");
  }

  const accessor = (index: number) => {
    const a = json.accessors[index];
    const bufferView = json.bufferViews[a.bufferView];
    const size = a.type === "VEC3" ? 3 : 1;
    const width = COMPONENT_BYTES[a.componentType];
    const stride = bufferView.byteStride ?? size * width;
    const offset = binary + (bufferView.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const read = (i: number, c: number) => {
      const o = offset + i * stride + c * width;
      if (a.componentType === 5126) return view.getFloat32(o, true);
      if (a.componentType === 5125) return view.getUint32(o, true);
      if (a.componentType === 5123) return view.getUint16(o, true);
      return view.getUint8(o);
    };
    return { count: a.count as number, read };
  };

  const chunks: Float32Array[] = [];
  const visit = (index: number, parent: Matrix) => {
    const node: GltfNode = json.nodes[index];
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) {
        if ((primitive.mode ?? 4) !== 4) continue;
        const position = accessor(primitive.attributes.POSITION);
        const indices = primitive.indices !== undefined ? accessor(primitive.indices) : null;
        const count = indices ? indices.count : position.count;
        const out = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const v = indices ? indices.read(i, 0) : i;
          const x = position.read(v, 0);
          const y = position.read(v, 1);
          const z = position.read(v, 2);
          out[3 * i] = world[0] * x + world[4] * y + world[8] * z + world[12];
          out[3 * i + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
          out[3 * i + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
        }
        chunks.push(out);
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of json.scenes[json.scene ?? 0].nodes) visit(root, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const triangles = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    triangles.set(chunk, offset);
    offset += chunk.length;
  }
  return { triangles, parts: chunks.length, asset: json.asset };
}
