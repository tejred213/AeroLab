"use client";

import { MODE_LABELS } from "@/components/dashboard/ResultsPanel";
import { diffGeometry, PARAM_BY_ID } from "@/lib/geometry/parameters";
import type { Experiment } from "@/lib/state/experimentStore";
import { useSettingsStore } from "@/lib/state/settingsStore";
import type { ParamId } from "@/lib/types";
import { formatParam } from "@/lib/utils/describe";
import { formatNumber, formatSigned, type Quantity, type UnitSystem, unitOf } from "@/lib/utils/units";

interface MetricRow {
  label: string;
  /** SI value of an experiment, or null when not available. */
  value: (experiment: Experiment) => number | null;
  quantity?: Quantity;
  decimals?: number;
  signed?: boolean;
  /** Which direction is usually considered an improvement (for the delta annotation). */
  better?: "lower" | "higher";
}

export const COMPARISON_METRICS: MetricRow[] = [
  { label: "Cd", value: (e) => e.aero.coefficients.cd, decimals: 3, better: "lower" },
  { label: "Cl", value: (e) => e.aero.coefficients.cl, decimals: 3, signed: true },
  { label: "Drag", value: (e) => e.aero.forces.drag, quantity: "force", better: "lower" },
  { label: "Downforce", value: (e) => e.aero.forces.downforce, quantity: "force", better: "higher" },
  { label: "Top speed", value: (e) => e.performance.topSpeed, quantity: "speed", better: "higher" },
  { label: "0–100 km/h", value: (e) => e.performance.accelTimes.find((t) => t.target === 100)?.time ?? null, quantity: "time", decimals: 1, better: "lower" },
  { label: "Power @ 100 km/h", value: (e) => e.performance.power100, quantity: "power", decimals: 1, better: "lower" },
  { label: "Power @ 200 km/h", value: (e) => e.performance.power200, quantity: "power", decimals: 1, better: "lower" },
  { label: "Efficiency −Cl/Cd", value: (e) => -e.aero.coefficients.cl / e.aero.coefficients.cd, decimals: 2, signed: true, better: "higher" },
  { label: "Frontal area", value: (e) => e.aero.coefficients.frontalArea, quantity: "area" },
];

function formatMetric(system: UnitSystem, row: MetricRow, value: number | null, withUnit = true): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (!row.quantity) return row.signed ? formatSigned(value, row.decimals ?? 3) : formatNumber(value, row.decimals ?? 3);
  const unit = unitOf(system, row.quantity);
  const text = unit.toDisplay(value).toFixed(row.decimals ?? unit.decimals);
  return withUnit && unit.label ? `${text} ${unit.label}` : text;
}

function formatDelta(system: UnitSystem, row: MetricRow, base: number | null, value: number | null): { text: string; tone: string } {
  if (base === null || value === null) return { text: "—", tone: "text-ink-3" };
  const unit = row.quantity ? unitOf(system, row.quantity) : null;
  const delta = unit ? unit.toDisplay(value) - unit.toDisplay(base) : value - base;
  const decimals = row.decimals ?? unit?.decimals ?? 3;
  const text = formatSigned(delta, decimals);
  if (Number(delta.toFixed(decimals)) === 0 || !row.better) return { text, tone: "text-ink-2" };
  const improved = row.better === "lower" ? delta < 0 : delta > 0;
  return { text: `${text} ${improved ? "▲ better" : "▼ worse"}`, tone: improved ? "text-ok" : "text-warn" };
}

interface ComparisonTableProps {
  /** First entry is the baseline every other column is compared against. */
  experiments: Experiment[];
  /** Column headings; defaults to the experiment names. */
  headings?: string[];
}

/**
 * Side-by-side comparison: the parameters that differ, then the aerodynamic
 * and performance metrics with the change relative to the first column.
 */
export function ComparisonTable({ experiments, headings }: ComparisonTableProps) {
  const system = useSettingsStore((state) => state.unitSystem);
  if (experiments.length === 0) return null;
  const [baseline, ...others] = experiments;

  // Union of the parameters that differ from the baseline in any column.
  const changed: ParamId[] = [];
  for (const other of others) {
    for (const change of diffGeometry(baseline.config.geometry, other.config.geometry)) {
      if (!changed.includes(change.id)) changed.push(change.id);
    }
  }
  const speedDiffers = others.some((other) => Math.abs(other.config.speed - baseline.config.speed) > 1e-6);
  const modes = new Set(experiments.map((experiment) => experiment.aero.mode));
  const cell = "num px-2 py-[5px] text-right text-[13px] whitespace-nowrap";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="label px-2 py-1 text-left font-normal">
              Quantity
            </th>
            {experiments.map((experiment, index) => (
              <th key={experiment.id} scope="col" className="px-2 py-1 text-right align-bottom">
                <div className="label">{headings?.[index] ?? (index === 0 ? "Baseline" : "Modified")}</div>
                <div className="max-w-[180px] truncate text-[13px] font-medium text-ink" title={experiment.name}>
                  {experiment.name}
                </div>
                <div className="num text-[11px] font-normal text-ink-3">
                  {MODE_LABELS[experiment.aero.mode].short} · {experiment.vehicleName}
                </div>
              </th>
            ))}
            {others.length === 1 && (
              <th scope="col" className="label px-2 py-1 text-right font-normal">
                Change
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {speedDiffers && (
            <tr className="border-b border-line">
              <th scope="row" className="px-2 py-[5px] text-left text-[13px] font-normal text-ink-2">
                Test speed
              </th>
              {experiments.map((experiment) => (
                <td key={experiment.id} className={`${cell} text-ink`}>
                  {formatMetric(system, { label: "", value: () => null, quantity: "speed" }, experiment.config.speed)}
                </td>
              ))}
              {others.length === 1 && <td />}
            </tr>
          )}
          {changed.map((id) => (
            <tr key={id} className="border-b border-line">
              <th scope="row" className="px-2 py-[5px] text-left text-[13px] font-normal text-ink-2">
                {PARAM_BY_ID[id].label}
              </th>
              {experiments.map((experiment, index) => {
                const differs = index > 0 && Math.abs(experiment.config.geometry[id] - baseline.config.geometry[id]) > 1e-9;
                return (
                  <td key={experiment.id} className={`${cell} ${differs ? "text-accent" : "text-ink"}`}>
                    {formatParam(system, id, experiment.config.geometry[id])}
                  </td>
                );
              })}
              {others.length === 1 && <td />}
            </tr>
          ))}
          {changed.length === 0 && !speedDiffers && others.length > 0 && (
            <tr className="border-b border-line">
              <td colSpan={experiments.length + 2} className="px-2 py-1 text-xs text-ink-3">
                Geometry is identical; differences come from conditions, powertrain or the simulation mode.
              </td>
            </tr>
          )}
          {COMPARISON_METRICS.map((row, rowIndex) => {
            const base = row.value(baseline);
            return (
              <tr key={row.label} className={`border-b border-line ${rowIndex === 0 ? "border-t-2 border-t-line-strong" : ""}`}>
                <th scope="row" className="px-2 py-[5px] text-left text-[13px] font-normal text-ink-2">
                  {row.label}
                </th>
                {experiments.map((experiment) => (
                  <td key={experiment.id} className={`${cell} text-ink`}>
                    {formatMetric(system, row, row.value(experiment))}
                  </td>
                ))}
                {others.length === 1 &&
                  (() => {
                    const delta = formatDelta(system, row, base, row.value(others[0]));
                    return <td className={`${cell} ${delta.tone}`}>{delta.text}</td>;
                  })()}
              </tr>
            );
          })}
        </tbody>
      </table>
      {modes.size > 1 && (
        <p className="mt-1.5 border-l-2 border-warn pl-2 text-xs text-ink-2">
          <span className="num mr-1 font-semibold text-warn">WARNING</span>
          These results come from different simulation modes. Differences between them partly reflect the models, not
          the designs.
        </p>
      )}
    </div>
  );
}
