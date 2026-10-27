"use client";

import { useState } from "react";
import { Heatmap } from "@/components/charts/Heatmap";
import {
  type AnalysisEngine,
  defaultRange,
  EngineSelect,
  initialEngine,
  metricDecimals,
  metricDisplay,
  metricUnit,
  paramAxisLabel,
  paramDecimals,
  paramDisplay,
  ParamSelect,
  RangeFields,
  studyConfig,
  type SweepRange,
  TaskStatus,
} from "@/components/simulator/AnalysisControls";
import { exportSweepCsv } from "@/components/simulator/SweepPanel";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { SWEEP_METRICS, type SweepMetric, sweepValues } from "@/lib/simulation/sweep";
import { executeSweep, useAnalysisStore } from "@/lib/state/analysisStore";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import type { ParamId } from "@/lib/types";

const MAX_POINTS_PER_AXIS = 12;

/** 2D design space: one metric mapped over two geometry parameters. */
export function DesignSpacePanel() {
  const geometry = useSimStore((state) => state.geometry);
  const mode = useSimStore((state) => state.mode);
  const spec = useSimStore((state) => state.spec);
  const powertrain = useSimStore((state) => state.powertrain);
  const system = useSettingsStore((state) => state.unitSystem);
  const task = useAnalysisStore((state) => state.designSpace);

  const [paramX, setParamX] = useState<ParamId>("spoilerAngle");
  const [paramY, setParamY] = useState<ParamId>("rideHeight");
  const [rangeX, setRangeX] = useState<SweepRange>({ start: 0, end: 20, step: 5 });
  const [rangeY, setRangeY] = useState<SweepRange>({ start: 0.06, end: 0.14, step: 0.02 });
  const [metric, setMetric] = useState<SweepMetric>("cd");
  const [engine, setEngine] = useState<AnalysisEngine>(() => initialEngine(mode));

  const valuesX = sweepValues(paramX, rangeX.start, rangeX.end, rangeX.step, MAX_POINTS_PER_AXIS);
  const valuesY = sweepValues(paramY, rangeY.start, rangeY.end, rangeY.step, MAX_POINTS_PER_AXIS);
  const total = valuesX.length * valuesY.length;

  const run = () =>
    executeSweep("designSpace", {
      config: studyConfig(engine),
      spec,
      powertrain,
      paramX,
      valuesX,
      paramY,
      valuesY,
    });

  const result = task.result;
  let heatmap = null;
  if (result && result.request.paramY) {
    const { paramX: px, paramY: py, valuesX: xs, valuesY: ys } = result.request;
    // Rows were produced in (y outer, x inner) order.
    const grid = ys.map((_, row) => xs.map((__, column) => metricDisplay(system, result.rows[row * xs.length + column], metric)));
    const metricLabel = SWEEP_METRICS.find((entry) => entry.id === metric)?.label ?? metric;
    heatmap = (
      <Heatmap
        title={`${metricLabel} over the design space`}
        note={result.provenance}
        xLabel={paramAxisLabel(system, px)}
        yLabel={paramAxisLabel(system, py)}
        xValues={xs.map((value) => paramDisplay(system, px, value))}
        yValues={ys.map((value) => paramDisplay(system, py, value))}
        values={grid}
        xDecimals={paramDecimals(system, px)}
        yDecimals={paramDecimals(system, py)}
        valueDecimals={Math.min(metricDecimals(system, metric), 3)}
        valueLabel={`${metricLabel} (${metricUnit(system, metric)})`}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="scroll-thin w-[270px] shrink-0 overflow-y-auto border-r border-line p-2.5">
        <div className="label mb-1">X parameter (columns)</div>
        <ParamSelect
          label="X parameter"
          value={paramX}
          exclude={paramY}
          onChange={(id) => {
            setParamX(id);
            setRangeX(defaultRange(id, geometry));
          }}
        />
        <div className="mt-1.5">
          <RangeFields param={paramX} range={rangeX} onChange={setRangeX} />
        </div>
        <div className="label mt-2.5 mb-1">Y parameter (rows)</div>
        <ParamSelect
          label="Y parameter"
          value={paramY}
          exclude={paramX}
          onChange={(id) => {
            setParamY(id);
            setRangeY(defaultRange(id, geometry));
          }}
        />
        <div className="mt-1.5">
          <RangeFields param={paramY} range={rangeY} onChange={setRangeY} />
        </div>
        <div className="label mt-2.5 mb-1">Engine</div>
        <EngineSelect value={engine} onChange={setEngine} />
        <div className="mt-2.5 flex items-center gap-2">
          <Button variant="primary" onClick={run} disabled={task.running || total < 4 || paramX === paramY}>
            {task.running ? "Running…" : `Map ${valuesX.length} × ${valuesY.length} = ${total} points`}
          </Button>
          <Button size="sm" disabled={!result} onClick={() => result && exportSweepCsv(result)}>
            CSV
          </Button>
        </div>
        <TaskStatus task={task} label="Design-space progress" />
        <p className="mt-2 text-xs leading-normal text-ink-3">At most {MAX_POINTS_PER_AXIS} values per axis.</p>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
        <div className="flex shrink-0 items-center gap-2">
          <span className="label">Metric</span>
          <Select<SweepMetric>
            ariaLabel="Metric shown in the heatmap"
            value={metric}
            options={SWEEP_METRICS.map((entry) => ({ value: entry.id, label: entry.label }))}
            onChange={setMetric}
          />
        </div>
        {heatmap ?? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-ink-3">
            Choose two parameters and their ranges, then map the design space.
          </div>
        )}
      </div>
    </div>
  );
}
