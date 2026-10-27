/**
 * Measured bodies of imported 3D models, by id.
 *
 * A measured body is too large to travel inside every simulation configuration,
 * so a configuration names it (SimulationConfig.bodyId) and each JavaScript
 * context that solves, the page and the simulation worker, keeps its own copy here.
 */
import { type BodyShape, buildBodyShape, type SampledBody, withSampledBody } from "@/lib/geometry/profile";
import { SHAPE_PARAMS } from "@/lib/geometry/meshImport";
import {
  type GeometryParams,
  type ImportedModelInfo,
  type ParamId,
  type SimulationConfig,
  SimulationError,
} from "@/lib/types";

const bodies = new Map<string, SampledBody>();

export function registerSampledBody(body: SampledBody): void {
  bodies.set(body.id, body);
}

export function getSampledBody(id: string): SampledBody | undefined {
  return bodies.get(id);
}

export function removeSampledBody(id: string): void {
  bodies.delete(id);
}

/** Largest change of a shape parameter that still counts as "unchanged" (below every slider step). */
const SHAPE_TOLERANCE = 1e-6;

/** True while every shape parameter still has the value that was fitted to the imported model. */
export function matchesImportedShape(model: ImportedModelInfo, geometry: GeometryParams): boolean {
  for (const [param, value] of Object.entries(model.shapeParams) as [ParamId, number][]) {
    if (Math.abs(geometry[param] - value) > SHAPE_TOLERANCE) return false;
  }
  return true;
}

/** Id of the measured body to solve on, or undefined when the parametric surface applies. */
export function bodyIdFor(model: ImportedModelInfo | undefined, geometry: GeometryParams): string | undefined {
  return model && matchesImportedShape(model, geometry) ? model.bodyId : undefined;
}

/**
 * The body shape of a configuration: the parametric surface, or the measured
 * envelope of an imported model when the configuration names one.
 */
export function shapeFor(geometry: GeometryParams, bodyId?: string): BodyShape {
  const shape = buildBodyShape(geometry);
  if (!bodyId) return shape;
  const body = bodies.get(bodyId);
  if (!body) {
    throw new SimulationError(
      "IMPORTED_BODY_MISSING",
      "The measured shape of this imported 3D model is not loaded. Open the vehicle again from the library, or import the model again.",
    );
  }
  if (Math.abs(body.length - shape.length) > 2 * body.dx) {
    throw new SimulationError(
      "IMPORTED_BODY_MISMATCH",
      "The length parameters no longer match the imported 3D model, so its measured shape cannot be used.",
    );
  }
  return withSampledBody(shape, body);
}

/**
 * Configuration for a study that varies some parameters. A measured body is one
 * fixed shape: when a shape parameter varies, every point of the study uses the
 * parametric surface fitted to the model instead, so the points stay comparable.
 */
export function studyConfig(config: SimulationConfig, varied: (ParamId | null | undefined)[]): SimulationConfig {
  if (!config.bodyId || !varied.some((param) => param != null && SHAPE_PARAMS.includes(param))) return config;
  const { bodyId: _dropped, ...rest } = config;
  return rest;
}

/** Suffix for a study's provenance line that says which body surface was used. */
export function studySurfaceNote(original: SimulationConfig, used: SimulationConfig): string {
  if (!original.bodyId) return "";
  return used.bodyId
    ? " · measured envelope of the imported 3D model"
    : " · parametric fit of the imported 3D model (a shape parameter varies)";
}
