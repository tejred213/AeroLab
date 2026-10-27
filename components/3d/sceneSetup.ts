import * as THREE from "three";

/**
 * The scene uses the engineering axes of the physics model:
 * X longitudinal (downstream), Y lateral, Z vertical. Three.js defaults to
 * Y-up, so the default up vector is switched once, before any object exists.
 */
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const SCENE_COLORS = {
  background: "#0b0d10",
  floor: "#0f1317",
  gridMinor: "#232b34",
  gridMajor: "#38424e",
  frame: "#3b4350",
  paint: "#9aa5b1",
  glass: "#10151b",
  tyre: "#0c0e11",
  rim: "#5d6772",
  device: "#1b2027",
  separation: "#ff7a2f",
  ghost: "#5cc8f0",
};

/** Target the camera orbits: the middle of the car at roughly belt height. */
export function sceneTarget(length: number): THREE.Vector3 {
  return new THREE.Vector3(length / 2, 0, 0.62);
}
