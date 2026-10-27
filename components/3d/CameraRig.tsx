"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { sceneTarget } from "@/components/3d/sceneSetup";
import type { CameraPreset } from "@/lib/state/viewStore";

/** Camera position for each preset, as an offset from the orbit target. */
const PRESET_OFFSETS: Record<CameraPreset, [number, number, number]> = {
  perspective: [-6.4, -7.6, 3.6],
  front: [-11.5, 0, 0.35],
  side: [0, -12.5, 0.3],
  // A hair off the vertical so the orbit controls keep a defined heading (X to the right).
  top: [0, -0.01, 15],
  rear: [11.5, 0, 0.35],
  "three-quarter": [6.8, -7.4, 3.7],
};

const TRANSITION_SECONDS = 0.45;

interface CameraRigProps {
  length: number;
  request: { preset: CameraPreset; nonce: number };
  /** Slow automatic orbit (landing page). */
  autoRotate?: boolean;
  enableZoom?: boolean;
  /** Multiplies the preset's distance from the car; above 1 stands further back. */
  distanceScale?: number;
}

/** Orbit / pan / zoom controls plus animated camera presets. */
export function CameraRig({ length, request, autoRotate = false, enableZoom = true, distanceScale = 1 }: CameraRigProps) {
  const camera = useThree((state) => state.camera);
  const controls = useRef<OrbitControlsImpl>(null);
  const transition = useRef<{
    fromPosition: THREE.Vector3;
    toPosition: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
    elapsed: number;
  } | null>(null);
  const initialised = useRef(false);

  useEffect(() => {
    const target = sceneTarget(length);
    const offset = PRESET_OFFSETS[request.preset];
    const position = target.clone().add(new THREE.Vector3(...offset).multiplyScalar(distanceScale));
    if (!initialised.current) {
      // First render: jump straight to the view.
      initialised.current = true;
      camera.position.copy(position);
      controls.current?.target.copy(target);
      controls.current?.update();
      return;
    }
    transition.current = {
      fromPosition: camera.position.clone(),
      toPosition: position,
      fromTarget: controls.current?.target.clone() ?? target.clone(),
      toTarget: target,
      elapsed: 0,
    };
    // Only a new request (nonce) should move the camera; a geometry change must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.nonce]);

  useFrame((_, delta) => {
    const active = transition.current;
    if (!active || !controls.current) return;
    active.elapsed += delta;
    const t = Math.min(active.elapsed / TRANSITION_SECONDS, 1);
    const eased = t * t * (3 - 2 * t);
    camera.position.lerpVectors(active.fromPosition, active.toPosition, eased);
    controls.current.target.lerpVectors(active.fromTarget, active.toTarget, eased);
    controls.current.update();
    if (t >= 1) transition.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      enableZoom={enableZoom}
      minDistance={2}
      maxDistance={40}
      maxPolarAngle={Math.PI / 2 - 0.01}
      autoRotate={autoRotate}
      autoRotateSpeed={0.6}
    />
  );
}
