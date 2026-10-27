import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Environment,
  Fidelity,
  GeometryParams,
  JobProgress,
  ParamId,
  PerformanceResult,
  Powertrain,
  SimulationMode,
  SimulationResult,
  VehicleDefinition,
  VehicleSpec,
} from "@/lib/types";
import { fidelityFor } from "@/lib/types";
import { clampParam, completeGeometry, withOverallHeight, withOverallLength } from "@/lib/geometry/parameters";
import { STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import { vehicleSpecOf } from "@/lib/simulation/config";
import { BUILT_IN_VEHICLES, DEFAULT_VEHICLE_ID, findVehicle, getBuiltInVehicle, LIBRARY_VEHICLES } from "@/lib/vehicle/library";

export interface SimError {
  code: string;
  message: string;
}

interface SimState {
  projectName: string;
  vehicleId: string;
  customVehicles: VehicleDefinition[];
  geometry: GeometryParams;
  spec: VehicleSpec;
  powertrain: Powertrain;
  environment: Environment;
  /** Vehicle road speed, m/s. */
  speed: number;
  mode: SimulationMode;
  fidelity: Fidelity;

  // --- run state (not persisted) ---
  running: boolean;
  job: JobProgress | null;
  error: SimError | null;
  result: SimulationResult | null;
  performance: PerformanceResult | null;
  /** Experiment created by the most recent run. */
  resultExperimentId: string | null;

  setProjectName: (name: string) => void;
  selectVehicle: (id: string) => void;
  loadVehicle: (vehicle: VehicleDefinition, geometry?: GeometryParams) => void;
  setParam: (id: ParamId, value: number) => void;
  setOverallLength: (length: number) => void;
  setOverallHeight: (height: number) => void;
  resetParam: (id: ParamId) => void;
  resetGeometry: () => void;
  setGeometry: (geometry: GeometryParams) => void;
  setSpec: (changes: Partial<VehicleSpec>) => void;
  setPowertrain: (powertrain: Powertrain) => void;
  resetPowertrain: () => void;
  setEnvironment: (changes: Partial<Environment>) => void;
  setSpeed: (speed: number) => void;
  setMode: (mode: SimulationMode) => void;
  setFidelity: (fidelity: Fidelity) => void;
  addCustomVehicle: (vehicle: VehicleDefinition) => void;
  removeCustomVehicle: (id: string) => void;
  setRunState: (
    state: Partial<Pick<SimState, "running" | "job" | "error" | "result" | "performance" | "resultExperimentId">>,
  ) => void;
}

const initialVehicle = getBuiltInVehicle(DEFAULT_VEHICLE_ID);

export const useSimStore = create<SimState>()(
  persist(
    (set, get) => ({
      projectName: "Untitled study",
      vehicleId: initialVehicle.id,
      customVehicles: [],
      geometry: { ...initialVehicle.geometry },
      spec: vehicleSpecOf(initialVehicle),
      powertrain: structuredClone(initialVehicle.powertrain),
      environment: { ...STANDARD_ENVIRONMENT },
      speed: 150 / 3.6,
      mode: "analytical",
      fidelity: "coarse",

      running: false,
      job: null,
      error: null,
      result: null,
      performance: null,
      resultExperimentId: null,

      setProjectName: (projectName) => set({ projectName }),
      selectVehicle: (id) => {
        const vehicle = findVehicle(id, get().customVehicles);
        if (vehicle) get().loadVehicle(vehicle);
      },
      loadVehicle: (vehicle, geometry) =>
        set({
          vehicleId: vehicle.id,
          geometry: { ...(geometry ?? vehicle.geometry) },
          spec: vehicleSpecOf(vehicle),
          powertrain: structuredClone(vehicle.powertrain),
          error: null,
        }),
      setParam: (id, value) => set((state) => ({ geometry: { ...state.geometry, [id]: clampParam(id, value) } })),
      setOverallLength: (length) => set((state) => ({ geometry: withOverallLength(state.geometry, length) })),
      setOverallHeight: (height) => set((state) => ({ geometry: withOverallHeight(state.geometry, height) })),
      resetParam: (id) => {
        const vehicle = findVehicle(get().vehicleId, get().customVehicles);
        if (vehicle) set((state) => ({ geometry: { ...state.geometry, [id]: vehicle.geometry[id] } }));
      },
      resetGeometry: () => {
        const vehicle = findVehicle(get().vehicleId, get().customVehicles);
        if (vehicle) set({ geometry: { ...vehicle.geometry } });
      },
      setGeometry: (geometry) => set({ geometry: { ...geometry } }),
      setSpec: (changes) => set((state) => ({ spec: { ...state.spec, ...changes } })),
      setPowertrain: (powertrain) => set({ powertrain }),
      resetPowertrain: () => {
        const vehicle = findVehicle(get().vehicleId, get().customVehicles);
        if (vehicle) set({ powertrain: structuredClone(vehicle.powertrain), spec: vehicleSpecOf(vehicle) });
      },
      setEnvironment: (changes) => set((state) => ({ environment: { ...state.environment, ...changes } })),
      setSpeed: (speed) => set({ speed: Math.min(Math.max(speed, 0), 120) }),
      setMode: (mode) => set((state) => ({ mode, fidelity: fidelityFor(mode, state.fidelity) })),
      setFidelity: (fidelity) => set((state) => ({ fidelity: fidelityFor(state.mode, fidelity) })),
      addCustomVehicle: (vehicle) =>
        set((state) => ({
          customVehicles: [...state.customVehicles.filter((existing) => existing.id !== vehicle.id), vehicle],
        })),
      removeCustomVehicle: (id) =>
        set((state) => ({ customVehicles: state.customVehicles.filter((vehicle) => vehicle.id !== id) })),
      setRunState: (runState) => set(runState),
    }),
    {
      name: "aerolab-session",
      version: 2,
      // Version 2 added the detail parameters (mirrors, rims, cooling intake). A session saved before that
      // gets the values of the vehicle it is based on, or the documented default.
      migrate: (persisted) => {
        const state = persisted as Partial<SimState> | undefined;
        if (!state?.geometry) return state as SimState;
        const customVehicles = (state.customVehicles ?? []).map((vehicle) => ({
          ...vehicle,
          geometry: completeGeometry(vehicle.geometry),
          referenceGeometry: vehicle.referenceGeometry ? completeGeometry(vehicle.referenceGeometry) : undefined,
        }));
        const base = findVehicle(state.vehicleId ?? "", customVehicles)?.geometry;
        return { ...state, customVehicles, geometry: completeGeometry({ ...base, ...state.geometry } as GeometryParams) } as SimState;
      },
      // A session saved in Mode C on the fine grid, before Mode C was limited to coarse and medium.
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<SimState>) };
        return { ...state, fidelity: fidelityFor(state.mode, state.fidelity) };
      },
      partialize: (state) => ({
        projectName: state.projectName,
        vehicleId: state.vehicleId,
        customVehicles: state.customVehicles,
        geometry: state.geometry,
        spec: state.spec,
        powertrain: state.powertrain,
        environment: state.environment,
        speed: state.speed,
        mode: state.mode,
        fidelity: state.fidelity,
      }),
    },
  ),
);

/** The vehicle definition the current session is based on (reference geometry + coefficients). */
export function currentVehicle(state: Pick<SimState, "vehicleId" | "customVehicles">): VehicleDefinition {
  return findVehicle(state.vehicleId, state.customVehicles) ?? BUILT_IN_VEHICLES[0];
}

export function allVehicles(customVehicles: VehicleDefinition[]): VehicleDefinition[] {
  return [...LIBRARY_VEHICLES, ...customVehicles];
}
