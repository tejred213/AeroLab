/**
 * Main-thread interface to the simulation worker. One worker is shared by the app.
 */
import { type JobProgress, type PerformanceResult, type SimulationConfig, SimulationError } from "@/lib/types";
import type { LocalRun } from "@/lib/simulation/engine";
import type { OptimizationRequest, OptimizationResult, OptimizationStep } from "@/lib/simulation/optimize";
import type { SweepRequest, SweepResult } from "@/lib/simulation/sweep";
import type { MeasureRequest, MeasureResult, WorkerRequest, WorkerResponse, WrapRequest } from "@/lib/simulation/worker";
import type { WrappedSurface } from "@/lib/geometry/wrap";
import { getSampledBody, registerSampledBody } from "@/lib/geometry/sampledBody";
import type { PerformanceInput } from "@/lib/vehicle/performance";

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: JobProgress) => void;
  onSweepProgress?: (done: number, total: number) => void;
  onOptimizeProgress?: (step: OptimizationStep, total: number) => void;
}

let worker: Worker | null = null;
/** Measured bodies the current worker already holds. */
let workerBodies = new Set<string>();
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  workerBodies = new Set();
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === "progress") {
      entry.onProgress?.({ state: message.state, progress: message.progress, message: message.message });
    } else if (message.type === "sweep-progress") {
      entry.onSweepProgress?.(message.done, message.total);
    } else if (message.type === "optimize-progress") {
      entry.onOptimizeProgress?.(message.step, message.total);
    } else if (message.type === "done") {
      pending.delete(message.id);
      entry.resolve(message.payload);
    } else {
      pending.delete(message.id);
      entry.reject(new SimulationError(message.code, message.message));
    }
  };
  worker.onerror = (event) => {
    // A crashed worker cannot answer: fail everything that was waiting on it.
    const error = new SimulationError("WORKER_CRASHED", event.message || "The simulation worker stopped unexpectedly.");
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Omit that distributes over the members of a union. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

function send<T>(request: WithoutId<WorkerRequest>, handlers: Omit<Pending, "resolve" | "reject"> = {}): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (payload: unknown) => void, reject, ...handlers });
    getWorker().postMessage({ ...request, id } as WorkerRequest);
  });
}

/**
 * Gives the worker the measured body a configuration refers to, once per worker.
 * A body that is not loaded on the page is left for the worker to report.
 */
function shareBody(config: SimulationConfig): void {
  const id = config.bodyId;
  if (!id || workerBodies.has(id)) return;
  const body = getSampledBody(id);
  if (!body) return;
  getWorker();
  workerBodies.add(id);
  void send<null>({ type: "register-body", body });
}

export function simulateLocal(
  config: SimulationConfig,
  wantField: boolean,
  onProgress?: (progress: JobProgress) => void,
): Promise<LocalRun> {
  shareBody(config);
  return send<LocalRun>({ type: "simulate", config, wantField }, { onProgress });
}

export function sweepLocal(
  request: SweepRequest,
  onSweepProgress?: (done: number, total: number) => void,
): Promise<SweepResult> {
  shareBody(request.config);
  return send<SweepResult>({ type: "sweep", request }, { onSweepProgress });
}

export function optimizeLocal(
  request: OptimizationRequest,
  onOptimizeProgress?: (step: OptimizationStep, total: number) => void,
): Promise<OptimizationResult> {
  shareBody(request.config);
  return send<OptimizationResult>({ type: "optimize", request }, { onOptimizeProgress });
}

/** Measures an imported model in the worker; the measured body is then known to the worker and the page. */
export async function measureLocal(request: MeasureRequest): Promise<MeasureResult> {
  const id = nextId++;
  const result = await new Promise<MeasureResult>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (payload: unknown) => void, reject });
    getWorker().postMessage({ id, type: "measure", request } satisfies WorkerRequest, [request.positions.buffer]);
  });
  registerSampledBody(result.measured.body);
  workerBodies.add(request.bodyId);
  return result;
}

export function performanceLocal(input: PerformanceInput): Promise<PerformanceResult> {
  return send<PerformanceResult>({ type: "performance", input });
}

/** Shrink-wraps an imported model in the worker (the triangle buffer is handed over, not copied). */
export function wrapLocal(request: WrapRequest, onProgress?: (progress: JobProgress) => void): Promise<WrappedSurface> {
  const id = nextId++;
  return new Promise<WrappedSurface>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (payload: unknown) => void, reject, onProgress });
    getWorker().postMessage({ id, type: "wrap", request } satisfies WorkerRequest, [request.positions.buffer]);
  });
}

/** Stops the worker and rejects anything in flight (used to cancel a long solve). */
export function cancelLocalWork(): void {
  if (!worker) return;
  worker.terminate();
  worker = null;
  const error = new SimulationError("CANCELLED", "The simulation was cancelled.");
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}
