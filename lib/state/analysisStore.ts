/**
 * State and executors for the multi-run tools: parameter sweeps, design-space
 * maps, experiment mode and optimisation. Results are kept here so switching
 * tabs does not discard them.
 */
import { create } from "zustand";
import { SimulationError } from "@/lib/types";
import { optimizeBackend, sweepBackend } from "@/lib/simulation/backendApi";
import { optimizeLocal, sweepLocal } from "@/lib/simulation/client";
import type { OptimizationRequest, OptimizationResult, OptimizationStep } from "@/lib/simulation/optimize";
import type { SweepRequest, SweepResult } from "@/lib/simulation/sweep";
import { useSettingsStore } from "@/lib/state/settingsStore";
import type { SimError } from "@/lib/state/simStore";

export interface TaskState<T> {
  running: boolean;
  /** 0..1 */
  progress: number;
  result: T | null;
  error: SimError | null;
}

export type SweepSlot = "sweep" | "designSpace" | "explorer";

interface AnalysisState {
  sweep: TaskState<SweepResult>;
  designSpace: TaskState<SweepResult>;
  explorer: TaskState<SweepResult>;
  optimization: TaskState<OptimizationResult> & { history: OptimizationStep[]; total: number };
  patch: <K extends SweepSlot | "optimization">(slot: K, changes: Partial<AnalysisState[K]>) => void;
}

const idle = <T,>(): TaskState<T> => ({ running: false, progress: 0, result: null, error: null });

export const useAnalysisStore = create<AnalysisState>()((set) => ({
  sweep: idle(),
  designSpace: idle(),
  explorer: idle(),
  optimization: { ...idle<OptimizationResult>(), history: [], total: 0 },
  patch: (slot, changes) => set((state) => ({ [slot]: { ...state[slot], ...changes } }) as Partial<AnalysisState>),
}));

function toSimError(error: unknown): SimError {
  return {
    code: error instanceof SimulationError ? error.code : "SIMULATION_FAILED",
    message: error instanceof Error ? error.message : "The calculation failed.",
  };
}

/** True when a request has to go to the Python backend. */
function needsBackend(mode: string, algorithm?: string): boolean {
  const settings = useSettingsStore.getState();
  if (mode === "ml-surrogate" || mode === "cfd" || algorithm === "bayesian") return true;
  return !settings.demoMode && settings.computeTarget === "backend";
}

function assertBackendAllowed(): void {
  if (useSettingsStore.getState().demoMode) {
    throw new SimulationError("BACKEND_REQUIRED", "This option needs the Python backend, which is disabled in demo mode.");
  }
}

/** Runs a sweep (1D or 2D) into the given slot. */
export async function executeSweep(slot: SweepSlot, request: SweepRequest): Promise<SweepResult | null> {
  const { patch } = useAnalysisStore.getState();
  patch(slot, { running: true, progress: 0, error: null });
  const onProgress = (done: number, total: number) => patch(slot, { progress: total > 0 ? done / total : 0 });
  try {
    let result: SweepResult;
    if (needsBackend(request.config.mode)) {
      assertBackendAllowed();
      result = await sweepBackend(request, onProgress);
    } else {
      result = await sweepLocal(request, onProgress);
    }
    patch(slot, { running: false, progress: 1, result });
    return result;
  } catch (error) {
    patch(slot, { running: false, error: toSimError(error) });
    return null;
  }
}

export async function executeOptimization(request: OptimizationRequest): Promise<OptimizationResult | null> {
  const { patch } = useAnalysisStore.getState();
  patch("optimization", { running: true, progress: 0, error: null, history: [], total: request.iterations, result: null });
  try {
    let result: OptimizationResult;
    if (needsBackend(request.config.mode, request.algorithm)) {
      assertBackendAllowed();
      result = await optimizeBackend(request, (history) =>
        patch("optimization", {
          history,
          progress: history.length > 0 ? history[history.length - 1].iteration / request.iterations : 0,
        }),
      );
    } else {
      const history: OptimizationStep[] = [];
      result = await optimizeLocal(request, (step, total) => {
        history.push(step);
        patch("optimization", { history: [...history], progress: total > 0 ? step.iteration / total : 0 });
      });
    }
    patch("optimization", { running: false, progress: 1, result, history: result.history });
    return result;
  } catch (error) {
    patch("optimization", { running: false, error: toSimError(error) });
    return null;
  }
}
