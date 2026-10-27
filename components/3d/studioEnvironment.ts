"use client";

import { useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const environments = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

/**
 * A neutral studio environment for reflections, generated locally (no download)
 * once per renderer. Paint and glass need something to reflect; only the
 * materials that ask for it use it, so the rest of the scene keeps its plain lighting.
 */
export function useStudioEnvironment(): THREE.Texture {
  const gl = useThree((state) => state.gl);
  return useMemo(() => {
    let texture = environments.get(gl);
    if (!texture) {
      const generator = new THREE.PMREMGenerator(gl);
      const room = new RoomEnvironment();
      texture = generator.fromScene(room, 0.04).texture;
      room.dispose();
      generator.dispose();
      environments.set(gl, texture);
    }
    return texture;
  }, [gl]);
}
