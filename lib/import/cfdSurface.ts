/**
 * The CFD surface of an imported 3D model: building it (shrink-wrap, in the
 * worker), keeping it (browser storage, plus a store the viewport reads), and
 * handing it to the backend when Mode C needs it.
 */
import { create } from "zustand";
import { DEFAULT_WRAP, type WrapOptions, type WrappedSurface, wrapToSoup } from "@/lib/geometry/wrap";
import { extractTriangles } from "@/lib/import/modelFiles";
import { loadModelScene, loadWrap, saveWrap } from "@/lib/import/modelStore";
import { uploadCfdSurface } from "@/lib/simulation/backendApi";
import { wrapLocal } from "@/lib/simulation/client";
import { type ImportedModelInfo, type JobProgress, SimulationError } from "@/lib/types";

interface CfdSurfaceState {
  /** Wrapped surfaces by model; null = looked for and not found. */
  wraps: Record<string, WrappedSurface | null>;
  /** Draw the wrapped surface in the viewport in place of the model. */
  show: boolean;
  setWrap: (bodyId: string, wrap: WrappedSurface | null) => void;
  setShow: (show: boolean) => void;
}

export const useCfdSurfaceStore = create<CfdSurfaceState>()((set) => ({
  wraps: {},
  show: false,
  setWrap: (bodyId, wrap) => set((state) => ({ wraps: { ...state.wraps, [bodyId]: wrap } })),
  setShow: (show) => set({ show }),
}));

/** The stored wrap of a model, from memory or from browser storage; null when it has not been built. */
export async function cfdSurfaceOf(bodyId: string): Promise<WrappedSurface | null> {
  const known = useCfdSurfaceStore.getState().wraps[bodyId];
  if (known !== undefined) return known;
  const stored = await loadWrap(bodyId);
  useCfdSurfaceStore.getState().setWrap(bodyId, stored);
  return stored;
}

/** Wraps the model's own triangles (not its envelope) into one closed surface and stores it. */
export async function buildCfdSurface(
  model: ImportedModelInfo,
  options: WrapOptions,
  onProgress?: (progress: JobProgress) => void,
): Promise<WrappedSurface> {
  onProgress?.({ state: "PREPARING", progress: 0, message: "Reading the model" });
  const scene = await loadModelScene(model.bodyId, model.excludedParts);
  const positions = extractTriangles(scene, new Set(model.excludedParts));
  const wrap = await wrapLocal({ positions, matrix: model.matrix, options }, onProgress);
  await saveWrap(model.bodyId, wrap).catch(() => {
    // Without storage the wrap still serves this session; it has to be built again after a reload.
  });
  uploaded.delete(model.bodyId);
  useCfdSurfaceStore.getState().setWrap(model.bodyId, wrap);
  return wrap;
}

const uploaded = new Map<string, { wrap: WrappedSurface; id: string }>();

/**
 * The reference Mode C needs: makes sure the model has a wrapped surface and that the backend holds it, and
 * returns its id.
 *
 * A surface that has not been built yet is built here with the default settings, so that running Mode C
 * does not depend on a separate step having been taken first. If that surface lets air into the model, the
 * run stops before any solver time is spent: the sealing size has to be chosen by someone looking at it.
 */
export async function uploadedCfdSurface(
  model: ImportedModelInfo,
  onProgress?: (progress: JobProgress) => void,
): Promise<{ id: string; voxel: number; seal: number }> {
  let wrap = await cfdSurfaceOf(model.bodyId);
  if (!wrap) {
    try {
      wrap = await buildCfdSurface(model, DEFAULT_WRAP, (progress) =>
        onProgress?.({ ...progress, progress: 0, message: `Building the CFD surface · ${progress.message}` }),
      );
    } catch (error) {
      if (error instanceof SimulationError) throw error;
      throw new SimulationError(
        "CFD_SURFACE_FAILED",
        `The CFD surface of this model could not be built: ${error instanceof Error ? error.message : "unknown error"} Nothing was computed.`,
      );
    }
    if (wrap.warnings.length > 0) {
      throw new SimulationError(
        "CFD_SURFACE_LEAKS",
        `${wrap.warnings.join(" ")} Open CFD / ML in the dock, choose a larger sealing size, build the surface again and check it in the viewport. Nothing was computed.`,
      );
    }
  }
  let entry = uploaded.get(model.bodyId);
  if (!entry || entry.wrap !== wrap) {
    onProgress?.({ state: "PREPARING", progress: 0, message: "Sending the wrapped surface to the backend" });
    const soup = wrapToSoup(wrap) as Float32Array<ArrayBuffer>;
    entry = { wrap, id: (await uploadCfdSurface(soup)).id };
    uploaded.set(model.bodyId, entry);
  }
  return { id: entry.id, voxel: wrap.voxel, seal: wrap.seal };
}
