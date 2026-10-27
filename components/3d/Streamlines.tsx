"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { VISUAL_FREESTREAM_SPEED } from "@/components/3d/FlowParticles";
import type { FlowField } from "@/lib/simulation/field";
import { traceStreamlines } from "@/lib/simulation/streamlines";
import { scaleColor, velocityT } from "@/lib/utils/colormap";

interface StreamlinesProps {
  field: FlowField;
  /** Pulses travel along the lines while this is true; false freezes them where they are. */
  playing: boolean;
  halfWidth: number;
  height: number;
  xStart: number;
  xEnd: number;
}

/** Time between two pulses passing a point, s on screen. */
const PULSE_PERIOD = 1.3;

const VERTEX_SHADER = /* glsl */ `
attribute vec3 aColor;
attribute float aTime;
attribute float aPhase;
varying vec3 vColor;
varying float vTime;
varying float vPhase;
void main() {
  vColor = aColor;
  vTime = aTime;
  vPhase = aPhase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * The whole line stays faintly visible, so its shape can always be read. On top of it bright pulses run
 * downstream: each point lights up when a pulse reaches it (its time of flight from the seed) and fades
 * afterwards, which draws a sharp head with a tail behind it.
 */
const FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform float uPeriod;
varying vec3 vColor;
varying float vTime;
varying float vPhase;
void main() {
  float sincePulse = fract((uTime - vTime) / uPeriod + vPhase);
  float tail = exp(-5.5 * sincePulse);
  float head = 1.0 - smoothstep(0.0, 0.05, sincePulse);
  gl_FragColor = vec4(mix(vColor, vec3(1.0), 0.55 * head), 0.2 + 0.8 * tail);
  #include <colorspace_fragment>
}
`;

/**
 * Streamlines coloured by local speed, with pulses that travel along them at the local flow speed.
 * The motion uses the same time scale as the tracer particles: on screen the undisturbed flow moves at
 * VISUAL_FREESTREAM_SPEED, so pulses bunch up where the air is slow and stretch out where it is fast.
 */
export function Streamlines({ field, playing, halfWidth, height, xStart, xEnd }: StreamlinesProps) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const times: number[] = [];
    const phases: number[] = [];
    const rgb = [0, 0, 0];
    const color = new THREE.Color();

    traceStreamlines(field, { halfWidth, height, xStart, xEnd }).forEach((line, index) => {
      // Each line starts its pulses at a different moment (golden-ratio spacing), so they do not march in step.
      const phase = (index * 0.61803398875) % 1;
      const vertex = (i: number) => {
        positions.push(line.positions[3 * i], line.positions[3 * i + 1], line.positions[3 * i + 2]);
        scaleColor(velocityT(line.speeds[i]), rgb);
        color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
        colors.push(color.r, color.g, color.b);
        times.push(line.travel[i] / VISUAL_FREESTREAM_SPEED);
        phases.push(phase);
      };
      for (let i = 1; i < line.speeds.length; i++) {
        vertex(i - 1);
        vertex(i);
      }
    });

    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    buffer.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 3));
    buffer.setAttribute("aTime", new THREE.Float32BufferAttribute(times, 1));
    buffer.setAttribute("aPhase", new THREE.Float32BufferAttribute(phases, 1));
    return buffer;
  }, [field, halfWidth, height, xStart, xEnd]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        uniforms: { uTime: { value: 0 }, uPeriod: { value: PULSE_PERIOD } },
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame((_, delta) => {
    // A long gap between frames (a hidden tab) must not make the pulses jump.
    if (playing) material.uniforms.uTime.value += Math.min(delta, 0.1);
  });

  return <lineSegments geometry={geometry} material={material} frustumCulled={false} />;
}
