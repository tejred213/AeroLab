"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { DressedCar } from "@/components/3d/CarDetail";
import { PaintedModel, type PaintedModelData } from "@/components/3d/PaintedModel";
import { SCENE_COLORS } from "@/components/3d/sceneSetup";
import { buildBodyMesh } from "@/lib/geometry/mesh";
import {
  buildBodyShape,
  mirrorGeometry,
  planHalfWidth,
  skirtGeometry,
  splitterGeometry,
  spoilerGeometry,
  wheelGeometry,
  wingGeometry,
} from "@/lib/geometry/profile";
import { shapeFor } from "@/lib/geometry/sampledBody";
import { buildTrimLayout, sectionAttribute } from "@/lib/geometry/trim";
import { DEG_TO_RAD } from "@/lib/physics/model";
import { CELL_SOLID, createFieldSample, type FlowField, sampleField } from "@/lib/simulation/field";
import type { BodyStyle } from "@/lib/state/viewStore";
import type { GeometryParams } from "@/lib/types";
import { pressureT, scaleColor } from "@/lib/utils/colormap";
import type { CarAppearance } from "@/lib/vehicle/appearance";

interface VehicleModelProps {
  geometry: GeometryParams;
  bodyStyle: BodyStyle;
  /** Opacity used by the "transparent" style. */
  opacity: number;
  /** Field used to colour the surface by pressure coefficient. */
  field: FlowField | null;
  /** Single flat colour override (used for ghost overlays in difference views). */
  tint?: string;
  /** Measured envelope of an imported 3D model to draw instead of the parametric surface (must be loaded). */
  bodyId?: string;
  /** The imported model itself; drawn in place of the body and wheels in the "solid" style. */
  painted?: PaintedModelData | null;
  /**
   * Dress the car in the "solid" style: paint, glazing, door cuts, lights, mirrors and detailed wheels.
   * Appearance only; the simulated shape is the smooth body and plain wheels of the other styles.
   */
  appearance?: CarAppearance | null;
}

/** Distance from the surface at which the pressure field is sampled, m (about one grid cell). */
const SURFACE_SAMPLE_OFFSET = 0.07;

/**
 * Procedurally generated vehicle. Every part is rebuilt from the geometry
 * parameters, so the picture always matches what is simulated.
 */
export function VehicleModel({ geometry, bodyStyle, opacity, field, tint, bodyId, painted, appearance }: VehicleModelProps) {
  const shape = useMemo(() => {
    try {
      return shapeFor(geometry, bodyId);
    } catch {
      // The envelope is not loaded or no longer fits: draw the parametric surface.
      return buildBodyShape(geometry);
    }
  }, [geometry, bodyId]);
  const showPainted = !!painted && bodyStyle === "solid" && tint === undefined;
  // The details are placed from the shape parameters, so they are not drawn on a measured envelope.
  const trim = useMemo(
    () => (appearance && !shape.sampled && bodyStyle === "solid" && tint === undefined && !showPainted ? buildTrimLayout(shape, appearance) : null),
    [appearance, shape, bodyStyle, tint, showPainted],
  );

  const bodyGeometry = useMemo(() => {
    const mesh = buildBodyMesh(shape);
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    buffer.setAttribute("glass", new THREE.BufferAttribute(mesh.glass, 1));
    buffer.setAttribute("aSection", new THREE.BufferAttribute(sectionAttribute(shape, mesh.positions), 3));
    buffer.setAttribute("color", new THREE.BufferAttribute(new Float32Array(mesh.positions.length), 3));
    buffer.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    buffer.computeVertexNormals();
    return buffer;
  }, [shape]);

  useEffect(() => () => bodyGeometry.dispose(), [bodyGeometry]);

  // Vertex colours: paint + glazing, or surface pressure sampled from the flow field.
  useEffect(() => {
    const position = bodyGeometry.getAttribute("position");
    const normal = bodyGeometry.getAttribute("normal");
    const glass = bodyGeometry.getAttribute("glass");
    const color = bodyGeometry.getAttribute("color") as THREE.BufferAttribute;
    const paint = new THREE.Color(tint ?? SCENE_COLORS.paint);
    const glazing = new THREE.Color(tint ?? SCENE_COLORS.glass);
    const scratch = new THREE.Color();
    const rgb = [0, 0, 0];
    const sample = createFieldSample();
    const showPressure = bodyStyle === "pressure" && field !== null && !tint;

    for (let i = 0; i < position.count; i++) {
      if (showPressure && field) {
        let offset = SURFACE_SAMPLE_OFFSET;
        for (let attempt = 0; attempt < 3; attempt++) {
          sampleField(
            field,
            position.getX(i) + normal.getX(i) * offset,
            position.getY(i) + normal.getY(i) * offset,
            Math.max(position.getZ(i) + normal.getZ(i) * offset, 0.01),
            sample,
          );
          if (sample.kind !== CELL_SOLID) break;
          offset += SURFACE_SAMPLE_OFFSET;
        }
        scaleColor(pressureT(sample.cp), rgb);
        scratch.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
        color.setXYZ(i, scratch.r, scratch.g, scratch.b);
      } else {
        const source = glass.getX(i) > 0.5 ? glazing : paint;
        color.setXYZ(i, source.r, source.g, source.b);
      }
    }
    color.needsUpdate = true;
  }, [bodyGeometry, bodyStyle, field, tint]);

  const wheels = useMemo(() => wheelGeometry(shape), [shape]);
  const spoiler = useMemo(() => spoilerGeometry(shape), [shape]);
  const wing = useMemo(() => wingGeometry(shape), [shape]);
  const splitter = useMemo(() => splitterGeometry(shape), [shape]);
  const skirt = useMemo(() => skirtGeometry(shape), [shape]);
  const mirror = useMemo(() => mirrorGeometry(shape), [shape]);

  const ride = geometry.rideHeight;
  const wireframe = bodyStyle === "wireframe";
  const transparent = bodyStyle === "transparent" || tint !== undefined;
  const bodyOpacity = tint ? 0.4 : transparent ? opacity : 1;

  const deviceMaterial = (
    <meshStandardMaterial
      color={tint ?? SCENE_COLORS.device}
      roughness={0.7}
      metalness={0.1}
      wireframe={wireframe}
      transparent={transparent}
      opacity={bodyOpacity}
    />
  );

  const bladeLength = geometry.spoilerHeight;
  const spoilerAngle = geometry.spoilerAngle * DEG_TO_RAD;
  const wingAngle = wing.angleDeg * DEG_TO_RAD;
  const tailHalfWidth = planHalfWidth(shape, shape.length);

  return (
    <group>
      {showPainted && painted && <PaintedModel scene={painted.scene} matrix={painted.matrix} lift={painted.lift} />}
      {trim && appearance && <DressedCar geometry={bodyGeometry} layout={trim} look={appearance} />}
      {!showPainted && !trim && (
        <mesh geometry={bodyGeometry} castShadow={false}>
          <meshStandardMaterial
            vertexColors
            roughness={bodyStyle === "pressure" ? 0.85 : 0.42}
            metalness={bodyStyle === "pressure" ? 0 : 0.35}
            wireframe={wireframe}
            transparent={transparent}
            opacity={bodyOpacity}
            depthWrite={!transparent}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* The mirror housings as the solver has them: shown whenever the simulated shape itself is drawn. */}
      {mirror.present &&
        !showPainted &&
        !trim &&
        [1, -1].map((side) => (
          <mesh
            key={`mirror-${side}`}
            position={[(mirror.x0 + mirror.x1) / 2, (side * (mirror.y0 + mirror.y1)) / 2, ride + (mirror.z0 + mirror.z1) / 2]}
          >
            <boxGeometry args={[mirror.x1 - mirror.x0, mirror.y1 - mirror.y0, mirror.z1 - mirror.z0]} />
            <meshStandardMaterial
              color={tint ?? SCENE_COLORS.paint}
              roughness={0.5}
              metalness={0.3}
              wireframe={wireframe}
              transparent={transparent}
              opacity={bodyOpacity}
            />
          </mesh>
        ))}

      {(showPainted || trim ? [] : wheels).map((wheel) =>
        [1, -1].map((side) => (
          <group key={`${wheel.x}-${side}`} position={[wheel.x, side * wheel.y, wheel.z]}>
            {/* three.js cylinders are aligned with the local Y axis, which is the axle direction here. */}
            <mesh>
              <cylinderGeometry args={[wheel.radius, wheel.radius, wheel.width, 40]} />
              <meshStandardMaterial
                color={tint ?? SCENE_COLORS.tyre}
                roughness={0.9}
                wireframe={wireframe}
                transparent={transparent}
                opacity={bodyOpacity}
              />
            </mesh>
            <mesh position={[0, side * (wheel.width / 2 + 0.002), 0]}>
              <cylinderGeometry args={[wheel.radius * 0.62, wheel.radius * 0.62, 0.006, 28]} />
              <meshStandardMaterial
                color={tint ?? SCENE_COLORS.rim}
                roughness={0.5}
                metalness={0.6}
                wireframe={wireframe}
                transparent={transparent}
                opacity={bodyOpacity}
              />
            </mesh>
          </group>
        )),
      )}

      {spoiler.present && (
        <mesh
          position={[(spoiler.x0 + spoiler.x1) / 2, 0, ride + (spoiler.z0 + spoiler.z1) / 2]}
          rotation={[0, -spoilerAngle, 0]}
        >
          <boxGeometry args={[bladeLength, 2 * spoiler.halfWidth, spoiler.thickness]} />
          {deviceMaterial}
        </mesh>
      )}

      {wing.present && (
        <group>
          <mesh position={[wing.xc, 0, ride + wing.zc]} rotation={[0, -wingAngle, 0]}>
            <boxGeometry args={[wing.chord, wing.span, wing.thickness]} />
            {deviceMaterial}
          </mesh>
          {[1, -1].map((side) => (
            <group key={side}>
              {/* End plate */}
              <mesh position={[wing.xc, (side * wing.span) / 2, ride + wing.zc]}>
                <boxGeometry args={[wing.chord * 1.15, 0.008, wing.chord * 0.5]} />
                {deviceMaterial}
              </mesh>
              {/* Support strut */}
              <mesh
                position={[
                  wing.xc,
                  side * Math.min(wing.span * 0.3, tailHalfWidth * 0.7),
                  ride + (shape.tailHeight + wing.zc) / 2,
                ]}
              >
                <boxGeometry args={[0.07, 0.012, Math.max(wing.zc - shape.tailHeight, 0.02)]} />
                {deviceMaterial}
              </mesh>
            </group>
          ))}
        </group>
      )}

      {splitter.present && (
        <mesh position={[(splitter.x0 + splitter.x1) / 2, 0, ride + splitter.thickness / 2]}>
          <boxGeometry args={[splitter.x1 - splitter.x0, 2 * splitter.halfWidth, splitter.thickness]} />
          {deviceMaterial}
        </mesh>
      )}

      {skirt.present &&
        [1, -1].map((side) => (
          <mesh
            key={side}
            position={[
              (skirt.x0 + skirt.x1) / 2,
              side * (skirt.yOuter - skirt.thickness / 2),
              ride + (0.03 - skirt.depth) / 2,
            ]}
          >
            <boxGeometry args={[skirt.x1 - skirt.x0, skirt.thickness, skirt.depth + 0.03]} />
            {deviceMaterial}
          </mesh>
        ))}
    </group>
  );
}
