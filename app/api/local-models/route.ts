/**
 * Lists the 3D model files placed in public/cars, so they can be imported
 * without going through the browser's file picker. Local tool: reads the
 * project's own folder, nothing else.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

/** Single-file formats only: a .gltf needs its sibling files, which a zip or a .glb carries inside. */
const EXTENSIONS = new Set([".glb", ".zip", ".obj", ".stl"]);
const SAMPLE = "sample-fastback.glb";

export async function GET(): Promise<Response> {
  const directory = path.join(process.cwd(), "public", "cars");
  const models: { name: string; size: number }[] = [];
  try {
    for (const name of await readdir(directory)) {
      if (name === SAMPLE || name.startsWith(".") || !EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      const info = await stat(path.join(directory, name));
      if (info.isFile()) models.push({ name, size: info.size });
    }
  } catch {
    // No folder, no models.
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return Response.json({ models });
}
