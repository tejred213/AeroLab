"use client";

import "@/components/3d/sceneSetup";
import { GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { memo, useMemo } from "react";
import { CameraRig } from "@/components/3d/CameraRig";
import { FlowParticles } from "@/components/3d/FlowParticles";
import { ForceVectors } from "@/components/3d/ForceVectors";
import { SCENE_COLORS } from "@/components/3d/sceneSetup";
import { SlicePlane } from "@/components/3d/SlicePlane";
import { StudioFloor } from "@/components/3d/StudioFloor";
import { Streamlines } from "@/components/3d/Streamlines";
import type { PaintedModelData } from "@/components/3d/PaintedModel";
import type { CarAppearance } from "@/lib/vehicle/appearance";
import { VehicleModel } from "@/components/3d/VehicleModel";
import { WrappedSurface, type WrappedSurfaceData } from "@/components/3d/WrappedSurface";
import { SeparationMarkers, WakeShell } from "@/components/3d/WakeLayers";
import { WindTunnel } from "@/components/3d/WindTunnel";
import { overallLength } from "@/lib/geometry/parameters";
import type { FlowField } from "@/lib/simulation/field";
import type { BodyStyle, CameraPreset, FlowLayers } from "@/lib/state/viewStore";
import type { AeroForces, GeometryParams } from "@/lib/types";

export interface TunnelSceneProps {
  /** Geometry drawn in the tunnel (follows the sliders immediately). */
  geometry: GeometryParams;
  /** Geometry the flow field and forces were computed for; null before the first run. */
  resultGeometry: GeometryParams | null;
  field: FlowField | null;
  forces: AeroForces | null;
  bodyStyle: BodyStyle;
  bodyOpacity: number;
  layers: FlowLayers;
  sliceAxis: "x" | "y" | "z";
  slicePosition: number;
  playing: boolean;
  particleCount: number;
  camera: { preset: CameraPreset; nonce: number };
  formatForce: (newton: number) => string;
  /** Second vehicle drawn as a translucent overlay (geometry-difference view). */
  ghostGeometry?: GeometryParams | null;
  /** Measured envelope of an imported 3D model, drawn instead of the parametric surface. */
  bodyId?: string;
  /** The imported model itself, drawn in the "solid" style. */
  painted?: PaintedModelData | null;
  /** The closed surface Mode C meshes for an imported model; drawn instead of the vehicle when given. */
  wrap?: WrappedSurfaceData | null;
  /** Dress the car in the "solid" style (appearance only). */
  appearance?: CarAppearance | null;
  autoRotate?: boolean;
  showLabels?: boolean;
  showGizmo?: boolean;
  enableZoom?: boolean;
  /** Multiplies the camera's distance from the car; above 1 stands further back. */
  cameraDistance?: number;
  /** Stop drawing frames (the scene is off screen). */
  suspended?: boolean;
  /**
   * "tunnel" is the dark test section of the simulator. "studio" is the landing page's white backdrop:
   * no tunnel walls, a floor grid that fades out, and the flow drawn in a single hue.
   */
  backdrop?: "tunnel" | "studio";
}

/** The complete 3D wind-tunnel scene: tunnel, vehicle, flow layers, camera and orientation gizmo. */
export const TunnelScene = memo(function TunnelScene(props: TunnelSceneProps) {
  const { geometry, resultGeometry, field, forces, layers } = props;
  const length = overallLength(geometry);

  // Window in which flow layers are drawn: tight around the car so the picture stays readable.
  const region = useMemo(() => {
    const source = resultGeometry ?? geometry;
    return {
      halfWidth: source.width / 2 + 0.9,
      height: source.rideHeight + source.roofHeight + 0.75,
      xStart: -2.8,
      xEnd: overallLength(source) + 6,
      xRange: [-2.8, overallLength(source) + 6] as [number, number],
    };
  }, [resultGeometry, geometry]);

  const sliceQuantity = layers.pressure ? "pressure" : layers.velocity ? "velocity" : null;
  const studio = props.backdrop === "studio";

  return (
    <Canvas
      frameloop={props.suspended ? "never" : "always"}
      dpr={[1, 1.75]}
      camera={{ fov: 32, near: 0.1, far: 200, up: [0, 0, 1], position: [-3, -6, 3.6] }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
    >
      <color attach="background" args={[studio ? "#ffffff" : SCENE_COLORS.background]} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[-4, -7, 9]} intensity={2.1} />
      <directionalLight position={[7, 6, 4]} intensity={0.7} />

      {studio ? <StudioFloor length={length} width={geometry.width} /> : <WindTunnel showLabels={props.showLabels ?? true} />}
      {props.wrap ? (
        <WrappedSurface data={props.wrap} bodyStyle={props.bodyStyle} opacity={props.bodyOpacity} />
      ) : (
        <VehicleModel
          geometry={geometry}
          bodyStyle={props.bodyStyle}
          opacity={props.bodyOpacity}
          field={field}
          bodyId={props.bodyId}
          painted={props.painted}
          appearance={props.appearance}
        />
      )}
      {props.ghostGeometry && (
        <VehicleModel geometry={props.ghostGeometry} bodyStyle="transparent" opacity={0.4} field={null} tint={SCENE_COLORS.ghost} />
      )}

      {field && layers.airflow && (
        <FlowParticles
          field={field}
          count={props.particleCount}
          playing={props.playing}
          halfWidth={region.halfWidth}
          height={region.height}
          xStart={region.xStart}
          xEnd={region.xEnd}
          palette={studio ? "ink" : "speed"}
        />
      )}
      {field && layers.streamlines && (
        <Streamlines
          field={field}
          playing={props.playing}
          halfWidth={region.halfWidth}
          height={region.height}
          xStart={region.xStart}
          xEnd={region.xEnd}
        />
      )}
      {field && sliceQuantity && (
        <SlicePlane
          field={field}
          quantity={sliceQuantity}
          axis={props.sliceAxis}
          position={props.slicePosition}
          xRange={region.xRange}
          halfWidth={region.halfWidth + 0.6}
          height={region.height + 0.4}
        />
      )}
      {resultGeometry && layers.wake && <WakeShell geometry={resultGeometry} />}
      {resultGeometry && layers.separation && <SeparationMarkers geometry={resultGeometry} />}
      {resultGeometry && forces && layers.forces && (
        <ForceVectors geometry={resultGeometry} forces={forces} formatForce={props.formatForce} />
      )}

      <CameraRig
        length={length}
        request={props.camera}
        autoRotate={props.autoRotate}
        enableZoom={props.enableZoom ?? true}
        distanceScale={props.cameraDistance}
      />
      {(props.showGizmo ?? true) && (
        <GizmoHelper alignment="bottom-right" margin={[58, 58]}>
          <GizmoViewport axisColors={["#ef6060", "#58c88a", "#5cc8f0"]} labelColor="#0b0d10" />
        </GizmoHelper>
      )}
    </Canvas>
  );
});
