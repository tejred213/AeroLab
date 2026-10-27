"use client";

import { useEffect, useState } from "react";
import type * as THREE from "three";
import { matchesImportedShape } from "@/lib/geometry/sampledBody";
import { ensureBodyLoaded, loadModelScene } from "@/lib/import/modelStore";
import { currentVehicle, useSimStore } from "@/lib/state/simStore";
import type { ImportedModelInfo } from "@/lib/types";

export interface ImportedModelView {
  model: ImportedModelInfo;
  /** True while the shape parameters still equal the values fitted to the model. */
  active: boolean;
  /** The measured envelope is loaded and the solver can use it. */
  bodyReady: boolean;
  /** The painted model, once its files have been read. */
  scene: THREE.Object3D | null;
  /** Why the model cannot be drawn or solved on, if so. */
  problem: string | null;
}

/** The imported 3D model behind the vehicle in the simulator, or null for an ordinary vehicle. */
export function useImportedModel(): ImportedModelView | null {
  const model = useSimStore((state) => currentVehicle(state).importedModel);
  const geometry = useSimStore((state) => state.geometry);
  const [loaded, setLoaded] = useState<{ bodyId: string; bodyReady: boolean; scene: THREE.Object3D | null; problem: string | null } | null>(null);

  const bodyId = model?.bodyId;
  const excluded = model?.excludedParts;
  useEffect(() => {
    if (!bodyId) return;
    let cancelled = false;
    const state = { bodyId, bodyReady: false, scene: null as THREE.Object3D | null, problem: null as string | null };
    const publish = () => {
      if (!cancelled) setLoaded({ ...state });
    };
    void ensureBodyLoaded(bodyId).then((ready) => {
      state.bodyReady = ready;
      if (!ready) state.problem = "The measured shape of this model is not stored in this browser any more; import it again.";
      publish();
    });
    loadModelScene(bodyId, excluded ?? []).then(
      (scene) => {
        state.scene = scene;
        publish();
      },
      (error: unknown) => {
        state.problem ??= error instanceof Error ? error.message : "The model files could not be read.";
        publish();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bodyId, excluded]);

  if (!model) return null;
  const current = loaded?.bodyId === model.bodyId ? loaded : null;
  return {
    model,
    active: matchesImportedShape(model, geometry),
    bodyReady: current?.bodyReady ?? false,
    scene: current?.scene ?? null,
    problem: current?.problem ?? null,
  };
}
