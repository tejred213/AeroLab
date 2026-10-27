"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CELL_SOLID, createFieldSample, type FlowField, sampleField } from "@/lib/simulation/field";
import { inkColor, scaleColor, velocityT } from "@/lib/utils/colormap";

interface FlowParticlesProps {
  field: FlowField;
  count: number;
  playing: boolean;
  /** Lateral half-extent and height of the seeding window, m. */
  halfWidth: number;
  height: number;
  /** Streamwise extent in which particles live, m. */
  xStart: number;
  xEnd: number;
  /**
   * "speed" is the simulator's colour scale, for the dark tunnel. "ink" is a single hue for a white
   * backdrop; there the streaks also grow in and taper out at the ends of the window instead of popping.
   */
  palette?: "speed" | "ink";
}

/**
 * On-screen speed of the undisturbed flow, m/s. The animation is time-scaled:
 * the real freestream is much faster, so particle speed on screen is
 * (local speed / freestream speed) x this value.
 */
export const VISUAL_FREESTREAM_SPEED = 3.6;
const MAX_AGE_SECONDS = 9;
/** Distance over which "ink" streaks grow in and taper out at the ends of the window, m. */
const TAPER_LENGTH = 1.6;
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Tracer particles advected through the flow field. One instanced mesh draws
 * every particle; each is stretched along its velocity and coloured by speed.
 */
export function FlowParticles({ field, count, playing, halfWidth, height, xStart, xEnd, palette = "speed" }: FlowParticlesProps) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const state = useMemo(
    () => ({
      position: new Float32Array(count * 3),
      age: new Float32Array(count),
    }),
    [count],
  );

  const scratch = useMemo(
    () => ({
      sample: createFieldSample(),
      matrix: new THREE.Matrix4(),
      quaternion: new THREE.Quaternion(),
      direction: new THREE.Vector3(),
      position: new THREE.Vector3(),
      scale: new THREE.Vector3(),
      color: new THREE.Color(),
      rgb: [0, 0, 0],
    }),
    [],
  );

  const seed = (index: number, anywhere: boolean) => {
    // Denser seeding near the centreline and the ground, where the car is.
    const lateral = (Math.random() * 2 - 1) * (Math.random() < 0.6 ? 0.55 : 1) * halfWidth;
    const vertical = 0.03 + Math.pow(Math.random(), 1.35) * height;
    state.position[index * 3] = anywhere ? xStart + Math.random() * (xEnd - xStart) : xStart;
    state.position[index * 3 + 1] = lateral;
    state.position[index * 3 + 2] = vertical;
    state.age[index] = anywhere ? Math.random() * MAX_AGE_SECONDS : 0;
  };

  // (Re)seed everything when the field or the particle budget changes.
  useEffect(() => {
    for (let i = 0; i < count; i++) seed(i, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, count, halfWidth, height, xStart, xEnd]);

  useFrame((_, delta) => {
    const instanced = mesh.current;
    if (!instanced) return;
    const dt = playing ? Math.min(delta, 0.05) : 0;
    const { sample, matrix, quaternion, direction, position, scale, color, rgb } = scratch;

    for (let i = 0; i < count; i++) {
      const o = i * 3;
      let x = state.position[o];
      let y = state.position[o + 1];
      let z = state.position[o + 2];
      sampleField(field, x, y, z, sample);

      if (dt > 0) {
        // Midpoint (RK2) step keeps particles on curved paths around the body.
        const hx = x + 0.5 * dt * VISUAL_FREESTREAM_SPEED * sample.u;
        const hy = y + 0.5 * dt * VISUAL_FREESTREAM_SPEED * sample.v;
        const hz = z + 0.5 * dt * VISUAL_FREESTREAM_SPEED * sample.w;
        sampleField(field, hx, hy, Math.max(hz, 0.005), sample);
        x += dt * VISUAL_FREESTREAM_SPEED * sample.u;
        y += dt * VISUAL_FREESTREAM_SPEED * sample.v;
        z = Math.max(z + dt * VISUAL_FREESTREAM_SPEED * sample.w, 0.005);
        state.age[i] += dt;

        const stuck = sample.kind === CELL_SOLID || sample.u * sample.u + sample.v * sample.v + sample.w * sample.w < 1e-4;
        if (x > xEnd || x < xStart - 0.5 || Math.abs(y) > halfWidth * 1.6 || stuck || state.age[i] > MAX_AGE_SECONDS) {
          seed(i, false);
          x = state.position[o];
          y = state.position[o + 1];
          z = state.position[o + 2];
          sampleField(field, x, y, z, sample);
        } else {
          state.position[o] = x;
          state.position[o + 1] = y;
          state.position[o + 2] = z;
        }
      }

      const speed = Math.sqrt(sample.u * sample.u + sample.v * sample.v + sample.w * sample.w);
      if (speed > 1e-4) direction.set(sample.u / speed, sample.v / speed, sample.w / speed);
      else direction.copy(X_AXIS);
      quaternion.setFromUnitVectors(X_AXIS, direction);
      position.set(x, y, z);
      const stretch = 0.4 + 1.1 * Math.min(speed, 1.8);
      if (palette === "ink") {
        const edge = Math.min((x - xStart) / TAPER_LENGTH, (xEnd - x) / TAPER_LENGTH, 1);
        const taper = edge <= 0 ? 0 : edge * edge * (3 - 2 * edge);
        scale.set(stretch * taper, taper, taper);
        inkColor(velocityT(speed), rgb);
      } else {
        scale.set(stretch, 1, 1);
        scaleColor(velocityT(speed), rgb);
      }
      matrix.compose(position, quaternion, scale);
      instanced.setMatrixAt(i, matrix);

      color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      instanced.setColorAt(i, color);
    }
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} frustumCulled={false}>
      <boxGeometry args={[0.11, 0.011, 0.011]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
