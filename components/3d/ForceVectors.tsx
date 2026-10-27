"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { Label } from "@/components/3d/Label";
import type { AeroForces, GeometryParams } from "@/lib/types";

interface ArrowProps {
  origin: [number, number, number];
  direction: [number, number, number];
  length: number;
  color: string;
  label: string;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function Arrow({ origin, direction, length, color, label }: ArrowProps) {
  const quaternion = useMemo(
    () => new THREE.Quaternion().setFromUnitVectors(Y_AXIS, new THREE.Vector3(...direction).normalize()),
    [direction],
  );
  const head = 0.16;
  const shaft = Math.max(length - head, 0.02);
  return (
    <group position={origin} quaternion={quaternion}>
      <mesh position={[0, shaft / 2, 0]}>
        <cylinderGeometry args={[0.018, 0.018, shaft, 10]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh position={[0, shaft + head / 2, 0]}>
        <coneGeometry args={[0.055, head, 14]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <Label position={[0, length + 0.14, 0]} text={label} color={color} boxed />
    </group>
  );
}

interface ForceVectorsProps {
  geometry: GeometryParams;
  forces: AeroForces;
  /** Formats a force in the active unit system, including its unit. */
  formatForce: (newton: number) => string;
}

const MIN_LENGTH = 0.35;
const EXTRA_LENGTH = 1.25;

/** Resultant aerodynamic forces drawn at the vehicle, to scale relative to each other. */
export function ForceVectors({ geometry, forces, formatForce }: ForceVectorsProps) {
  const length = geometry.frontOverhang + geometry.wheelbase + geometry.rearOverhang;
  const roof = geometry.rideHeight + geometry.roofHeight;
  const largest = Math.max(Math.abs(forces.drag), Math.abs(forces.lift), Math.abs(forces.side), 1e-6);
  const arrowLength = (force: number) => MIN_LENGTH + (EXTRA_LENGTH * Math.abs(force)) / largest;

  const liftLength = arrowLength(forces.lift);
  const isDownforce = forces.lift < 0;
  const sideSign = forces.side >= 0 ? 1 : -1;
  return (
    <group>
      <Arrow
        origin={[length + 0.15, 0, 0.6]}
        direction={[1, 0, 0]}
        length={arrowLength(forces.drag)}
        color="#f2a33a"
        label={`Drag ${formatForce(forces.drag)}`}
      />
      {/* Downforce is drawn pointing down onto the roof; lift pointing up from it. */}
      <Arrow
        origin={[length * 0.5, 0, roof + 0.1 + (isDownforce ? liftLength : 0)]}
        direction={[0, 0, isDownforce ? -1 : 1]}
        length={liftLength}
        color="#5cc8f0"
        label={isDownforce ? `Downforce ${formatForce(forces.downforce)}` : `Lift ${formatForce(forces.lift)}`}
      />
      {Math.abs(forces.side) > 1 && (
        <Arrow
          origin={[length * 0.5, sideSign * (geometry.width / 2 + 0.1), 0.7]}
          direction={[0, sideSign, 0]}
          length={arrowLength(forces.side)}
          color="#58c88a"
          label={`Side ${formatForce(Math.abs(forces.side))}`}
        />
      )}
    </group>
  );
}
