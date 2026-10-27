import { create } from "zustand";
import type { FlowField } from "@/lib/simulation/field";

export type BodyStyle = "solid" | "wireframe" | "transparent" | "pressure";

export type CameraPreset = "perspective" | "front" | "side" | "top" | "rear" | "three-quarter";

export interface FlowLayers {
  airflow: boolean;
  streamlines: boolean;
  velocity: boolean;
  pressure: boolean;
  wake: boolean;
  separation: boolean;
  forces: boolean;
}

export type LayerId = keyof FlowLayers;

/** One-click visualisation modes: a body style plus a set of layers. */
export type VisualizationMode = "solid" | "wireframe" | "transparent" | "pressure" | "velocity" | "streamlines" | "wake";

const MODE_PRESETS: Record<VisualizationMode, { bodyStyle: BodyStyle; layers: Partial<FlowLayers> }> = {
  solid: { bodyStyle: "solid", layers: { airflow: true, streamlines: false, velocity: false, pressure: false, wake: false } },
  wireframe: { bodyStyle: "wireframe", layers: { airflow: true, streamlines: false, velocity: false, pressure: false, wake: false } },
  transparent: { bodyStyle: "transparent", layers: { airflow: true, streamlines: false, velocity: false, pressure: false, wake: false } },
  pressure: { bodyStyle: "pressure", layers: { airflow: false, streamlines: false, velocity: false, pressure: true, wake: false } },
  velocity: { bodyStyle: "solid", layers: { airflow: false, streamlines: false, velocity: true, pressure: false, wake: false } },
  streamlines: { bodyStyle: "solid", layers: { airflow: false, streamlines: true, velocity: false, pressure: false, wake: false } },
  wake: { bodyStyle: "solid", layers: { airflow: true, streamlines: false, velocity: false, pressure: false, wake: true, separation: true } },
};

export type DockSize = "collapsed" | "normal" | "expanded";

interface ViewState {
  mode: VisualizationMode;
  bodyStyle: BodyStyle;
  /** Dress the car in the solid style (paint, glazing, lights, mirrors, rims). Appearance only. */
  detail: boolean;
  bodyOpacity: number;
  layers: FlowLayers;
  sliceAxis: "x" | "y" | "z";
  /** Slice position along its axis, m. */
  slicePosition: number;
  playing: boolean;
  /** Requested camera preset; the nonce makes repeated requests of the same preset fire again. */
  camera: { preset: CameraPreset; nonce: number };
  leftTab: string;
  leftOpen: boolean;
  rightOpen: boolean;
  dockTab: string;
  dockSize: DockSize;
  setMode: (mode: VisualizationMode) => void;
  setBodyStyle: (style: BodyStyle) => void;
  setDetail: (detail: boolean) => void;
  setBodyOpacity: (opacity: number) => void;
  toggleLayer: (layer: LayerId) => void;
  setSlice: (axis: "x" | "y" | "z", position: number) => void;
  setPlaying: (playing: boolean) => void;
  setCamera: (preset: CameraPreset) => void;
  setLeftTab: (tab: string) => void;
  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
  setDockTab: (tab: string) => void;
  setDockSize: (size: DockSize) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  mode: "solid",
  bodyStyle: "solid",
  detail: true,
  bodyOpacity: 0.35,
  layers: { airflow: true, streamlines: false, velocity: false, pressure: false, wake: false, separation: false, forces: true },
  sliceAxis: "y",
  slicePosition: 0,
  playing: true,
  camera: { preset: "perspective", nonce: 0 },
  leftTab: "geometry",
  leftOpen: true,
  rightOpen: true,
  dockTab: "drag",
  dockSize: "normal",
  setMode: (mode) =>
    set((state) => ({
      mode,
      bodyStyle: MODE_PRESETS[mode].bodyStyle,
      layers: { ...state.layers, ...MODE_PRESETS[mode].layers },
    })),
  setBodyStyle: (bodyStyle) => set({ bodyStyle }),
  setDetail: (detail) => set({ detail }),
  setBodyOpacity: (bodyOpacity) => set({ bodyOpacity }),
  toggleLayer: (layer) =>
    set((state) => {
      const layers = { ...state.layers, [layer]: !state.layers[layer] };
      // One contour quantity at a time on the slice plane.
      if (layer === "velocity" && layers.velocity) layers.pressure = false;
      if (layer === "pressure" && layers.pressure) layers.velocity = false;
      return { layers };
    }),
  setSlice: (sliceAxis, slicePosition) => set({ sliceAxis, slicePosition }),
  setPlaying: (playing) => set({ playing }),
  setCamera: (preset) => set((state) => ({ camera: { preset, nonce: state.camera.nonce + 1 } })),
  setLeftTab: (leftTab) => set({ leftTab }),
  setLeftOpen: (leftOpen) => set({ leftOpen }),
  setRightOpen: (rightOpen) => set({ rightOpen }),
  setDockTab: (dockTab) => set((state) => ({ dockTab, dockSize: state.dockSize === "collapsed" ? "normal" : state.dockSize })),
  setDockSize: (dockSize) => set({ dockSize }),
}));

interface FlowState {
  /** Field currently shown in the viewport. */
  field: FlowField | null;
  /** Key (geometry + yaw + fidelity) the field was solved for. */
  fieldKey: string | null;
  setField: (field: FlowField | null, fieldKey: string | null) => void;
}

/** The flow field lives outside the persisted stores: it is large and cheap to recompute. */
export const useFlowStore = create<FlowState>()((set) => ({
  field: null,
  fieldKey: null,
  setField: (field, fieldKey) => set({ field, fieldKey }),
}));
