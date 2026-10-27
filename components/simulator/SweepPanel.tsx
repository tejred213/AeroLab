"use client";

import { useState } from "react";
import { type ChartRow, LineChartPanel } from "@/components/charts/LineChartPanel";
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
import { Button } from "@/components/ui/Button";
import { PARAM_BY_ID } from "@/lib/geometry/parameters";
import { type SweepMetric, type SweepResult, sweepValues } from "@/lib/simulation/sweep";
import { executeSweep, useAnalysisStore } from "@/lib/state/analysisStore";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import type { ParamId } from "@/lib/types";
import { downloadCsv, slug } from "@/lib/utils/export";

const CHART_METRICS: { metric: SweepMetric; title: string }[] = [
  { metric: "cd", title: "Cd" },
  { metric: "cl", title: "Cl" },
  { metric: "drag", title: "Drag" },
  { metric: "topSpeed", title: "Top speed" },
];

/** CSV of a sweep: every metric in SI units, one row per design point. */
export function exportSweepCsv(result: SweepResult): void {
  const { paramX, paramY } = result.request;
  const headers = [
    `${PARAM_BY_ID[paramX].label} [SI]`,
    ...(paramY ? [`${PARAM_BY_ID[paramY].label} [SI]`] : []),
    "valid",
    "Cd",
    "Cd uncertainty",
    "Cl",
    "Cl uncertainty",
    "Drag [N]",
    "Downforce [N]",
    "Top speed [m/s]",
    "Efficiency (-Cl/Cd)",
    "0-100 km/h [s]",
    "error",
  ];
  const rows = result.rows.map((row) => [
    row.x,
    ...(paramY ? [row.y] : []),
    row.valid,
    row.cd,
    row.cdUncertainty,
    row.cl,
    row.clUncertainty,
    row.drag,
    row.downforce,
    row.topSpeed,
    row.efficiency,
    row.accel100,
    row.error,
  ]);
  downloadCsv(headers, rows, `sweep-${slug(PARAM_BY_ID[paramX].label)}${paramY ? `-x-${slug(PARAM_BY_ID[paramY].label)}` : ""}.csv`);
}

/** Charts of a 1D sweep: one panel per metric against the swept parameter. */
export function SweepCharts({ result }: { result: SweepResult }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const param = result.request.paramX;
  const rows: ChartRow[] = result.rows.map((row) => {
    const chartRow: ChartRow = { x: paramDisplay(system, param, row.x) };
    for (const { metric } of CHART_METRICS) chartRow[metric] = metricDisplay(system, row, metric);
    return chartRow;
  });
  return (
    <>
      {CHART_METRICS.map(({ metric, title }) => (
        <LineChartPanel
          key={metric}
          title={`${title} versus ${PARAM_BY_ID[param].label.toLowerCase()}`}
          note={result.provenance}
          data={rows}
          xKey="x"
          xLabel={paramAxisLabel(system, param)}
          xDecimals={paramDecimals(system, param)}
          yLabel={`${title} (${metricUnit(system, metric)})`}
          yDecimals={Math.max(metricDecimals(system, metric) - 1, 0)}
          showPoints
          zeroLine={metric === "cl"}
          series={[{ key: metric, label: title, decimals: metricDecimals(system, metric) }]}
        />
      ))}
    </>
  );
}

/** Parameter sweep: repeat the simulation over a range of one geometry parameter. */
export function SweepPanel() {
  const geometry = useSimStore((state) => state.geometry);
  const mode = useSimStore((state) => state.mode);
  const spec = useSimStore((state) => state.spec);
  const powertrain = useSimStore((state) => state.powertrain);
  const task = useAnalysisStore((state) => state.sweep);

  const [param, setParam] = useState<ParamId>("spoilerAngle");
  const [range, setRange] = useState<SweepRange>(() => defaultRange("spoilerAngle", geometry));
  const [engine, setEngine] = useState<AnalysisEngine>(() => initialEngine(mode));

  const values = sweepValues(param, range.start, range.end, range.step);
  const run = () =>
    executeSweep("sweep", {
      config: studyConfig(engine),
      spec,
      powertrain,
      paramX: param,
      valuesX: values,
      paramY: null,
      valuesY: [],
    });

  const invalid = task.result?.rows.filter((row) => !row.valid) ?? [];
  return (
    <div className="flex h-full min-h-0">
      <div className="scroll-thin w-[270px] shrink-0 overflow-y-auto border-r border-line p-2.5">
        <div className="label mb-1">Parameter</div>
        <ParamSelect
          label="Parameter to sweep"
          value={param}
          onChange={(id) => {
            setParam(id);
            setRange(defaultRange(id, geometry));
          }}
        />
        <div className="mt-2">
          <RangeFields param={param} range={range} onChange={setRange} />
        </div>
        <div className="label mt-2 mb-1">Engine</div>
        <EngineSelect value={engine} onChange={setEngine} />
        <div className="mt-2.5 flex items-center gap-2">
          <Button variant="primary" onClick={run} disabled={task.running || values.length < 2}>
            {task.running ? "Running…" : `Run sweep · ${values.length} points`}
          </Button>
          <Button size="sm" disabled={!task.result} onClick={() => task.result && exportSweepCsv(task.result)}>
            CSV
          </Button>
        </div>
        <TaskStatus task={task} label="Sweep progress" />
        {invalid.length > 0 && (
          <p className="mt-2 border-l-2 border-warn pl-2 text-xs leading-normal text-ink-2">
            <span className="num mr-1 font-semibold text-warn">WARNING</span>
            {invalid.length} point{invalid.length === 1 ? "" : "s"} could not be simulated and {invalid.length === 1 ? "is" : "are"} left
            blank: {invalid[0].error}
          </p>
        )}
        <p className="mt-2 text-xs leading-normal text-ink-3">
          All other parameters, the conditions and the powertrain stay as set in the editor.
        </p>
      </div>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto p-2">
        {task.result ? (
          <SweepCharts result={task.result} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-ink-3">
            Choose a parameter and a range, then run the sweep.
          </div>
        )}
      </div>
    </div>
  );
}
