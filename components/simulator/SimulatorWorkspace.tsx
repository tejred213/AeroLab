"use client";

import { useEffect, useMemo, useState } from "react";
import { EnvironmentPanel } from "@/components/controls/EnvironmentPanel";
import { AeroDevicesPanel, GeometryPanel } from "@/components/controls/GeometryPanel";
import { VehiclePanel } from "@/components/controls/VehiclePanel";
import { ResultsPanel } from "@/components/dashboard/ResultsPanel";
import { BottomDock } from "@/components/simulator/BottomDock";
import { FidelitySelect, RunControls, SaveDialog, UnitToggle } from "@/components/simulator/RunControls";
import { Viewport } from "@/components/simulator/Viewport";
import { AppHeader } from "@/components/ui/AppHeader";
import { Button, ButtonGroup } from "@/components/ui/Button";
import { Badge, Section } from "@/components/ui/Layout";
import { Tabs } from "@/components/ui/Tabs";
import { makeConfig } from "@/lib/simulation/config";
import { hashConfig } from "@/lib/simulation/hash";
import { refreshPerformance } from "@/lib/state/run";
import { currentVehicle, useSimStore } from "@/lib/state/simStore";
import { type CameraPreset, type DockSize, useViewStore } from "@/lib/state/viewStore";

type LayoutMode = "desktop" | "tablet" | "mobile";

function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>("desktop");
  useEffect(() => {
    const update = () => setMode(window.innerWidth >= 1180 ? "desktop" : window.innerWidth >= 760 ? "tablet" : "mobile");
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return mode;
}

/** True when the editor no longer matches the configuration behind the displayed result. */
function useStale(): boolean {
  const result = useSimStore((state) => state.result);
  const vehicleId = useSimStore((state) => state.vehicleId);
  const customVehicles = useSimStore((state) => state.customVehicles);
  const geometry = useSimStore((state) => state.geometry);
  const environment = useSimStore((state) => state.environment);
  const speed = useSimStore((state) => state.speed);
  const mode = useSimStore((state) => state.mode);
  const fidelity = useSimStore((state) => state.fidelity);
  return useMemo(() => {
    if (!result) return false;
    const vehicle = currentVehicle({ vehicleId, customVehicles });
    return hashConfig(makeConfig(vehicle, geometry, environment, speed, mode, fidelity)) !== result.hash;
  }, [result, vehicleId, customVehicles, geometry, environment, speed, mode, fidelity]);
}

const CAMERA_KEYS: Record<string, CameraPreset> = { "1": "perspective", "2": "front", "3": "side", "4": "top", "5": "rear" };

function useKeyboardShortcuts(onSave: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const view = useViewStore.getState();
      if (event.key === " ") {
        // Space on a focused button should still press that button.
        if (target?.tagName === "BUTTON") return;
        event.preventDefault();
        view.setPlaying(!view.playing);
      } else if (event.key.toLowerCase() === "r") {
        view.setCamera(view.camera.preset);
      } else if (CAMERA_KEYS[event.key]) {
        view.setCamera(CAMERA_KEYS[event.key]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSave]);
}

/** Recomputes performance when the chassis or powertrain changes under an existing aero result. */
function usePerformanceRefresh() {
  const spec = useSimStore((state) => state.spec);
  const powertrain = useSimStore((state) => state.powertrain);
  useEffect(() => {
    const timer = setTimeout(() => void refreshPerformance(), 250);
    return () => clearTimeout(timer);
  }, [spec, powertrain]);
}

const LEFT_TABS = [
  { id: "geometry", label: "Geometry" },
  { id: "aero", label: "Aero" },
  { id: "vehicle", label: "Vehicle" },
  { id: "environment", label: "Environment" },
];

/**
 * @param showSession always show the grid and unit settings here (tablet and phone, where the header
 *   has no room for them). On a desktop they appear here only while the window is too narrow for the header.
 */
function ParameterPanel({ showSession }: { showSession: boolean }) {
  const leftTab = useViewStore((state) => state.leftTab);
  const setLeftTab = useViewStore((state) => state.setLeftTab);
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="shrink-0 border-b border-line p-2.5">
        <Tabs tabs={LEFT_TABS} active={leftTab} onChange={setLeftTab} label="Parameters" variant="segmented" />
      </div>
      <div role="tabpanel" aria-label={LEFT_TABS.find((tab) => tab.id === leftTab)?.label} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className={showSession ? "" : "min-[1440px]:hidden"}>
          <Section title="Simulation settings" collapsible defaultOpen={false}>
            <div className="flex flex-wrap gap-2">
              <FidelitySelect />
              <UnitToggle />
            </div>
          </Section>
        </div>
        {leftTab === "geometry" && <GeometryPanel />}
        {leftTab === "aero" && <AeroDevicesPanel />}
        {leftTab === "vehicle" && <VehiclePanel />}
        {leftTab === "environment" && <EnvironmentPanel />}
      </div>
    </div>
  );
}

function ResultsColumn({ stale }: { stale: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">Results</h2>
        {stale && <Badge tone="warn">Stale</Badge>}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <ResultsPanel stale={stale} />
      </div>
    </div>
  );
}

const DOCK_HEIGHT: Record<DockSize, string> = { collapsed: "38px", normal: "288px", expanded: "56vh" };
/** A pane of the workspace: a card on the page background, as on the landing page. */
const PANE = "overflow-hidden rounded-2xl border border-line bg-panel";

export function SimulatorWorkspace() {
  const layout = useLayoutMode();
  const stale = useStale();
  const [saveOpen, setSaveOpen] = useState(false);
  const dockSize = useViewStore((state) => state.dockSize);
  const leftOpen = useViewStore((state) => state.leftOpen);
  const rightOpen = useViewStore((state) => state.rightOpen);
  const setLeftOpen = useViewStore((state) => state.setLeftOpen);
  const setRightOpen = useViewStore((state) => state.setRightOpen);
  const [mobileTab, setMobileTab] = useState("controls");

  // Drawers start closed on tablets so the viewport is visible first.
  useEffect(() => {
    if (layout === "tablet") {
      setLeftOpen(false);
      setRightOpen(false);
    }
  }, [layout, setLeftOpen, setRightOpen]);

  const openSave = useMemo(() => () => setSaveOpen(true), []);
  useKeyboardShortcuts(openSave);
  usePerformanceRefresh();

  if (layout === "mobile") {
    return (
      <div className="relative flex h-dvh flex-col overflow-hidden">
        <AppHeader>
          <RunControls compact onSave={openSave} />
        </AppHeader>
        <div className={`mx-2 h-[40dvh] shrink-0 ${PANE}`}>
          <Viewport stale={stale} compact />
        </div>
        {/* Bottom sheet: controls, results and analysis as tabs. */}
        <div className={`m-2 flex min-h-0 flex-1 flex-col ${PANE}`}>
          <Tabs
            tabs={[
              { id: "controls", label: "Controls" },
              { id: "results", label: "Results" },
              { id: "analysis", label: "Analysis" },
            ]}
            active={mobileTab}
            onChange={setMobileTab}
            label="Simulator sections"
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            {mobileTab === "controls" && <ParameterPanel showSession />}
            {mobileTab === "results" && <ResultsColumn stale={stale} />}
            {mobileTab === "analysis" && <BottomDock />}
          </div>
        </div>
        <SaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
      </div>
    );
  }

  const tablet = layout === "tablet";
  // On tablets the side panels are drawers over the viewport; on desktop they are columns.
  const showLeft = !tablet || leftOpen;
  const showRight = !tablet || rightOpen;

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <AppHeader>
        <RunControls compact={tablet} onSave={openSave} />
      </AppHeader>
      <div className="relative flex min-h-0 flex-1 gap-2 px-2">
        {showLeft && (
          <aside
            aria-label="Parameters"
            data-arrive="left"
            className={`w-[320px] shrink-0 ${PANE} ${tablet ? "absolute inset-y-0 left-2 z-20 shadow-2xl shadow-black" : ""}`}
          >
            <ParameterPanel showSession={tablet} />
          </aside>
        )}
        <main data-arrive="fade" className={`relative min-w-0 flex-1 ${PANE}`}>
          <Viewport stale={stale} />
          {tablet && (
            <ButtonGroup className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2" aria-label="Side panels">
              <Button variant="tool" size="sm" active={leftOpen} onClick={() => setLeftOpen(!leftOpen)}>
                Parameters
              </Button>
              <Button variant="tool" size="sm" active={rightOpen} onClick={() => setRightOpen(!rightOpen)}>
                Results
              </Button>
            </ButtonGroup>
          )}
        </main>
        {showRight && (
          <aside
            aria-label="Results"
            data-arrive="right"
            className={`w-[320px] shrink-0 ${PANE} ${tablet ? "absolute inset-y-0 right-2 z-20 shadow-2xl shadow-black" : ""}`}
          >
            <ResultsColumn stale={stale} />
          </aside>
        )}
      </div>
      <div data-arrive="up" className="shrink-0 p-2">
        <div className={PANE} style={{ height: DOCK_HEIGHT[dockSize] }}>
          <BottomDock />
        </div>
      </div>
      <SaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} />
    </div>
  );
}
