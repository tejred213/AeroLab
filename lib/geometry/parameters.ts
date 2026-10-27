import parameterData from "@/shared/parameters.json";
import type { GeometryParams, ParamDefinition, ParamGroup, ParamId } from "@/lib/types";

export const PARAM_GROUPS: ParamGroup[] = parameterData.groups;

export const PARAM_DEFINITIONS: ParamDefinition[] = parameterData.parameters as ParamDefinition[];

export const PARAM_BY_ID: Record<ParamId, ParamDefinition> = Object.fromEntries(
  PARAM_DEFINITIONS.map((definition) => [definition.id, definition]),
) as Record<ParamId, ParamDefinition>;

export const PARAM_IDS: ParamId[] = PARAM_DEFINITIONS.map((definition) => definition.id);

/** Parameters added after the first release, with the value a geometry stored before them is given. */
const LATER_PARAMS: [ParamId, number][] = PARAM_DEFINITIONS.filter((definition) => definition.default !== undefined).map(
  (definition) => [definition.id, definition.default as number],
);

/**
 * A geometry with every parameter present. Vehicles, experiments and imported models saved by an older
 * version lack the parameters added since; they get the documented default. Returns the same object when
 * nothing is missing.
 */
export function completeGeometry(geometry: GeometryParams): GeometryParams {
  let complete = geometry;
  for (const [id, value] of LATER_PARAMS) {
    if (!Number.isFinite(complete[id])) {
      if (complete === geometry) complete = { ...geometry };
      complete[id] = value;
    }
  }
  return complete;
}

export function clampParam(id: ParamId, value: number): number {
  const { min, max } = PARAM_BY_ID[id];
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Returns a copy with every parameter clamped to its allowed range. */
export function clampGeometry(geometry: GeometryParams): GeometryParams {
  const clamped = { ...geometry };
  for (const id of PARAM_IDS) clamped[id] = clampParam(id, geometry[id]);
  return clamped;
}

/** Overall length is a linked quantity: front overhang + wheelbase + rear overhang. */
export function overallLength(geometry: GeometryParams): number {
  return geometry.frontOverhang + geometry.wheelbase + geometry.rearOverhang;
}

/** Roof crown above the ground (excludes spoiler / wing). */
export function roofHeightAboveGround(geometry: GeometryParams): number {
  return geometry.rideHeight + geometry.roofHeight;
}

/** Applies an overall-length edit by stretching the wheelbase and keeping the overhangs. */
export function withOverallLength(geometry: GeometryParams, length: number): GeometryParams {
  const wheelbase = clampParam("wheelbase", length - geometry.frontOverhang - geometry.rearOverhang);
  return { ...geometry, wheelbase };
}

/** Applies an overall-height edit by changing the roof height and keeping the ride height. */
export function withOverallHeight(geometry: GeometryParams, height: number): GeometryParams {
  const roofHeight = clampParam("roofHeight", height - geometry.rideHeight);
  return { ...geometry, roofHeight };
}

export const LENGTH_RANGE = {
  min: PARAM_BY_ID.frontOverhang.min + PARAM_BY_ID.wheelbase.min + PARAM_BY_ID.rearOverhang.min,
  max: PARAM_BY_ID.frontOverhang.max + PARAM_BY_ID.wheelbase.max + PARAM_BY_ID.rearOverhang.max,
};

/** Lists the parameters whose values differ between two geometries. */
export function diffGeometry(
  base: GeometryParams,
  modified: GeometryParams,
): { id: ParamId; from: number; to: number }[] {
  const changes: { id: ParamId; from: number; to: number }[] = [];
  for (const id of PARAM_IDS) {
    const step = PARAM_BY_ID[id].step;
    if (Math.abs(base[id] - modified[id]) > step * 1e-3) {
      changes.push({ id, from: base[id], to: modified[id] });
    }
  }
  return changes;
}
