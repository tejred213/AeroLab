"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Label } from "@/components/3d/Label";
import { SCENE_COLORS } from "@/components/3d/sceneSetup";
import { computeMetrics } from "@/lib/geometry/metrics";
import { buildBodyShape, lowerZ, planHalfWidth, stationHalfWidth, upperZ } from "@/lib/geometry/profile";
import { buildSolidModel, wakeBounds, wakeHalfWidth } from "@/lib/geometry/solids";
import { computeRearFlow } from "@/lib/physics/rearFlow";
import type { GeometryParams } from "@/lib/types";

const STATIONS = 44;
const SIDE_POINTS = 9;

/** Shared derived model of the separated region for a geometry. */
function useWakeModel(geometry: GeometryParams) {
  return useMemo(() => {
    const shape = buildBodyShape(geometry);
    const metrics = computeMetrics(shape);
    const rearFlow = computeRearFlow(shape, metrics.frontalArea);
    const model = buildSolidModel(shape, rearFlow, { x: 0.05, y: 0.03 });
    return { shape, rearFlow, model };
  }, [geometry]);
}

/**
 * Translucent shell of the wake displacement body: the empirically prescribed
 * region of separated flow behind (and, for steep rear windows, on) the body.
 */
export function WakeShell({ geometry }: { geometry: GeometryParams }) {
  const { model } = useWakeModel(geometry);

  const mesh = useMemo(() => {
    const { wake } = model;
    const bounds = new Float64Array(2);
    const ring = 2 * SIDE_POINTS;
    const positions = new Float32Array(STATIONS * ring * 3);
    for (let s = 0; s < STATIONS; s++) {
      // Slightly inside both ends so the first and last rings are well defined.
      const t = (s + 0.02) / (STATIONS - 1 + 0.04);
      const x = wake.xStart + t * (wake.xc - wake.xStart);
      const valid = wakeBounds(model, x, bounds);
      const bottom = valid ? bounds[0] : wake.zClosure;
      const top = valid ? bounds[1] : wake.zClosure;
      for (let j = 0; j < SIDE_POINTS; j++) {
        const z = bottom + ((top - bottom) * (j + 0.5)) / SIDE_POINTS;
        const y = valid ? wakeHalfWidth(model, x, z) : 0;
        const left = (s * ring + j) * 3;
        const right = (s * ring + (ring - 1 - j)) * 3;
        positions.set([x, y, z], left);
        positions.set([x, -y, z], right);
      }
    }
    const indices: number[] = [];
    for (let s = 0; s < STATIONS - 1; s++) {
      for (let r = 0; r < ring; r++) {
        const a = s * ring + r;
        const b = s * ring + ((r + 1) % ring);
        const c = a + ring;
        const d = b + ring;
        indices.push(a, b, c, b, d, c);
      }
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    buffer.setIndex(indices);
    buffer.computeVertexNormals();
    return buffer;
  }, [model]);

  useEffect(() => () => mesh.dispose(), [mesh]);

  return (
    <group>
      <mesh geometry={mesh} renderOrder={2}>
        <meshBasicMaterial color={SCENE_COLORS.separation} transparent opacity={0.1} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh geometry={mesh} renderOrder={2}>
        <meshBasicMaterial color={SCENE_COLORS.separation} wireframe transparent opacity={0.22} depthWrite={false} />
      </mesh>
      <Label
        position={[model.length + 0.45 * (model.wake.xc - model.length), 0, model.wake.zSepTop + 0.25]}
        text="WAKE · EMPIRICAL MODEL"
        color={SCENE_COLORS.separation}
      />
    </group>
  );
}

/** Outline of the body cross-section at station x, upper part above zMin (body frame). */
function sectionOutline(shape: ReturnType<typeof buildBodyShape>, x: number, zMin: number): number[] {
  const { params } = shape;
  const zl = lowerZ(shape, x);
  const zu = upperZ(shape, x);
  const wb = planHalfWidth(shape, x);
  const ride = params.rideHeight;
  const start = Math.max(zl, zMin);
  const side: [number, number][] = [];
  const count = 18;
  for (let j = 0; j <= count; j++) {
    const z = start + ((zu - start) * (1 - Math.cos((Math.PI * j) / count))) / 2;
    side.push([stationHalfWidth(shape, x, zl, zu, wb, z) + 0.012, z + ride + (j === count ? 0.012 : 0)]);
  }
  const loop: [number, number][] = [...side, ...side.map(([y, z]) => [-y, z] as [number, number]).reverse()];
  const points: number[] = [];
  for (let i = 0; i < loop.length - 1; i++) {
    points.push(x, loop[i][0], loop[i][1], x, loop[i + 1][0], loop[i + 1][1]);
  }
  return points;
}

/** Marks where the flow leaves the surface: the separation line, plus any bubble on the rear window. */
export function SeparationMarkers({ geometry }: { geometry: GeometryParams }) {
  const { shape, rearFlow } = useWakeModel(geometry);

  const lines = useMemo(() => {
    const x = Math.min(rearFlow.separationX, shape.length - 0.005);
    const points = sectionOutline(shape, x, -1);
    if (rearFlow.bubbleFraction > 0.05) {
      points.push(...sectionOutline(shape, shape.xRoofEnd, shape.deckHeight));
    }
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return buffer;
  }, [shape, rearFlow]);

  useEffect(() => () => lines.dispose(), [lines]);

  const labelX = Math.min(rearFlow.separationX, shape.length);
  const labelZ = geometry.rideHeight + upperZ(shape, labelX) + 0.28;
  return (
    <group>
      <lineSegments geometry={lines} renderOrder={3}>
        <lineBasicMaterial color={SCENE_COLORS.separation} depthTest={false} transparent opacity={0.95} />
      </lineSegments>
      <Label
        position={[labelX, 0, labelZ]}
        text={`Separation · x = ${labelX.toFixed(2)} m${rearFlow.bubbleFraction > 0.05 ? " · bubble on rear window" : ""}`}
        color={SCENE_COLORS.separation}
        boxed
      />
    </group>
  );
}
