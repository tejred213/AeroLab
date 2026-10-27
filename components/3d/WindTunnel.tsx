"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Label } from "@/components/3d/Label";
import { SCENE_COLORS } from "@/components/3d/sceneSetup";
import { MODEL } from "@/lib/physics/model";

const T = MODEL.tunnel;

function lineGeometry(points: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  return geometry;
}

interface WindTunnelProps {
  /** Hide text labels (used on the landing page). */
  showLabels?: boolean;
}

/**
 * Test section: inlet, outlet, floor, ceiling and side boundaries, with a
 * 1 m coordinate grid on the floor. Dimensions match the solver domain.
 */
export function WindTunnel({ showLabels = true }: WindTunnelProps) {
  const { minor, major, frame, inlet, outlet } = useMemo(() => {
    const minorPoints: number[] = [];
    const majorPoints: number[] = [];
    const z = 0.002;
    for (let x = Math.ceil(T.xMin); x <= T.xMax; x++) {
      (x % 5 === 0 ? majorPoints : minorPoints).push(x, -T.halfWidth, z, x, T.halfWidth, z);
    }
    for (let y = -Math.floor(T.halfWidth); y <= T.halfWidth; y++) {
      (y === 0 ? majorPoints : minorPoints).push(T.xMin, y, z, T.xMax, y, z);
    }

    const framePoints: number[] = [];
    const corners: [number, number][] = [
      [-T.halfWidth, 0],
      [T.halfWidth, 0],
      [T.halfWidth, T.height],
      [-T.halfWidth, T.height],
    ];
    for (let i = 0; i < 4; i++) {
      const [y0, z0] = corners[i];
      const [y1, z1] = corners[(i + 1) % 4];
      // Longitudinal edges and the two end rectangles.
      framePoints.push(T.xMin, y0, z0, T.xMax, y0, z0);
      framePoints.push(T.xMin, y0, z0, T.xMin, y1, z1);
      framePoints.push(T.xMax, y0, z0, T.xMax, y1, z1);
    }

    // Inlet: flow-conditioning screen drawn as a coarse mesh.
    const inletPoints: number[] = [];
    for (let y = -T.halfWidth; y <= T.halfWidth + 1e-6; y += 0.6) inletPoints.push(T.xMin, y, 0, T.xMin, y, T.height);
    for (let zz = 0; zz <= T.height + 1e-6; zz += 0.55) inletPoints.push(T.xMin, -T.halfWidth, zz, T.xMin, T.halfWidth, zz);

    // Outlet: collector opening drawn as an inset rectangle with diagonals to the frame.
    const outletPoints: number[] = [];
    const inset = 0.45;
    const inner: [number, number][] = [
      [-T.halfWidth + inset, inset * 0.4],
      [T.halfWidth - inset, inset * 0.4],
      [T.halfWidth - inset, T.height - inset],
      [-T.halfWidth + inset, T.height - inset],
    ];
    for (let i = 0; i < 4; i++) {
      const [y0, z0] = inner[i];
      const [y1, z1] = inner[(i + 1) % 4];
      outletPoints.push(T.xMax, y0, z0, T.xMax, y1, z1);
      outletPoints.push(T.xMax, y0, z0, T.xMax, corners[i][0], corners[i][1]);
    }

    return {
      minor: lineGeometry(minorPoints),
      major: lineGeometry(majorPoints),
      frame: lineGeometry(framePoints),
      inlet: lineGeometry(inletPoints),
      outlet: lineGeometry(outletPoints),
    };
  }, []);

  useEffect(
    () => () => {
      for (const geometry of [minor, major, frame, inlet, outlet]) geometry.dispose();
    },
    [minor, major, frame, inlet, outlet],
  );

  const length = T.xMax - T.xMin;
  const centreX = (T.xMin + T.xMax) / 2;
  const wallMaterial = (
    <meshBasicMaterial color="#8fa3b8" transparent opacity={0.035} side={THREE.DoubleSide} depthWrite={false} />
  );

  return (
    <group>
      {/* Floor */}
      <mesh position={[centreX, 0, -0.001]}>
        <planeGeometry args={[length, 2 * T.halfWidth]} />
        <meshStandardMaterial color={SCENE_COLORS.floor} roughness={0.95} metalness={0} />
      </mesh>
      <lineSegments geometry={minor}>
        <lineBasicMaterial color={SCENE_COLORS.gridMinor} />
      </lineSegments>
      <lineSegments geometry={major}>
        <lineBasicMaterial color={SCENE_COLORS.gridMajor} />
      </lineSegments>

      {/* Ceiling and side boundaries */}
      <mesh position={[centreX, 0, T.height]}>
        <planeGeometry args={[length, 2 * T.halfWidth]} />
        {wallMaterial}
      </mesh>
      {[1, -1].map((side) => (
        <mesh key={side} position={[centreX, side * T.halfWidth, T.height / 2]} rotation={[Math.PI / 2, 0, 0]}>
          <planeGeometry args={[length, T.height]} />
          {wallMaterial}
        </mesh>
      ))}
      <lineSegments geometry={frame}>
        <lineBasicMaterial color={SCENE_COLORS.frame} />
      </lineSegments>
      <lineSegments geometry={inlet}>
        <lineBasicMaterial color={SCENE_COLORS.frame} transparent opacity={0.45} />
      </lineSegments>
      <lineSegments geometry={outlet}>
        <lineBasicMaterial color={SCENE_COLORS.frame} transparent opacity={0.8} />
      </lineSegments>

      {showLabels && (
        <>
          <Label position={[T.xMin, 0, T.height + 0.2]} text="Inlet · flow →" color="#8b95a2" />
          <Label position={[T.xMax, 0, T.height + 0.2]} text="Outlet" color="#8b95a2" />
        </>
      )}
    </group>
  );
}
