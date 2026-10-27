/**
 * Samples a flow field along the vehicle centreline, just off the upper and
 * lower surfaces. Gives the classic Cp(x) and surface-speed distributions.
 */
import { buildBodyShape, lowerZ, upperZ } from "@/lib/geometry/profile";
import { CELL_SOLID, createFieldSample, type FlowField, sampleField } from "@/lib/simulation/field";
import type { GeometryParams } from "@/lib/types";

/** Distance from the surface at which the field is sampled, m (about one grid cell). */
export const PROBE_OFFSET = 0.07;

export interface SurfaceProbePoint {
  x: number;
  cpUpper: number | null;
  cpLower: number | null;
  /** Speed ratio V / V_inf. */
  speedUpper: number | null;
  speedLower: number | null;
}

export function probeCentreline(field: FlowField, geometry: GeometryParams, count = 72): SurfaceProbePoint[] {
  const shape = buildBodyShape(geometry);
  const ride = geometry.rideHeight;
  const sample = createFieldSample();
  const points: SurfaceProbePoint[] = [];

  const read = (x: number, z: number) => {
    sampleField(field, x, 0, Math.max(z, 0.01), sample);
    if (!sample.inside || sample.kind === CELL_SOLID) return null;
    return { cp: sample.cp, speed: Math.sqrt(sample.u * sample.u + sample.v * sample.v + sample.w * sample.w) };
  };

  for (let i = 0; i <= count; i++) {
    const x = 0.03 + ((shape.length - 0.06) * i) / count;
    const upper = read(x, ride + upperZ(shape, x) + PROBE_OFFSET);
    const clearance = ride + lowerZ(shape, x);
    const lower = read(x, clearance - Math.min(PROBE_OFFSET, 0.5 * clearance));
    points.push({
      x,
      cpUpper: upper?.cp ?? null,
      cpLower: lower?.cp ?? null,
      speedUpper: upper?.speed ?? null,
      speedLower: lower?.speed ?? null,
    });
  }
  return points;
}

/** Vertical speed profile on the centreline at station x: speed ratio versus height. */
export function probeVerticalProfile(field: FlowField, x: number, top: number, count = 40): { z: number; speed: number }[] {
  const sample = createFieldSample();
  const profile: { z: number; speed: number }[] = [];
  for (let i = 0; i <= count; i++) {
    const z = 0.02 + ((top - 0.02) * i) / count;
    sampleField(field, x, 0, z, sample);
    if (sample.kind === CELL_SOLID) continue;
    // Signed by the streamwise direction so reversed (recirculating) flow shows as negative.
    const magnitude = Math.sqrt(sample.u * sample.u + sample.v * sample.v + sample.w * sample.w);
    profile.push({ z, speed: sample.u < 0 ? -magnitude : magnitude });
  }
  return profile;
}
