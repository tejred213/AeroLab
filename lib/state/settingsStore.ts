import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UnitSystem } from "@/lib/utils/units";

/** Where Mode A / Mode B simulations are computed. Modes C and D always need the backend. */
export type ComputeTarget = "browser" | "backend";

export interface EngineAvailability {
  available: boolean;
  detail: string;
}

export interface BackendInfo {
  version: string;
  modelVersion: string;
  engines: Record<string, EngineAvailability>;
}

/**
 * Where the backend is when the user has not chosen another address; a deployment sets it at build time.
 * "/" (stored as "") means the backend is reached through this site's own /api.
 */
export const DEFAULT_BACKEND_URL = (process.env.NEXT_PUBLIC_AEROLAB_BACKEND_URL ?? "http://localhost:8000").replace(/\/+$/, "");

interface SettingsState {
  unitSystem: UnitSystem;
  backendUrl: string;
  computeTarget: ComputeTarget;
  /** Skip the backend entirely and label the app as demo / analytical. */
  demoMode: boolean;
  particleCount: number;
  setUnitSystem: (system: UnitSystem) => void;
  setBackendUrl: (url: string) => void;
  setComputeTarget: (target: ComputeTarget) => void;
  setDemoMode: (demo: boolean) => void;
  setParticleCount: (count: number) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      unitSystem: "automotive",
      backendUrl: DEFAULT_BACKEND_URL,
      computeTarget: "browser",
      demoMode: false,
      particleCount: 2600,
      setUnitSystem: (unitSystem) => set({ unitSystem }),
      setBackendUrl: (backendUrl) => set({ backendUrl: backendUrl.replace(/\/+$/, "") }),
      setComputeTarget: (computeTarget) => set({ computeTarget }),
      setDemoMode: (demoMode) => set({ demoMode }),
      setParticleCount: (particleCount) => set({ particleCount }),
    }),
    { name: "aerolab-settings", version: 1 },
  ),
);

export type BackendStatus = "unknown" | "checking" | "online" | "offline";

interface BackendState {
  status: BackendStatus;
  info: BackendInfo | null;
  lastError: string | null;
  setStatus: (status: BackendStatus, info?: BackendInfo | null, lastError?: string | null) => void;
}

/** Live connection state of the Python backend (not persisted). */
export const useBackendStore = create<BackendState>()((set) => ({
  status: "unknown",
  info: null,
  lastError: null,
  setStatus: (status, info = null, lastError = null) => set({ status, info, lastError }),
}));
