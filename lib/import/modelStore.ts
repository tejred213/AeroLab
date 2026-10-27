/**
 * Browser storage for imported 3D models: the original files (to draw the
 * painted model) and the measured envelope (to solve on it), in IndexedDB.
 * Nothing is uploaded anywhere.
 */
import type * as THREE from "three";
import type { SampledBody } from "@/lib/geometry/profile";
import type { WrappedSurface } from "@/lib/geometry/wrap";
import { getSampledBody, registerSampledBody, removeSampledBody } from "@/lib/geometry/sampledBody";
import { applyExclusions, type ModelFile, parseModel } from "@/lib/import/modelFiles";

const DATABASE = "aerolab-models";
const FILES = "files";
const BODIES = "bodies";
const WRAPS = "wraps";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no IndexedDB storage."));
      return;
    }
    // Version 2 added the store of wrapped surfaces for CFD.
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      const stores = request.result.objectStoreNames;
      for (const name of [FILES, BODIES, WRAPS]) if (!stores.contains(name)) request.result.createObjectStore(name);
    };
    request.onblocked = () =>
      reject(new Error("The model storage is being used by another tab of this app. Close the other tabs and try again."));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The model storage could not be opened."));
  });
}

async function withStore<T>(store: string, mode: IDBTransactionMode, run: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(store, mode);
      const request = run(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("The model storage failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The model storage is full or unavailable."));
    });
  } finally {
    database.close();
  }
}

const scenes = new Map<string, Promise<THREE.Object3D>>();

/** Stores a model. The scene that was already parsed for the import is kept for drawing. */
export async function saveModel(bodyId: string, files: ModelFile[], body: SampledBody, scene: THREE.Object3D): Promise<void> {
  await withStore(FILES, "readwrite", (objects) => objects.put(files, bodyId));
  await withStore(BODIES, "readwrite", (objects) => objects.put(body, bodyId));
  registerSampledBody(body);
  scenes.set(bodyId, Promise.resolve(scene));
}

export async function deleteModel(bodyId: string): Promise<void> {
  scenes.delete(bodyId);
  removeSampledBody(bodyId);
  await withStore(FILES, "readwrite", (objects) => objects.delete(bodyId));
  await withStore(BODIES, "readwrite", (objects) => objects.delete(bodyId));
  await withStore(WRAPS, "readwrite", (objects) => objects.delete(bodyId));
}

/** The wrapped (closed) surface of a model, for CFD; one per model, replaced when it is wrapped again. */
export async function saveWrap(bodyId: string, wrap: WrappedSurface): Promise<void> {
  await withStore(WRAPS, "readwrite", (objects) => objects.put(wrap, bodyId));
}

export async function loadWrap(bodyId: string): Promise<WrappedSurface | null> {
  try {
    return (await withStore<WrappedSurface | undefined>(WRAPS, "readonly", (objects) => objects.get(bodyId))) ?? null;
  } catch {
    return null;
  }
}

/** Makes the measured envelope available to the solver. Resolves false when it is not stored in this browser. */
export async function ensureBodyLoaded(bodyId: string): Promise<boolean> {
  if (getSampledBody(bodyId)) return true;
  try {
    const body = await withStore<SampledBody | undefined>(BODIES, "readonly", (objects) => objects.get(bodyId));
    if (!body) return false;
    registerSampledBody(body);
    return true;
  } catch {
    return false;
  }
}

/** The painted model of a stored import, parsed once per session. Rejects when the files are gone. */
export function loadModelScene(bodyId: string, excludedParts: string[]): Promise<THREE.Object3D> {
  let scene = scenes.get(bodyId);
  if (!scene) {
    scene = withStore<ModelFile[] | undefined>(FILES, "readonly", (objects) => objects.get(bodyId)).then(async (files) => {
      if (!files) throw new Error("The files of this model are no longer stored in this browser.");
      const model = await parseModel(files);
      applyExclusions(model.scene, new Set(excludedParts));
      return model.scene;
    });
    scenes.set(bodyId, scene);
    scene.catch(() => scenes.delete(bodyId));
  }
  return scene;
}
