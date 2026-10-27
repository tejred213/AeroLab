/** Static, print-friendly line chart (light theme, pure SVG) used by the engineering report. */

interface ReportSeries {
  label: string;
  points: { x: number; y: number }[];
  dashed?: boolean;
}

interface ReportChartProps {
  title: string;
  xLabel: string;
  yLabel: string;
  series: ReportSeries[];
}

const COLORS = ["#1f5fbf", "#c2410c", "#15803d", "#7e22ce", "#b91c1c"];
const WIDTH = 360;
const HEIGHT = 210;
const PAD = { left: 48, right: 10, top: 10, bottom: 34 };

/** Round tick values covering [min, max]. */
function niceTicks(min: number, max: number, target = 5): number[] {
  if (!(max > min)) return [min];
  const rough = (max - min) / target;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rough) ?? rough;
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

function formatTick(value: number, span: number): string {
  if (span >= 50) return value.toFixed(0);
  if (span >= 5) return value.toFixed(1).replace(/\.0$/, "");
  if (span >= 0.5) return value.toFixed(2);
  return value.toFixed(3);
}

export function ReportChart({ title, xLabel, yLabel, series }: ReportChartProps) {
  const all = series.flatMap((entry) => entry.points).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (all.length < 2) return null;
  const xMin = Math.min(...all.map((point) => point.x));
  const xMax = Math.max(...all.map((point) => point.x));
  let yMin = Math.min(...all.map((point) => point.y));
  let yMax = Math.max(...all.map((point) => point.y));
  if (yMax - yMin < 1e-9) {
    yMin -= 1;
    yMax += 1;
  }
  const margin = 0.06 * (yMax - yMin);
  yMin -= margin;
  yMax += margin;

  const sx = (x: number) => PAD.left + ((WIDTH - PAD.left - PAD.right) * (x - xMin)) / (xMax - xMin || 1);
  const sy = (y: number) => HEIGHT - PAD.bottom - ((HEIGHT - PAD.top - PAD.bottom) * (y - yMin)) / (yMax - yMin);
  const xTicks = niceTicks(xMin, xMax);
  const yTicks = niceTicks(yMin, yMax);

  return (
    <figure className="print-avoid-break">
      <figcaption className="mb-1 text-[11px] font-semibold text-neutral-800">{title}</figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={`${title}: ${yLabel} versus ${xLabel}`}>
        <rect x={PAD.left} y={PAD.top} width={WIDTH - PAD.left - PAD.right} height={HEIGHT - PAD.top - PAD.bottom} fill="none" stroke="#9ca3af" strokeWidth="0.8" />
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={sy(tick)} y2={sy(tick)} stroke="#e5e7eb" strokeWidth="0.6" />
            <text x={PAD.left - 4} y={sy(tick) + 3} textAnchor="end" fontSize="8" fill="#374151" fontFamily="ui-monospace, Menlo, monospace">
              {formatTick(tick, yMax - yMin)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x${tick}`}>
            <line x1={sx(tick)} x2={sx(tick)} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke="#e5e7eb" strokeWidth="0.6" />
            <text x={sx(tick)} y={HEIGHT - PAD.bottom + 10} textAnchor="middle" fontSize="8" fill="#374151" fontFamily="ui-monospace, Menlo, monospace">
              {formatTick(tick, xMax - xMin)}
            </text>
          </g>
        ))}
        {series.map((entry, index) => (
          <polyline
            key={entry.label}
            fill="none"
            stroke={COLORS[index % COLORS.length]}
            strokeWidth="1.4"
            strokeDasharray={entry.dashed ? "5 3" : undefined}
            points={entry.points
              .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
              .map((point) => `${sx(point.x).toFixed(1)},${sy(point.y).toFixed(1)}`)
              .join(" ")}
          />
        ))}
        <text x={(PAD.left + WIDTH - PAD.right) / 2} y={HEIGHT - 6} textAnchor="middle" fontSize="9" fill="#111827">
          {xLabel}
        </text>
        <text transform={`translate(11 ${(PAD.top + HEIGHT - PAD.bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize="9" fill="#111827">
          {yLabel}
        </text>
      </svg>
      {series.length > 1 && (
        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[9px] text-neutral-700">
          {series.map((entry, index) => (
            <span key={entry.label} className="flex items-center gap-1">
              <svg width="18" height="6" aria-hidden>
                <line x1="0" y1="3" x2="18" y2="3" stroke={COLORS[index % COLORS.length]} strokeWidth="1.6" strokeDasharray={entry.dashed ? "5 3" : undefined} />
              </svg>
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}
