"use client";

import { DownforceCharts, DragCharts, PerformanceCharts, PressureCharts, VelocityCharts } from "@/components/charts/ResultCharts";
import { DesignSpacePanel } from "@/components/simulator/DesignSpacePanel";
import { EnginesPanel } from "@/components/simulator/EnginesPanel";
import { ExplorerPanel } from "@/components/simulator/ExplorerPanel";
import { HistoryPanel } from "@/components/simulator/HistoryPanel";
import { OptimizerPanel } from "@/components/simulator/OptimizerPanel";
import { SweepPanel } from "@/components/simulator/SweepPanel";
import { TradeoffPanel } from "@/components/simulator/TradeoffPanel";
import { Tabs } from "@/components/ui/Tabs";
import { useExperimentStore } from "@/lib/state/experimentStore";
import { type DockSize, useViewStore } from "@/lib/state/viewStore";

/** `fill` is how much of the icon's frame the dock is drawn to occupy, in sixteenths. */
const SIZES: { id: DockSize; fill: number; title: string }[] = [
  { id: "collapsed", fill: 3, title: "Collapse the analysis dock" },
  { id: "normal", fill: 7, title: "Normal height" },
  { id: "expanded", fill: 12, title: "Expand the analysis dock" },
];

/** Analysis dock under the viewport: charts of the current result and the experiment tools. */
export function BottomDock() {
  const dockTab = useViewStore((state) => state.dockTab);
  const setDockTab = useViewStore((state) => state.setDockTab);
  const dockSize = useViewStore((state) => state.dockSize);
  const setDockSize = useViewStore((state) => state.setDockSize);
  const experimentCount = useExperimentStore((state) => state.experiments.length);

  const tabs = [
    { id: "velocity", label: "Velocity" },
    { id: "pressure", label: "Pressure" },
    { id: "drag", label: "Drag" },
    { id: "downforce", label: "Downforce" },
    { id: "performance", label: "Performance" },
    { id: "tradeoff", label: "Aero tradeoff", divider: true },
    { id: "sweep", label: "Parameter sweep" },
    { id: "design-space", label: "Design space" },
    { id: "explorer", label: "Experiment mode" },
    { id: "optimizer", label: "Optimizer" },
    { id: "history", label: "History", badge: experimentCount, divider: true },
    { id: "engines", label: "CFD / ML" },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex shrink-0 items-stretch">
        <Tabs tabs={tabs} active={dockTab} onChange={setDockTab} label="Analysis" size="sm" className="min-w-0 flex-1" />
        <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-2.5" role="group" aria-label="Dock height">
          {SIZES.map((size) => (
            <button
              key={size.id}
              type="button"
              title={size.title}
              aria-label={size.title}
              aria-pressed={dockSize === size.id}
              onClick={() => setDockSize(size.id)}
              className={`flex h-6 w-6 items-center justify-center transition-colors ${
                dockSize === size.id ? "bg-raise text-ink" : "text-ink-3 hover:bg-panel-2 hover:text-ink"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <rect x="3.5" y={12.5 - size.fill * 0.75} width="9" height={size.fill * 0.75} rx="1" fill="currentColor" />
              </svg>
            </button>
          ))}
        </div>
      </div>
      {dockSize !== "collapsed" && (
        <div role="tabpanel" aria-label={tabs.find((tab) => tab.id === dockTab)?.label} className="min-h-0 flex-1 overflow-hidden">
          {dockTab === "velocity" && <VelocityCharts />}
          {dockTab === "pressure" && <PressureCharts />}
          {dockTab === "drag" && <DragCharts />}
          {dockTab === "downforce" && <DownforceCharts />}
          {dockTab === "performance" && <PerformanceCharts />}
          {dockTab === "tradeoff" && <TradeoffPanel />}
          {dockTab === "sweep" && <SweepPanel />}
          {dockTab === "design-space" && <DesignSpacePanel />}
          {dockTab === "explorer" && <ExplorerPanel />}
          {dockTab === "optimizer" && <OptimizerPanel />}
          {dockTab === "history" && <HistoryPanel />}
          {dockTab === "engines" && <EnginesPanel />}
        </div>
      )}
    </div>
  );
}
