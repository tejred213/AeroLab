"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { BodyStyle } from "@/lib/state/viewStore";

export interface WrappedSurfaceData {
  positions: Float32Array;
  indices: Uint32Array;
  /** Vertical shift, m (a ride height changed from the measured one; Mode C itself uses the model as imported). */
  lift: number;
}

/**
 * The closed surface that Mode C meshes for an imported 3D model, drawn in place of the model so that what
 * goes to the mesher can be inspected: plain grey, no paint, exactly the triangles that are sent.
 */
export function WrappedSurface({ data, bodyStyle, opacity }: { data: WrappedSurfaceData; bodyStyle: BodyStyle; opacity: number }) {
  const geometry = useMemo(() => {
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    buffer.setIndex(new THREE.BufferAttribute(data.indices, 1));
    buffer.computeVertexNormals();
    return buffer;
  }, [data.positions, data.indices]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  const transparent = bodyStyle === "transparent";
  return (
    <mesh geometry={geometry} position={[0, 0, data.lift]}>
      <meshStandardMaterial
        color="#aeb6bf"
        roughness={0.6}
        metalness={0.15}
        wireframe={bodyStyle === "wireframe"}
        transparent={transparent}
        opacity={transparent ? opacity : 1}
        depthWrite={!transparent}
      />
    </mesh>
  );
}
