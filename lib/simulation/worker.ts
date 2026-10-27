/// <reference lib="webworker" />
/**
 * Web Worker entry point: keeps every heavy calculation off the UI thread.
 */
import { type GeometryParams, type JobState, SimulationError, type SimulationConfig } from "@/lib/types";
import { fitGeometry, type FittedGeometry, measureAtScale, type MeasuredModel, type Orientation } from "@/lib/geometry/meshImport";
import type { SampledBody } from "@/lib/geometry/profile";
import { registerSampledBody } from "@/lib/geometry/sampledBody";
import { type WrapOptions, wrapModel } from "@/lib/geometry/wrap";
import { runLocal } from "@/lib/simulation/engine";
import { fieldTransferables } from "@/lib/simulation/field";
import { type OptimizationRequest, type OptimizationStep, runOptimization } from "@/lib/simulation/optimize";
import { runSweep, type SweepRequest } from "@/lib/simulation/sweep";
import { computePerformance, type PerformanceInput } from "@/lib/vehicle/performance";

export type WorkerRequest =
  | { id: number; type: "simulate"; config: SimulationConfig; wantField: boolean }
  | { id: number; type: "sweep"; request: SweepRequest }
  | { id: number; type: "optimize"; request: OptimizationRequest }
  | { id: number; type: "performance"; input: PerformanceInput }
  | { id: number; type: "register-body"; body: SampledBody }
  | { id: number; type: "measure"; request: MeasureRequest }
  | { id: number; type: "wrap"; request: WrapRequest };

/** Shrink-wraps an imported model into one closed surface for CFD. */
export interface WrapRequest {
  /** Triangle soup in the file's own coordinates (9 numbers per triangle); the worker takes ownership. */
  positions: Float32Array;
  /** Row-major 4 x 4 matrix from the file's coordinates to tunnel coordinates (from the import). */
  matrix: number[];
  options: WrapOptions;
}

/** Measures an imported model: orient and scale it, sample its envelope, fit the shape parameters. */
export interface MeasureRequest {
  bodyId: string;
  /** Triangle soup in the file's own coordinates (9 numbers per triangle). */
  positions: Float32Array;
  orientation: Orientation;
  /** Overall length to scale the model to, m; omit to keep the file's units. */
  targetLength?: number;
  /** Wheelbase to scale the model to, m. Takes precedence over targetLength; needs wheels on the ground. */
  targetWheelbase?: number;
  /** Geometry of the generic class that supplies what cannot be measured. */
  anchor: GeometryParams;
}

export interface MeasureResult {
  matrix: number[];
  scale: number;
  /** Bounding box of everything that was measured, after scaling, m. */
  box: { length: number; width: number; height: number };
  measured: MeasuredModel;
  fitted: FittedGeometry;
}

export type WorkerResponse =
  | { id: number; type: "progress"; state: JobState; progress: number; message: string }
  | { id: number; type: "sweep-progress"; done: number; total: number }
  | { id: number; type: "optimize-progress"; step: OptimizationStep; total: number }
  | { id: number; type: "done"; payload: unknown }
  | { id: number; type: "error"; code: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(response, transfer);
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "simulate") {
      let lastPost = 0;
      const run = runLocal(request.config, request.wantField, (state, progress, message) => {
        // Throttle progress messages; state changes always go through.
        const now = performance.now();
        if (now - lastPost < 40 && progress > 0 && progress < 1) return;
        lastPost = now;
        post({ id: request.id, type: "progress", state, progress, message });
      });
      post({ id: request.id, type: "done", payload: run }, run.field ? fieldTransferables(run.field) : []);
    } else if (request.type === "sweep") {
      const result = runSweep(request.request, (done, total) =>
        post({ id: request.id, type: "sweep-progress", done, total }),
      );
      post({ id: request.id, type: "done", payload: result });
    } else if (request.type === "optimize") {
      const result = runOptimization(request.request, (step, total) =>
        post({ id: request.id, type: "optimize-progress", step, total }),
      );
      post({ id: request.id, type: "done", payload: result });
    } else if (request.type === "performance") {
      post({ id: request.id, type: "done", payload: computePerformance(request.input) });
    } else if (request.type === "register-body") {
      registerSampledBody(request.body);
      post({ id: request.id, type: "done", payload: null });
    } else if (request.type === "wrap") {
      const { positions, matrix: m, options } = request.request;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        positions[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
        positions[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
        positions[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
      }
      const wrap = wrapModel(positions, options, (progress, message) =>
        post({ id: request.id, type: "progress", state: "PREPARING", progress, message }),
      );
      post({ id: request.id, type: "done", payload: wrap }, [wrap.positions.buffer, wrap.indices.buffer]);
    } else if (request.type === "measure") {
      const { bodyId, positions, orientation, targetLength, targetWheelbase, anchor } = request.request;
      const { oriented, measured } = measureAtScale(positions, orientation, { targetLength, targetWheelbase }, bodyId);
      const fitted = fitGeometry(measured, anchor);
      // The worker solves on this body from now on; the page receives its own copy with the result.
      registerSampledBody(measured.body);
      const result: MeasureResult = {
        matrix: oriented.matrix,
        scale: oriented.scale,
        box: { length: oriented.length, width: oriented.width, height: oriented.height },
        measured,
        fitted,
      };
      post({ id: request.id, type: "done", payload: result });
    }
  } catch (error) {
    const code = error instanceof SimulationError ? error.code : "SIMULATION_FAILED";
    const message = error instanceof Error ? error.message : "Unknown simulation failure";
    post({ id: request.id, type: "error", code, message });
  }
};
