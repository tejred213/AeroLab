"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useStudioEnvironment } from "@/components/3d/studioEnvironment";

export interface PaintedModelData {
  scene: THREE.Object3D;
  /** Row-major 4 x 4 matrix from the file's coordinates to tunnel coordinates. */
  matrix: number[];
  /** Vertical shift of the whole model, m (a ride height changed from the measured one). */
  lift: number;
}

/**
 * An imported 3D model with its own materials. Paint and glass need something
 * to reflect, so the model's materials get a neutral studio environment that is
 * generated locally; the rest of the scene keeps its plain lighting.
 */
export function PaintedModel({ scene, matrix, lift }: PaintedModelData) {
  const environment = useStudioEnvironment();
  const transform = useMemo(() => new THREE.Matrix4().set(...(matrix as Parameters<THREE.Matrix4["set"]>)), [matrix]);

  useEffect(() => {
    const touched: { material: THREE.MeshStandardMaterial; intensity: number }[] = [];
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const standard = material as THREE.MeshStandardMaterial;
        if (!standard.isMeshStandardMaterial || standard.envMap) continue;
        touched.push({ material: standard, intensity: standard.envMapIntensity });
        standard.envMap = environment;
        standard.envMapIntensity = 0.9;
        standard.needsUpdate = true;
      }
    });
    return () => {
      for (const entry of touched) {
        entry.material.envMap = null;
        entry.material.envMapIntensity = entry.intensity;
        entry.material.needsUpdate = true;
      }
    };
  }, [environment, scene]);

  return (
    <group position={[0, 0, lift]}>
      <group matrixAutoUpdate={false} matrix={transform}>
        <primitive object={scene} />
      </group>
    </group>
  );
}
