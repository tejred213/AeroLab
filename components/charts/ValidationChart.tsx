"use client";

import { useEffect, useRef, useState } from "react";
import type { ValidationRow } from "@/lib/simulation/validation";
import { formatSigned } from "@/lib/utils/units";

/** Mark colours, validated for colour-vision separation and contrast on the panel surface (#14171c). */
const PUBLISHED = "#3b9cc2";
const PREDICTED = "#cf801c";
const SURFACE = "#14171c";
const GRID = "#262c35";
const CONNECTOR = "#3b4350";
const REFERENCE = "#808a97";

const ROW = 26;
const TOP = 8;
const AXIS = 34;
const RIGHT = 16;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Tick values at a round step covering [min, max]. */
function ticks(min: number, max: number): number[] {
  const step = [0.02, 0.05, 0.1].find((candidate) => (max - min) / candidate <= 9) ?? 0.2;
  const values: number[] = [];
  for (let value = Math.ceil(min / step - 1e-9) * step; value <= max + 1e-9; value += step) values.push(Number(value.toFixed(4)));
  return values;
}

function LegendKey({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-2">
      <svg width="22" height="12" aria-hidden>
        {children}
      </svg>
      {label}
    </span>
  );
}

/**
 * Published versus predicted drag coefficient, one row per car (a dumbbell chart).
 * The whisker is the model's own one-sigma uncertainty; the tick is the reference
 * of the class the prediction starts from. Every value is also in the table below it.
 */
export function ValidationChart({ rows, title }: { rows: ValidationRow[]; title: string }) {
  const [containerRef, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);

  const labelWidth = width < 560 ? 132 : 250;
  const plotLeft = labelWidth + 8;
  const plotWidth = Math.max(width - plotLeft - RIGHT, 40);
  const height = TOP + rows.length * ROW + AXIS;

  const extremes = rows.flatMap((row) => [
    row.predictedCd - row.uncertainty,
    row.predictedCd + row.uncertainty,
    row.anchorCd,
    ...(row.publishedCd === null ? [] : [row.publishedCd]),
  ]);
  const low = Math.floor((Math.min(...extremes) - 0.01) / 0.05) * 0.05;
  const high = Math.ceil((Math.max(...extremes) + 0.01) / 0.05) * 0.05;
  const x = (cd: number) => plotLeft + ((cd - low) / (high - low)) * plotWidth;
  const hovered = active === null ? null : rows[active];

  return (
    <figure className="rounded-2xl border border-line bg-panel">
      <figcaption className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-line px-3 py-2">
        <span className="text-[13px] font-medium text-ink">{title}</span>
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <LegendKey label="Published">
            <circle cx="11" cy="6" r="4.5" fill={PUBLISHED} />
          </LegendKey>
          <LegendKey label="Predicted, ± 1σ stated by the model">
            <line x1="1" y1="6" x2="21" y2="6" stroke={PREDICTED} strokeWidth="2" strokeLinecap="round" />
            <circle cx="11" cy="6" r="4.5" fill={PREDICTED} stroke={SURFACE} strokeWidth="2" />
          </LegendKey>
          <LegendKey label="Class reference the prediction starts from">
            <line x1="11" y1="1" x2="11" y2="11" stroke={REFERENCE} strokeWidth="2" />
          </LegendKey>
        </span>
      </figcaption>
      <div ref={containerRef} className="relative px-1 py-1">
        {width > 0 && (
          <svg width={width} height={height} role="list" aria-label={`${title}. The same values are listed in the table below.`}>
            {ticks(low, high).map((tick) => (
              <g key={tick}>
                <line x1={x(tick)} y1={TOP} x2={x(tick)} y2={TOP + rows.length * ROW} stroke={GRID} strokeWidth="1" />
                <text x={x(tick)} y={TOP + rows.length * ROW + 14} textAnchor="middle" fontSize="10" fill="#808a97" className="num">
                  {tick.toFixed(2)}
                </text>
              </g>
            ))}
            <text x={plotLeft + plotWidth / 2} y={height - 4} textAnchor="middle" fontSize="10" fill="#aab2bd">
              Drag coefficient Cd (–)
            </text>
            {rows.map((row, index) => {
              const y = TOP + index * ROW + ROW / 2;
              const isActive = active === index;
              return (
                <g
                  key={row.id}
                  tabIndex={0}
                  role="listitem"
                  aria-label={
                    `${row.name}: predicted ${row.predictedCd.toFixed(3)} plus or minus ${row.uncertainty.toFixed(3)}, ` +
                    (row.publishedCd === null ? "no published figure" : `published ${row.publishedCd.toFixed(3)}`)
                  }
                  onPointerEnter={() => setActive(index)}
                  onPointerLeave={() => setActive((current) => (current === index ? null : current))}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive((current) => (current === index ? null : current))}
                  className="outline-none"
                >
                  <rect x={0} y={y - ROW / 2} width={width} height={ROW} fill={isActive ? "#1b1f26" : "transparent"} />
                  <text x={labelWidth} y={y + 3.5} textAnchor="end" fontSize="11" fill={isActive ? "#dfe4ea" : "#aab2bd"}>
                    {row.name.length > (labelWidth < 200 ? 20 : 40) ? `${row.name.slice(0, labelWidth < 200 ? 19 : 39)}…` : row.name}
                  </text>
                  {row.publishedCd !== null && (
                    <line x1={x(row.publishedCd)} y1={y} x2={x(row.predictedCd)} y2={y} stroke={CONNECTOR} strokeWidth="2" />
                  )}
                  <line
                    x1={x(row.predictedCd - row.uncertainty)}
                    y1={y}
                    x2={x(row.predictedCd + row.uncertainty)}
                    y2={y}
                    stroke={PREDICTED}
                    strokeOpacity="0.55"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <line x1={x(row.anchorCd)} y1={y - 6} x2={x(row.anchorCd)} y2={y + 6} stroke={REFERENCE} strokeWidth="2" />
                  {row.publishedCd !== null && <circle cx={x(row.publishedCd)} cy={y} r="4.5" fill={PUBLISHED} stroke={SURFACE} strokeWidth="2" />}
                  <circle cx={x(row.predictedCd)} cy={y} r="4.5" fill={PREDICTED} stroke={SURFACE} strokeWidth="2" />
                </g>
              );
            })}
          </svg>
        )}
        {hovered && active !== null && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 w-[236px] border border-line-strong bg-raise px-2.5 py-2 text-xs shadow-lg shadow-black/50"
            style={{
              top: Math.min(TOP + active * ROW + ROW + 2, Math.max(height - 108, 0)),
              left: Math.min(Math.max(x(hovered.predictedCd) - 118, 4), Math.max(width - 240, 4)),
            }}
          >
            <div className="mb-1 text-ink-2">{hovered.name}</div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="flex items-center gap-1.5 text-ink-3">
                <svg width="10" height="4" aria-hidden>
                  <line x1="0" y1="2" x2="10" y2="2" stroke={PUBLISHED} strokeWidth="2" />
                </svg>
                Published
              </dt>
              <dd className="num text-right font-semibold text-ink">{hovered.publishedCd === null ? "none found" : hovered.publishedCd.toFixed(3)}</dd>
              <dt className="flex items-center gap-1.5 text-ink-3">
                <svg width="10" height="4" aria-hidden>
                  <line x1="0" y1="2" x2="10" y2="2" stroke={PREDICTED} strokeWidth="2" />
                </svg>
                Predicted
              </dt>
              <dd className="num text-right font-semibold text-ink">
                {hovered.predictedCd.toFixed(3)} ± {hovered.uncertainty.toFixed(3)}
              </dd>
              {hovered.error !== null && (
                <>
                  <dt className="text-ink-3">Difference</dt>
                  <dd className="num text-right font-semibold text-ink">{formatSigned(hovered.error, 3)}</dd>
                </>
              )}
              <dt className="flex items-center gap-1.5 text-ink-3">
                <svg width="10" height="4" aria-hidden>
                  <line x1="0" y1="2" x2="10" y2="2" stroke={REFERENCE} strokeWidth="2" />
                </svg>
                {hovered.anchorClassName} class
              </dt>
              <dd className="num text-right text-ink">{hovered.anchorCd.toFixed(2)}</dd>
            </dl>
          </div>
        )}
      </div>
    </figure>
  );
}
