"use client";

import { NumberInput, Select } from "@/components/ui/Field";
import { ProgressBar } from "@/components/ui/Layout";
import { ErrorBox } from "@/components/dashboard/ResultsPanel";
import { PARAM_BY_ID, PARAM_DEFINITIONS, PARAM_GROUPS } from "@/lib/geometry/parameters";
import { makeConfig } from "@/lib/simulation/config";
import type { SweepMetric, SweepRow } from "@/lib/simulation/sweep";
import type { TaskState } from "@/lib/state/analysisStore";
import { useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";
import { currentVehicle, useSimStore } from "@/lib/state/simStore";
import type { GeometryParams, ParamId, SimulationConfig, SimulationMode } from "@/lib/types";
import { type Quantity, quantityOfParam, type UnitSystem, unitOf } from "@/lib/utils/units";

export type AnalysisEngine = "analytical" | "reduced-order" | "ml-surrogate";

export interface SweepRange {
  start: number;
  end: number;
  step: number;
}

/** A sensible starting range for sweeping a parameter around its current value. */
export function defaultRange(param: ParamId, geometry: GeometryParams): SweepRange {
  const definition = PARAM_BY_ID[param];
  if (param === "spoilerAngle") return { start: 0, end: 20, step: 2 };
  const span = definition.max - definition.min;
  const start = Math.max(definition.min, geometry[param] - 0.2 * span);
  const end = Math.min(definition.max, geometry[param] + 0.2 * span);
  // About eight intervals, rounded to a whole number of slider steps.
  const step = Math.max(Math.round((end - start) / 8 / definition.step), 1) * definition.step;
  return { start, end, step };
}

export function ParamSelect({ value, onChange, label, exclude }: { value: ParamId; onChange: (id: ParamId) => void; label: string; exclude?: ParamId }) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as ParamId)}
      className="h-7 w-full min-w-0 border border-line bg-bg px-1.5 text-[13px] text-ink hover:border-line-strong focus:border-data"
    >
      {PARAM_GROUPS.map((group) => (
        <optgroup key={group.id} label={group.label}>
          {PARAM_DEFINITIONS.filter((definition) => definition.group === group.id && definition.id !== "minGroundClearance").map(
            (definition) => (
              <option key={definition.id} value={definition.id} disabled={definition.id === exclude}>
                {definition.label}
              </option>
            ),
          )}
        </optgroup>
      ))}
    </select>
  );
}

/** Start / end / step inputs for a parameter, in display units. */
export function RangeFields({ param, range, onChange }: { param: ParamId; range: SweepRange; onChange: (range: SweepRange) => void }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const definition = PARAM_BY_ID[param];
  const unit = unitOf(system, quantityOfParam(definition.kind));
  const decimals = definition.kind === "ratio" ? 2 : unit.decimals;
  const lo = unit.toDisplay(definition.min);
  const hi = unit.toDisplay(definition.max);
  const field = (key: keyof SweepRange, label: string) => (
    <label className="min-w-0 flex-1">
      <span className="label block">
        {label}
        {unit.label ? ` · ${unit.label}` : ""}
      </span>
      <NumberInput
        ariaLabel={`${label} of ${definition.label}`}
        value={key === "step" ? Math.abs(unit.toDisplay(range.step) - unit.toDisplay(0)) : unit.toDisplay(range[key])}
        decimals={decimals}
        min={key === "step" ? Math.abs(unit.toDisplay(definition.step) - unit.toDisplay(0)) : lo}
        max={key === "step" ? hi - lo : hi}
        onCommit={(display) =>
          onChange({
            ...range,
            [key]: key === "step" ? Math.abs(unit.fromDisplay(display) - unit.fromDisplay(0)) : unit.fromDisplay(display),
          })
        }
      />
    </label>
  );
  return (
    <div className="flex gap-1.5">
      {field("start", "Start")}
      {field("end", "End")}
      {field("step", "Step")}
    </div>
  );
}

export function EngineSelect({ value, onChange }: { value: AnalysisEngine; onChange: (engine: AnalysisEngine) => void }) {
  const backendOnline = useBackendStore((state) => state.status === "online");
  const demoMode = useSettingsStore((state) => state.demoMode);
  return (
    <Select<AnalysisEngine>
      ariaLabel="Simulation engine for this study"
      className="w-full"
      value={value}
      options={[
        { value: "analytical", label: "Mode A · Analytical (instant)" },
        { value: "reduced-order", label: "Mode B · Reduced-order, coarse grid" },
        {
          value: "ml-surrogate",
          label: backendOnline && !demoMode ? "Mode D · ML surrogate (backend)" : "Mode D · ML surrogate (backend offline)",
          disabled: !backendOnline || demoMode,
        },
      ]}
      onChange={onChange}
    />
  );
}

/** Configuration of the current editor state for a multi-run study with the chosen engine. */
export function studyConfig(engine: AnalysisEngine): SimulationConfig {
  const state = useSimStore.getState();
  // Studies repeat the solve many times, so Mode B always uses the coarse grid here.
  return makeConfig(currentVehicle(state), state.geometry, state.environment, state.speed, engine as SimulationMode, "coarse");
}

export function initialEngine(mode: SimulationMode): AnalysisEngine {
  return mode === "reduced-order" ? "reduced-order" : "analytical";
}

export function TaskStatus({ task, label }: { task: TaskState<unknown>; label: string }) {
  return (
    <>
      {task.running && (
        <div className="mt-2">
          <ProgressBar value={task.progress} label={label} />
          <p className="num mt-0.5 text-[11px] text-ink-3">
            {label} · {Math.round(task.progress * 100)} %
          </p>
        </div>
      )}
      {task.error && (
        <div className="mt-2">
          <ErrorBox code={task.error.code} message={task.error.message} />
        </div>
      )}
    </>
  );
}

const METRIC_QUANTITY: Record<SweepMetric, Quantity | null> = {
  cd: null,
  cl: null,
  drag: "force",
  downforce: "force",
  topSpeed: "speed",
  efficiency: null,
  accel100: "time",
};

const METRIC_DECIMALS: Record<SweepMetric, number> = {
  cd: 4,
  cl: 4,
  drag: 0,
  downforce: 0,
  topSpeed: 1,
  efficiency: 3,
  accel100: 2,
};

/** Metric of a sweep row converted to display units (null when the point is invalid). */
export function metricDisplay(system: UnitSystem, row: SweepRow, metric: SweepMetric): number | null {
  const value = row[metric];
  if (value === null || !Number.isFinite(value)) return null;
  const quantity = METRIC_QUANTITY[metric];
  return quantity ? unitOf(system, quantity).toDisplay(value) : value;
}

export function metricUnit(system: UnitSystem, metric: SweepMetric): string {
  const quantity = METRIC_QUANTITY[metric];
  return quantity ? unitOf(system, quantity).label : "–";
}

export function metricDecimals(system: UnitSystem, metric: SweepMetric): number {
  if (metric === "topSpeed") return system === "si" ? 2 : 1;
  return METRIC_DECIMALS[metric];
}

/** Value of a swept parameter in display units. */
export function paramDisplay(system: UnitSystem, param: ParamId, value: number): number {
  return unitOf(system, quantityOfParam(PARAM_BY_ID[param].kind)).toDisplay(value);
}

export function paramAxisLabel(system: UnitSystem, param: ParamId): string {
  const definition = PARAM_BY_ID[param];
  const unit = unitOf(system, quantityOfParam(definition.kind)).label;
  return unit ? `${definition.label} (${unit})` : definition.label;
}

export function paramDecimals(system: UnitSystem, param: ParamId): number {
  const definition = PARAM_BY_ID[param];
  if (definition.kind === "ratio") return 2;
  return unitOf(system, quantityOfParam(definition.kind)).decimals;
}
