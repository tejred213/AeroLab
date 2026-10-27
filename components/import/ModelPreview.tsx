"use client";

import { Canvas } from "@react-three/fiber";
import { CameraRig } from "@/components/3d/CameraRig";
import { PaintedModel } from "@/components/3d/PaintedModel";
import { SCENE_COLORS } from "@/components/3d/sceneSetup";
import { VehicleModel } from "@/components/3d/VehicleModel";
import type { CameraPreset } from "@/lib/state/viewStore";
import type { GeometryParams } from "@/lib/types";
import type * as THREE from "three";

interface ModelPreviewProps {
  scene: THREE.Object3D;
  /** Row-major matrix from the file's coordinates to tunnel coordinates. */
  matrix: number[];
  length: number;
  camera: { preset: CameraPreset; nonce: number };
  /** After measuring: the fitted geometry and the measured envelope, drawn as a wireframe over the model. */
  envelope: { geometry: GeometryParams; bodyId: string } | null;
  showModel: boolean;
}

/** The model as it will stand in the tunnel: nose at the origin pointing upstream (-X), wheels on the floor. */
export default function ModelPreview({ scene, matrix, length, camera, envelope, showModel }: ModelPreviewProps) {
  return (
    <Canvas dpr={[1, 1.75]} camera={{ fov: 32, near: 0.05, far: 400, up: [0, 0, 1], position: [-3, -6, 3.6] }} gl={{ antialias: true }}>
      <color attach="background" args={[SCENE_COLORS.background]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[-4, -7, 9]} intensity={2.1} />
      <directionalLight position={[7, 6, 4]} intensity={0.7} />
      <gridHelper args={[14, 28, "#3a424c", "#232a32"]} rotation={[Math.PI / 2, 0, 0]} position={[length / 2, 0, 0]} />
      {/* Airflow direction: from the nose (x = 0) toward the tail. */}
      <arrowHelper args={[{ x: 1, y: 0, z: 0 } as THREE.Vector3, { x: -1.6, y: 0, z: 0.5 } as THREE.Vector3, 1.2, "#5cc8f0", 0.3, 0.16]} />
      {showModel && <PaintedModel scene={scene} matrix={matrix} lift={0} />}
      {envelope && (
        <VehicleModel geometry={envelope.geometry} bodyId={envelope.bodyId} bodyStyle={showModel ? "wireframe" : "solid"} opacity={1} field={null} />
      )}
      <CameraRig length={length} request={camera} enableZoom />
    </Canvas>
  );
}
