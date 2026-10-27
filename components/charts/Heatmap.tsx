"use client";

import { SCALE_CSS_GRADIENT, scaleCss } from "@/lib/utils/colormap";

interface HeatmapProps {
  title: string;
  note?: string;
  xLabel: string;
  yLabel: string;
  /** Column and row values, already in display units. */
  xValues: number[];
  yValues: number[];
  /** values[row][column]; null marks a point that could not be evaluated. */
  values: (number | null)[][];
  xDecimals: number;
  yDecimals: number;
  valueDecimals: number;
  valueLabel: string;
}

/**
 * Heatmap of one metric over two parameters. Every cell also prints its value,
 * so the map can be read without relying on colour.
 */
export function Heatmap({ title, note, xLabel, yLabel, xValues, yValues, values, xDecimals, yDecimals, valueDecimals, valueLabel }: HeatmapProps) {
  const finite = values.flat().filter((value): value is number => value !== null && Number.isFinite(value));
  const min = finite.length > 0 ? Math.min(...finite) : 0;
  const max = finite.length > 0 ? Math.max(...finite) : 1;
  const span = max - min || 1;

  return (
    <figure className="flex h-full min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-line bg-panel">
      <figcaption className="border-b border-line px-2 py-1">
        <div className="text-[13px] font-medium text-ink">{title}</div>
        {note && <div className="text-[11px] text-ink-3">{note}</div>}
      </figcaption>
      <div className="scroll-thin relative min-h-0 flex-1 overflow-auto p-2">
        <table className="border-separate border-spacing-px">
          <caption className="sr-only">
            {title}. Rows: {yLabel}. Columns: {xLabel}.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="label px-1 text-left font-normal whitespace-nowrap">
                {yLabel} ↓ / {xLabel} →
              </th>
              {xValues.map((x) => (
                <th key={x} scope="col" className="num px-1 text-right text-[11px] font-normal text-ink-2">
                  {x.toFixed(xDecimals)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {yValues.map((y, row) => (
              <tr key={y}>
                <th scope="row" className="num px-1 text-right text-[11px] font-normal text-ink-2">
                  {y.toFixed(yDecimals)}
                </th>
                {xValues.map((x, column) => {
                  const value = values[row]?.[column] ?? null;
                  if (value === null) {
                    return (
                      <td key={x} className="num h-7 min-w-[52px] border border-dashed border-line-strong px-1 text-center text-[11px] text-ink-3" title="Could not be simulated">
                        n/a
                      </td>
                    );
                  }
                  const t = (value - min) / span;
                  return (
                    <td
                      key={x}
                      className="num h-7 min-w-[52px] px-1 text-right text-[11px] font-medium"
                      // Mid-scale colours are bright, so dark text keeps the contrast high across the scale.
                      style={{ background: scaleCss(t), color: t < 0.12 ? "#f4f6f8" : "#0b0d10" }}
                      title={`${xLabel} ${x.toFixed(xDecimals)}, ${yLabel} ${y.toFixed(yDecimals)}: ${value.toFixed(valueDecimals)}`}
                    >
                      {value.toFixed(valueDecimals)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-2 py-1">
        <span className="num text-[11px] text-ink-2">{min.toFixed(valueDecimals)}</span>
        <span className="h-2 w-40 border border-line-strong" style={{ background: SCALE_CSS_GRADIENT }} aria-hidden />
        <span className="num text-[11px] text-ink-2">{max.toFixed(valueDecimals)}</span>
        <span className="text-[11px] text-ink-3">{valueLabel}</span>
      </div>
    </figure>
  );
}
