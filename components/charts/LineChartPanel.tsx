"use client";

import { type ReactNode, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES_COLORS } from "@/lib/utils/colormap";
import { downloadCsv, downloadPng, downloadSvg, slug } from "@/lib/utils/export";

export interface SeriesDef {
  key: string;
  label: string;
  color?: string;
  dashed?: boolean;
  decimals?: number;
  /** Start hidden; the user can switch it on from the legend. */
  hidden?: boolean;
}

export type ChartRow = Record<string, number | null | undefined>;

interface LineChartPanelProps {
  title: string;
  /** Provenance or caveat shown under the title. */
  note?: ReactNode;
  data: ChartRow[];
  xKey: string;
  xLabel: string;
  xDecimals?: number;
  yLabel: string;
  yDecimals?: number;
  series: SeriesDef[];
  /** Vertical marker lines (x in the chart's display units). */
  markers?: { x: number; label: string }[];
  showPoints?: boolean;
  /** Draw a horizontal line at y = 0. */
  zeroLine?: boolean;
  className?: string;
}

interface ChartMouseState {
  activeLabel?: string | number;
}

const AXIS_TICK = { fill: "#8b95a2", fontSize: 11 };

/**
 * Line chart with hover read-out, drag-to-zoom, reset, selectable series and
 * PNG / SVG / CSV export. Axis titles always carry their units.
 */
export function LineChartPanel({
  title,
  note,
  data,
  xKey,
  xLabel,
  xDecimals = 0,
  yLabel,
  yDecimals = 2,
  series,
  markers = [],
  showPoints = false,
  zeroLine = false,
  className = "",
}: LineChartPanelProps) {
  const container = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(series.filter((entry) => entry.hidden).map((entry) => entry.key)),
  );
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);

  const visibleSeries = series.filter((entry) => !hidden.has(entry.key));
  const shown = useMemo(() => {
    if (!zoom) return data;
    return data.filter((row) => {
      const x = row[xKey];
      return typeof x === "number" && x >= zoom[0] && x <= zoom[1];
    });
  }, [data, zoom, xKey]);

  // A narrow value range needs more decimals, or neighbouring axis ticks print the same label.
  let low = Infinity;
  let high = -Infinity;
  for (const row of shown) {
    for (const entry of visibleSeries) {
      const value = row[entry.key];
      if (typeof value === "number" && Number.isFinite(value)) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  }
  const tickSpacing = (high - low) / 4;
  const yTickDecimals =
    tickSpacing > 0 ? Math.min(Math.max(yDecimals, Math.ceil(-Math.log10(tickSpacing))), yDecimals + 3) : yDecimals;

  const toggle = (key: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else if (next.size < series.length - 1) next.add(key);
      return next;
    });

  const svg = () => container.current?.querySelector<SVGSVGElement>("svg.recharts-surface") ?? null;
  const fileBase = slug(title);
  const exportCsv = () =>
    downloadCsv(
      [xLabel, ...series.map((entry) => `${entry.label} [${yLabel}]`)],
      data.map((row) => [row[xKey], ...series.map((entry) => row[entry.key])]),
      `${fileBase}.csv`,
    );

  const finishDrag = () => {
    if (drag && Math.abs(drag.end - drag.start) > 1e-9) {
      setZoom([Math.min(drag.start, drag.end), Math.max(drag.start, drag.end)]);
    }
    setDrag(null);
  };

  const empty = data.length === 0;
  return (
    <figure className={`flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-line bg-panel ${className}`}>
      <figcaption className="flex items-start justify-between gap-3 px-3.5 pt-2.5 pb-1">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
          {note && <div className="truncate text-xs text-ink-3">{note}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {zoom && (
            <button type="button" className="mr-1 h-6 border border-accent/70 px-2 text-[11px] font-medium text-accent" onClick={() => setZoom(null)}>
              Reset zoom
            </button>
          )}
          {[
            { label: "PNG", run: () => { const el = svg(); if (el) void downloadPng(el, `${fileBase}.png`); } },
            { label: "SVG", run: () => { const el = svg(); if (el) downloadSvg(el, `${fileBase}.svg`); } },
            { label: "CSV", run: exportCsv },
          ].map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={empty}
              aria-label={`Export ${title} as ${action.label}`}
              className="h-6 px-1.5 text-[11px] font-medium text-ink-3 transition-colors enabled:hover:bg-raise enabled:hover:text-ink disabled:opacity-30"
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      </figcaption>

      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 px-3.5 pt-0.5" role="group" aria-label={`Series of ${title}`}>
          {series.map((entry, index) => {
            const color = entry.color ?? SERIES_COLORS[index % SERIES_COLORS.length];
            const off = hidden.has(entry.key);
            return (
              <button
                key={entry.key}
                type="button"
                aria-pressed={!off}
                onClick={() => toggle(entry.key)}
                className={`flex items-center gap-1.5 text-xs transition-colors ${off ? "text-ink-3 line-through" : "text-ink-2 hover:text-ink"}`}
              >
                <svg width="16" height="6" aria-hidden>
                  <line x1="1" y1="3" x2="15" y2="3" stroke={off ? "#3b4350" : color} strokeWidth="2" strokeLinecap="round" strokeDasharray={entry.dashed ? "4 3" : undefined} />
                </svg>
                {entry.label}
              </button>
            );
          })}
        </div>
      )}

      <div ref={container} className="min-h-[120px] flex-1 select-none px-1.5 pt-1.5 pb-1" title="Drag horizontally to zoom">
        {empty ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-3">No data — run a simulation.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={shown}
              margin={{ top: 6, right: 16, bottom: 16, left: 8 }}
              onMouseDown={(state: ChartMouseState) => {
                if (typeof state?.activeLabel === "number") setDrag({ start: state.activeLabel, end: state.activeLabel });
              }}
              onMouseMove={(state: ChartMouseState) => {
                if (drag && typeof state?.activeLabel === "number") setDrag({ start: drag.start, end: state.activeLabel });
              }}
              onMouseUp={finishDrag}
              onMouseLeave={() => setDrag(null)}
            >
              <CartesianGrid stroke="#21262e" />
              <XAxis
                dataKey={xKey}
                type="number"
                domain={["dataMin", "dataMax"]}
                tick={AXIS_TICK}
                tickFormatter={(value: number) => value.toFixed(xDecimals)}
                stroke="#3b4350"
                tickLine={false}
                tickMargin={6}
                label={{ value: xLabel, position: "insideBottom", offset: -10, fill: "#b4bbc5", fontSize: 11 }}
              />
              <YAxis
                tick={AXIS_TICK}
                width={52}
                tickFormatter={(value: number) => value.toFixed(yTickDecimals)}
                stroke="#3b4350"
                tickLine={false}
                tickMargin={4}
                domain={["auto", "auto"]}
                label={{ value: yLabel, angle: -90, position: "insideLeft", offset: 10, fill: "#b4bbc5", fontSize: 11, style: { textAnchor: "middle" } }}
              />
              <Tooltip
                isAnimationActive={false}
                cursor={{ stroke: "#8b95a2", strokeDasharray: "2 2" }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  return (
                    <div className="rounded-lg border border-line-strong bg-raise px-3 py-2 text-xs shadow-xl shadow-black/40">
                      <div className="num mb-1 text-ink-2">
                        {xLabel}: {typeof label === "number" ? label.toFixed(Math.max(xDecimals, 1)) : label}
                      </div>
                      {payload.map((item) => {
                        const entry = series.find((candidate) => candidate.label === item.name);
                        const value = item.value;
                        return (
                          <div key={String(item.dataKey)} className="flex items-center gap-2 py-px">
                            <span aria-hidden className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: item.color }} />
                            <span className="text-ink-2">{item.name}</span>
                            <span className="num ml-auto pl-4 font-medium text-ink">
                              {typeof value === "number" ? value.toFixed(entry?.decimals ?? yTickDecimals + 1) : String(value)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />
              {zeroLine && <ReferenceLine y={0} stroke="#8b95a2" strokeWidth={1} />}
              {markers.map((marker) => (
                <ReferenceLine
                  key={marker.label}
                  x={marker.x}
                  stroke="#f2a33a"
                  strokeDasharray="3 3"
                  label={{ value: marker.label, position: "insideTopRight", fill: "#f2a33a", fontSize: 11 }}
                />
              ))}
              {visibleSeries.map((entry) => {
                const color = entry.color ?? SERIES_COLORS[series.indexOf(entry) % SERIES_COLORS.length];
                return (
                  <Line
                    key={entry.key}
                    type="linear"
                    dataKey={entry.key}
                    name={entry.label}
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={entry.dashed ? "5 4" : undefined}
                    dot={showPoints ? { r: 2.5, fill: color, strokeWidth: 0 } : false}
                    activeDot={{ r: 4, stroke: "#14171c", strokeWidth: 2 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                );
              })}
              {drag && <ReferenceArea x1={drag.start} x2={drag.end} fill="#5cc8f0" fillOpacity={0.12} stroke="#5cc8f0" strokeOpacity={0.4} />}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </figure>
  );
}
