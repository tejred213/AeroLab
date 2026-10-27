/**
 * Reading 3D model files (glTF / GLB, OBJ with optional MTL, STL, or a zip of
 * those) into a three.js scene, and turning the scene into the triangle soup the
 * measuring code works on. Browser only.
 */
import * as THREE from "three";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { creditFromAsset, linearToSrgbByte, type ModelCredit, type Rgb, specGlossToMetalRough, SRGB_TO_LINEAR } from "@/lib/import/specGloss";

/** One file of a model: the model itself, a buffer, or a texture. */
export interface ModelFile {
  /** Path as given (inside a zip, or the file name). */
  name: string;
  blob: Blob;
}

export interface ModelPart {
  id: string;
  name: string;
  triangles: number;
  /** A large flat sheet with a handful of triangles: most likely a ground or shadow plane. */
  sheet: boolean;
}

export interface LoadedModel {
  scene: THREE.Object3D;
  fileName: string;
  format: "gltf" | "obj" | "stl";
  /** True when the format fixes the up axis (glTF is Y-up); otherwise it has to be guessed. */
  yUp: boolean;
  parts: ModelPart[];
  triangles: number;
  /** Bounding box of all parts in the file's coordinates. */
  box: { min: number[]; max: number[] };
  /** Title, author, page and licence, when the file states them itself. */
  credit: ModelCredit | null;
}

const MODEL_EXTENSIONS = ["glb", "gltf", "obj", "stl"];
export const ACCEPTED_EXTENSIONS = [...MODEL_EXTENSIONS, "zip", "bin", "mtl", "png", "jpg", "jpeg", "webp"];
/** Above this the measuring step needs several hundred megabytes; the import is refused. */
export const MAX_TRIANGLES = 6_000_000;

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function baseName(path: string): string {
  return decodeURIComponent(path).split(/[\\/]/).pop()!.split("?")[0].toLowerCase();
}

/** Unpacks zip archives; other files pass through. */
export async function expandFiles(files: File[]): Promise<ModelFile[]> {
  const out: ModelFile[] = [];
  for (const file of files) {
    if (extension(file.name) !== "zip") {
      out.push({ name: file.name, blob: file });
      continue;
    }
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith("/") || data.length === 0) continue;
      out.push({ name, blob: new Blob([data as Uint8Array<ArrayBuffer>]) });
    }
  }
  return out;
}

/** The file of a set that is the model itself: the first of glb, gltf, obj, stl. */
export function mainFileOf(files: ModelFile[]): ModelFile | null {
  for (const wanted of MODEL_EXTENSIONS) {
    const found = files.find((file) => extension(file.name) === wanted);
    if (found) return found;
  }
  return null;
}

/** Meshes of a scene in a fixed order, with the ids used to switch parts off. */
export function meshesOf(scene: THREE.Object3D): { mesh: THREE.Mesh; id: string }[] {
  const meshes: { mesh: THREE.Mesh; id: string }[] = [];
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry?.getAttribute("position")) {
      meshes.push({ mesh, id: `${meshes.length}:${mesh.name || mesh.parent?.name || "part"}` });
    }
  });
  return meshes;
}

function triangleCount(mesh: THREE.Mesh): number {
  const geometry = mesh.geometry;
  const count = geometry.index ? geometry.index.count : geometry.getAttribute("position").count;
  const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
  return Math.floor(count / 3) * instances;
}

function describe(scene: THREE.Object3D): Pick<LoadedModel, "parts" | "triangles" | "box"> {
  scene.updateMatrixWorld(true);
  const all = new THREE.Box3();
  const boxes: THREE.Box3[] = [];
  const meshes = meshesOf(scene);
  for (const { mesh } of meshes) {
    const box = new THREE.Box3().setFromObject(mesh);
    boxes.push(box);
    all.union(box);
  }
  const size = all.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  let triangles = 0;
  const parts = meshes.map(({ mesh, id }, index) => {
    const count = triangleCount(mesh);
    triangles += count;
    const extent = boxes[index].getSize(new THREE.Vector3());
    const sorted = [extent.x, extent.y, extent.z].sort((a, b) => a - b);
    const sheet = count <= 8 && sorted[0] < 0.005 * largest && sorted[2] > 0.5 * largest;
    return { id, name: mesh.name || mesh.parent?.name || `Part ${index + 1}`, triangles: count, sheet };
  });
  return { parts, triangles, box: { min: all.min.toArray(), max: all.max.toArray() } };
}

/** Parses a set of files into a scene. Rejects with a readable message. */
export async function parseModel(files: ModelFile[]): Promise<LoadedModel> {
  const main = mainFileOf(files);
  if (!main) throw new Error("No model file found. Supported: .glb, .gltf, .obj, .stl, or a .zip that contains one.");
  const format = extension(main.name);

  // Buffers and textures referenced by the model are served from the files that came with it.
  const urls = new Map<string, string>();
  for (const file of files) urls.set(baseName(file.name), URL.createObjectURL(file.blob));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (url.startsWith("blob:") || url.startsWith("data:") ? url : (urls.get(baseName(url)) ?? url)));
  const release = () => urls.forEach((url) => URL.revokeObjectURL(url));

  let scene: THREE.Object3D;
  let credit: ModelCredit | null = null;
  try {
    if (format === "glb" || format === "gltf") {
      const loader = new GLTFLoader(manager);
      const draco = new DRACOLoader(manager).setDecoderPath("/draco/");
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const data = format === "glb" ? await main.blob.arrayBuffer() : await main.blob.text();
      const gltf = await loader.parseAsync(data, "");
      draco.dispose();
      scene = gltf.scene;
      credit = creditFromAsset(gltf.asset);
      await convertSpecularGlossiness(scene, (index) => gltf.parser.getDependency("texture", index) as Promise<THREE.Texture>);
    } else if (format === "obj") {
      const loader = new OBJLoader(manager);
      const mtl = files.find((file) => extension(file.name) === "mtl");
      if (mtl) {
        const materials = new MTLLoader(manager).parse(await mtl.blob.text(), "");
        materials.preload();
        loader.setMaterials(materials);
      }
      scene = loader.parse(await main.blob.text());
      if (!mtl) {
        scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) mesh.material = new THREE.MeshStandardMaterial({ color: "#8f9aa5", roughness: 0.45, metalness: 0.4 });
        });
      }
    } else {
      const geometry = new STLLoader(manager).parse(await main.blob.arrayBuffer());
      geometry.computeVertexNormals();
      scene = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#8f9aa5", roughness: 0.45, metalness: 0.4 }));
      scene.name = baseName(main.name);
    }
  } catch (error) {
    release();
    throw new Error(`The model could not be read: ${error instanceof Error ? error.message : "unknown format error"}`);
  }
  // Textures finish loading in the background; the URLs are released a little later.
  setTimeout(release, 60_000);

  const summary = describe(scene);
  if (summary.triangles === 0) throw new Error("The file contains no triangles.");
  if (summary.triangles > MAX_TRIANGLES) {
    throw new Error(
      `The model has ${(summary.triangles / 1e6).toFixed(1)} million triangles; the limit is ${MAX_TRIANGLES / 1e6} million. Use a lower level of detail.`,
    );
  }
  return {
    scene,
    fileName: baseName(main.name),
    format: format === "glb" ? "gltf" : (format as "gltf" | "obj" | "stl"),
    yUp: format === "glb" || format === "gltf",
    credit,
    ...summary,
  };
}

/** Shows or hides parts; hidden parts are also left out of the measurement. */
export function applyExclusions(scene: THREE.Object3D, excluded: ReadonlySet<string>): void {
  for (const { mesh, id } of meshesOf(scene)) mesh.visible = !excluded.has(id);
}

/** All triangles of the included parts in the file's coordinates, 9 numbers per triangle. */
export function extractTriangles(scene: THREE.Object3D, excluded: ReadonlySet<string>): Float32Array {
  // The scene may be on show somewhere (the import preview, the tunnel), under a transform of that view.
  // The triangles are wanted in the file's own coordinates, so whatever lies above the scene is undone.
  scene.updateWorldMatrix(true, true);
  const toFile = new THREE.Matrix4();
  if (scene.parent) toFile.copy(scene.parent.matrixWorld).invert();
  const meshes = meshesOf(scene).filter(({ id }) => !excluded.has(id));
  let total = 0;
  for (const { mesh } of meshes) total += triangleCount(mesh);
  const out = new Float32Array(total * 9);
  const vertex = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const instance = new THREE.Matrix4();
  let o = 0;
  for (const { mesh } of meshes) {
    const position = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.index;
    const count = Math.floor((index ? index.count : position.count) / 3) * 3;
    const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
    for (let n = 0; n < (instanced ? instanced.count : 1); n++) {
      matrix.multiplyMatrices(toFile, mesh.matrixWorld);
      if (instanced) {
        instanced.getMatrixAt(n, instance);
        matrix.multiply(instance);
      }
      for (let i = 0; i < count; i++) {
        vertex.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix);
        out[o++] = vertex.x;
        out[o++] = vertex.y;
        out[o++] = vertex.z;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Specular / glossiness materials
// ---------------------------------------------------------------------------

interface SpecularGlossiness {
  diffuseFactor?: number[];
  diffuseTexture?: { index: number };
  specularFactor?: number[];
  glossinessFactor?: number;
  specularGlossinessTexture?: { index: number };
}

const SPEC_GLOSS = "KHR_materials_pbrSpecularGlossiness";
/** Largest side of the maps generated for a converted material. */
const BAKE_SIZE = 1024;
/** Roughness given to areas whose specular data was left empty by the exporter. */
const UNSPECIFIED_ROUGHNESS = 0.42;

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement;

function drawableOf(texture: THREE.Texture | null): Drawable | null {
  const image = texture?.image as Drawable | undefined;
  return image && "width" in image && image.width > 0 ? image : null;
}

function pixelsOf(image: Drawable, width: number, height: number): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height).data;
}

function textureFrom(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number, like: THREE.Texture, colour: boolean): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(pixels, width, height), 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  // Same orientation, tiling and UV set as the texture it was made from.
  texture.flipY = like.flipY;
  texture.wrapS = like.wrapS;
  texture.wrapT = like.wrapT;
  texture.repeat.copy(like.repeat);
  texture.offset.copy(like.offset);
  texture.rotation = like.rotation;
  texture.center.copy(like.center);
  texture.channel = like.channel;
  texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return texture;
}

/**
 * Gives materials written in the specular / glossiness form (which three.js no longer reads, so they would
 * come out as blank white metal) their colour, roughness and metalness. Where the specular colour and the
 * glossiness are textures, a roughness / metalness map is generated from them, and a base-colour map when the
 * material has metallic areas (their colour lives in the specular texture, not in the diffuse one).
 */
async function convertSpecularGlossiness(scene: THREE.Object3D, textureAt: (index: number) => Promise<THREE.Texture>): Promise<void> {
  const materials = new Set<THREE.MeshStandardMaterial>();
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material?.userData?.gltfExtensions?.[SPEC_GLOSS]) materials.add(material as THREE.MeshStandardMaterial);
    }
  });
  const baked = new Map<string, { maps: THREE.Texture; base: THREE.Texture | null } | null>();

  for (const material of materials) {
    const definition = material.userData.gltfExtensions[SPEC_GLOSS] as SpecularGlossiness;
    const diffuse = definition.diffuseFactor ?? [1, 1, 1, 1];
    const specular = (definition.specularFactor ?? [1, 1, 1]) as Rgb;
    const glossiness = definition.glossinessFactor ?? 1;
    const load = async (reference?: { index: number }) => {
      if (!reference) return null;
      try {
        return await textureAt(reference.index);
      } catch {
        return null;
      }
    };
    const diffuseTexture = await load(definition.diffuseTexture);
    const glossTexture = await load(definition.specularGlossinessTexture);

    material.opacity = diffuse[3] ?? 1;
    if (diffuseTexture) {
      diffuseTexture.colorSpace = THREE.SRGBColorSpace;
      material.map = diffuseTexture;
    }
    const glossImage = drawableOf(glossTexture);
    if (glossTexture && glossImage) {
      const key = `${definition.diffuseTexture?.index ?? "-"}:${definition.specularGlossinessTexture!.index}:${diffuse.join(",")}:${specular.join(",")}:${glossiness}`;
      if (!baked.has(key)) baked.set(key, bake(drawableOf(diffuseTexture), glossImage, diffuseTexture ?? glossTexture, diffuse, specular, glossiness));
      const result = baked.get(key);
      if (result) {
        material.color.setRGB(1, 1, 1);
        material.roughness = 1;
        material.metalness = 1;
        material.roughnessMap = result.maps;
        material.metalnessMap = result.maps;
        if (result.base) material.map = result.base;
        else material.color.setRGB(diffuse[0], diffuse[1], diffuse[2], THREE.LinearSRGBColorSpace);
        material.needsUpdate = true;
        continue;
      }
    }
    const converted = specGlossToMetalRough([diffuse[0], diffuse[1], diffuse[2]], specular);
    // With a diffuse texture the colour stays in the texture; the factor only tints it.
    const tint = diffuseTexture ? ([diffuse[0], diffuse[1], diffuse[2]] as Rgb) : converted.baseColor;
    material.color.setRGB(tint[0], tint[1], tint[2], THREE.LinearSRGBColorSpace);
    material.metalness = diffuseTexture ? Math.min(converted.metalness, 0.5) : converted.metalness;
    material.roughness = 1 - glossiness;
    material.needsUpdate = true;
  }
}

function bake(
  diffuseImage: Drawable | null,
  glossImage: Drawable,
  like: THREE.Texture,
  diffuseFactor: number[],
  specularFactor: Rgb,
  glossinessFactor: number,
): { maps: THREE.Texture; base: THREE.Texture | null } | null {
  const scale = Math.min(1, BAKE_SIZE / Math.max(glossImage.width, glossImage.height));
  const width = Math.max(Math.round(glossImage.width * scale), 1);
  const height = Math.max(Math.round(glossImage.height * scale), 1);
  const gloss = pixelsOf(glossImage, width, height);
  const diffuse = diffuseImage ? pixelsOf(diffuseImage, width, height) : null;
  if (!gloss) return null;

  const maps = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  const base = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  let metallic = 0;
  const d: Rgb = [0, 0, 0];
  const s: Rgb = [0, 0, 0];
  for (let i = 0; i < gloss.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      d[k] = (diffuse ? SRGB_TO_LINEAR[diffuse[i + k]] : 1) * diffuseFactor[k];
      s[k] = SRGB_TO_LINEAR[gloss[i + k]] * specularFactor[k];
    }
    const converted = specGlossToMetalRough(d, s);
    if (converted.metalness > 0.5) metallic++;
    maps[i] = 255;
    // No specular reflection and no gloss at all is not a real surface but a value the exporter left empty:
    // such areas get a neutral, moderately glossy finish instead of a dead matt one.
    const empty = gloss[i + 3] === 0 && gloss[i] + gloss[i + 1] + gloss[i + 2] === 0;
    // three.js reads roughness from the green channel and metalness from the blue one.
    maps[i + 1] = Math.round(255 * (empty ? UNSPECIFIED_ROUGHNESS : 1 - (gloss[i + 3] / 255) * glossinessFactor));
    maps[i + 2] = Math.round(255 * converted.metalness);
    maps[i + 3] = 255;
    for (let k = 0; k < 3; k++) base[i + k] = linearToSrgbByte(converted.baseColor[k]);
    base[i + 3] = diffuse ? diffuse[i + 3] : 255;
  }
  const hasMetal = metallic > 0.002 * (gloss.length / 4);
  return {
    maps: textureFrom(maps, width, height, like, false),
    // Without metallic areas the original diffuse texture is the base colour, at its full resolution.
    base: hasMetal || !diffuse ? textureFrom(base, width, height, like, true) : null,
  };
}
