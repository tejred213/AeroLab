import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AeroResult,
  PerformanceResult,
  Powertrain,
  SimulationConfig,
  TopSpeedLimit,
  VehicleSpec,
} from "@/lib/types";
import { type PerformanceInput, resistances } from "@/lib/vehicle/performance";

/** Compact performance record stored with each experiment (traces are recomputed on demand). */
export interface PerformanceSummary {
  topSpeed: number;
  topSpeedLimit: TopSpeedLimit;
  accelTimes: { target: number; time: number | null }[];
  tractionLimited: boolean;
  maxGradeDeg: number;
  /** Power needed at the wheels to hold 100 km/h and 200 km/h, W. */
  power100: number;
  power200: number;
  rangeAt100: number | null;
  forcesAtSpeed: PerformanceResult["forcesAtSpeed"];
}

export function summarizePerformance(performance: PerformanceResult, input: PerformanceInput): PerformanceSummary {
  const powerAt = (kmh: number) => {
    const speed = kmh / 3.6;
    return resistances(input, speed).total * speed;
  };
  return {
    topSpeed: performance.topSpeed,
    topSpeedLimit: performance.topSpeedLimit,
    accelTimes: performance.accelTimes,
    tractionLimited: performance.tractionLimited,
    maxGradeDeg: performance.maxGradeDeg,
    power100: powerAt(100),
    power200: powerAt(200),
    rangeAt100: performance.rangeAt100,
    forcesAtSpeed: performance.forcesAtSpeed,
  };
}

export interface Experiment {
  id: string;
  /** Sequential number shown as "Experiment #014". */
  number: number;
  name: string;
  createdAt: number;
  projectName: string;
  vehicleId: string;
  vehicleName: string;
  config: SimulationConfig;
  spec: VehicleSpec;
  powertrain: Powertrain;
  aero: AeroResult;
  performance: PerformanceSummary;
  /** Marked by the user as a named configuration to keep and compare. */
  saved: boolean;
}

const MAX_EXPERIMENTS = 200;

interface ExperimentState {
  experiments: Experiment[];
  counter: number;
  /** Experiment pinned as the comparison baseline; null = use the previous run. */
  baselineId: string | null;
  /** Experiments selected for the comparison page. */
  compareIds: string[];
  add: (experiment: Omit<Experiment, "id" | "number" | "name"> & { name?: string }) => Experiment;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => Experiment | null;
  toggleSaved: (id: string) => void;
  setBaseline: (id: string | null) => void;
  toggleCompare: (id: string) => void;
  setCompare: (ids: string[]) => void;
  clear: () => void;
}

function newId(): string {
  return `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useExperimentStore = create<ExperimentState>()(
  persist(
    (set, get) => ({
      experiments: [],
      counter: 0,
      baselineId: null,
      compareIds: [],
      add: (input) => {
        const number = get().counter + 1;
        const experiment: Experiment = {
          ...input,
          id: newId(),
          number,
          name: input.name ?? `Experiment #${String(number).padStart(3, "0")}`,
        };
        set((state) => {
          // Oldest unsaved experiments are dropped first when the history is full.
          let experiments = [...state.experiments, experiment];
          while (experiments.length > MAX_EXPERIMENTS) {
            const index = experiments.findIndex((entry) => !entry.saved);
            experiments = experiments.filter((_, i) => i !== (index < 0 ? 0 : index));
          }
          return { experiments, counter: number };
        });
        return experiment;
      },
      rename: (id, name) =>
        set((state) => ({
          experiments: state.experiments.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
        })),
      remove: (id) =>
        set((state) => ({
          experiments: state.experiments.filter((entry) => entry.id !== id),
          compareIds: state.compareIds.filter((entry) => entry !== id),
          baselineId: state.baselineId === id ? null : state.baselineId,
        })),
      duplicate: (id) => {
        const source = get().experiments.find((entry) => entry.id === id);
        if (!source) return null;
        const { id: _id, number: _number, name, ...rest } = source;
        void _id;
        void _number;
        return get().add({ ...structuredClone(rest), createdAt: Date.now(), name: `${name} (copy)` });
      },
      toggleSaved: (id) =>
        set((state) => ({
          experiments: state.experiments.map((entry) => (entry.id === id ? { ...entry, saved: !entry.saved } : entry)),
        })),
      setBaseline: (baselineId) => set({ baselineId }),
      toggleCompare: (id) =>
        set((state) => ({
          compareIds: state.compareIds.includes(id)
            ? state.compareIds.filter((entry) => entry !== id)
            : [...state.compareIds, id],
        })),
      setCompare: (compareIds) => set({ compareIds }),
      clear: () => set({ experiments: [], compareIds: [], baselineId: null }),
    }),
    { name: "aerolab-experiments", version: 1 },
  ),
);

/**
 * The experiment to compare a result against: the pinned baseline if there is
 * one, otherwise the run before it.
 */
export function baselineFor(
  experiments: Experiment[],
  baselineId: string | null,
  currentId: string | null,
): Experiment | null {
  if (baselineId && baselineId !== currentId) {
    const pinned = experiments.find((entry) => entry.id === baselineId);
    if (pinned) return pinned;
  }
  const index = experiments.findIndex((entry) => entry.id === currentId);
  if (index > 0) return experiments[index - 1];
  return null;
}
