"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";

/** Radius within which the grid is drawn, and the radius at which it starts to fade, m. */
const GRID_RADIUS = 11;
const FADE_START = 3.5;
/** Lines are cut into pieces this long so the fade follows the distance from the car, m. */
const PIECE = 0.5;
const LINE_COLOR = "#c9d0d9";
const BACKDROP_COLOR = "#ffffff";

interface StudioFloorProps {
  /** Overall length and width of the car, m: the grid is centred on it and the shadow sized to it. */
  length: number;
  width: number;
}

/**
 * Floor of the white landing-page scene: the same 1 m coordinate grid as the tunnel floor, fading
 * into the backdrop with distance from the car, and a soft shadow under the car. Appearance only.
 */
export function StudioFloor({ length, width }: StudioFloorProps) {
  const centreX = length / 2;

  const grid = useMemo(() => {
    const line = new THREE.Color(LINE_COLOR);
    const backdrop = new THREE.Color(BACKDROP_COLOR);
    const mixed = new THREE.Color();
    const positions: number[] = [];
    const colors: number[] = [];
    const z = 0.002;

    const push = (x: number, y: number) => {
      const r = Math.hypot(x - centreX, y);
      const t = Math.min(Math.max((r - FADE_START) / (GRID_RADIUS - FADE_START), 0), 1);
      mixed.copy(line).lerp(backdrop, t * t * (3 - 2 * t));
      positions.push(x, y, z);
      colors.push(mixed.r, mixed.g, mixed.b);
    };

    const xMin = Math.ceil(centreX - GRID_RADIUS);
    const xMax = Math.floor(centreX + GRID_RADIUS);
    const yMax = Math.floor(GRID_RADIUS);
    // Lines of constant x, then lines of constant y, each in short pieces.
    for (let x = xMin; x <= xMax; x++) {
      for (let y = -yMax; y < yMax; y += PIECE) {
        push(x, y);
        push(x, y + PIECE);
      }
    }
    for (let y = -yMax; y <= yMax; y++) {
      for (let x = xMin; x < xMax; x += PIECE) {
        push(x, y);
        push(x + PIECE, y);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return geometry;
  }, [centreX]);

  // Soft shadow: a radial falloff painted once and stretched to the car's footprint.
  const shadow = useMemo(() => {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (context) {
      const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, "rgba(14, 18, 26, 0.42)");
      gradient.addColorStop(0.45, "rgba(14, 18, 26, 0.2)");
      gradient.addColorStop(1, "rgba(14, 18, 26, 0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);

  useEffect(() => () => grid.dispose(), [grid]);
  useEffect(() => () => shadow.dispose(), [shadow]);

  return (
    <group>
      <lineSegments geometry={grid}>
        <lineBasicMaterial vertexColors toneMapped={false} />
      </lineSegments>
      <mesh position={[centreX, 0, 0.004]}>
        <planeGeometry args={[length * 1.34, width * 1.9]} />
        <meshBasicMaterial map={shadow} transparent depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}
