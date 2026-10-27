"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { CELL_SOLID, createFieldSample, type FlowField, sampleField } from "@/lib/simulation/field";
import { pressureT, scaleColor, velocityT } from "@/lib/utils/colormap";

export type SliceQuantity = "velocity" | "pressure";

interface SlicePlaneProps {
  field: FlowField;
  quantity: SliceQuantity;
  axis: "x" | "y" | "z";
  position: number;
  /** Region covered by the slice. */
  xRange: [number, number];
  halfWidth: number;
  height: number;
}

const PIXELS_PER_METRE = 38;

/**
 * Contour plane through the flow field: velocity magnitude or pressure
 * coefficient on a cut normal to X, Y or Z.
 */
export function SlicePlane({ field, quantity, axis, position, xRange, halfWidth, height }: SlicePlaneProps) {
  const { geometry, texture } = useMemo(() => {
    // The two in-plane directions (a, b) and their extents.
    const aRange: [number, number] = axis === "x" ? [-halfWidth, halfWidth] : xRange;
    const bRange: [number, number] = axis === "z" ? [-halfWidth, halfWidth] : [0, height];
    const width = Math.max(Math.round((aRange[1] - aRange[0]) * PIXELS_PER_METRE), 2);
    const rows = Math.max(Math.round((bRange[1] - bRange[0]) * PIXELS_PER_METRE), 2);
    const data = new Uint8Array(width * rows * 4);
    const sample = createFieldSample();
    const rgb = [0, 0, 0];

    const worldPoint = (a: number, b: number): [number, number, number] => {
      if (axis === "y") return [a, position, b];
      if (axis === "z") return [a, b, position];
      return [position, a, b];
    };

    for (let row = 0; row < rows; row++) {
      const b = bRange[0] + ((row + 0.5) / rows) * (bRange[1] - bRange[0]);
      for (let column = 0; column < width; column++) {
        const a = aRange[0] + ((column + 0.5) / width) * (aRange[1] - aRange[0]);
        const [x, y, z] = worldPoint(a, b);
        sampleField(field, x, y, Math.max(z, 0.005), sample);
        const o = (row * width + column) * 4;
        if (sample.kind === CELL_SOLID || !sample.inside) {
          data[o + 3] = 0;
          continue;
        }
        const t =
          quantity === "velocity"
            ? velocityT(Math.sqrt(sample.u * sample.u + sample.v * sample.v + sample.w * sample.w))
            : pressureT(sample.cp);
        scaleColor(t, rgb);
        data[o] = Math.round(rgb[0] * 255);
        data[o + 1] = Math.round(rgb[1] * 255);
        data[o + 2] = Math.round(rgb[2] * 255);
        data[o + 3] = 215;
      }
    }

    const map = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat);
    map.colorSpace = THREE.SRGBColorSpace;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearFilter;
    map.needsUpdate = true;

    const corners = [
      worldPoint(aRange[0], bRange[0]),
      worldPoint(aRange[1], bRange[0]),
      worldPoint(aRange[1], bRange[1]),
      worldPoint(aRange[0], bRange[1]),
    ];
    const quad = new THREE.BufferGeometry();
    quad.setAttribute("position", new THREE.Float32BufferAttribute(corners.flat(), 3));
    quad.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    return { geometry: quad, texture: map };
  }, [field, quantity, axis, position, xRange, halfWidth, height]);

  useEffect(
    () => () => {
      geometry.dispose();
      texture.dispose();
    },
    [geometry, texture],
  );

  return (
    <mesh geometry={geometry} renderOrder={1}>
      <meshBasicMaterial map={texture} transparent side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}
