/** Helpers for putting several curves on one chart. */

export interface SeriesPoints {
  key: string;
  /** Sorted by increasing x. */
  points: { x: number; y: number }[];
}

export type SeriesRow = Record<string, number | null>;

/**
 * Resamples curves that were sampled at different x values onto one shared,
 * evenly spaced x grid, so they can be drawn and read off together.
 *
 * Values are linearly interpolated between a curve's own samples. Outside the
 * range a curve actually covers its value is null: nothing is extrapolated.
 */
export function resampleSeries(seriesList: SeriesPoints[], samples = 160): SeriesRow[] {
  const usable = seriesList.filter((series) => series.points.length >= 2);
  if (usable.length === 0 || samples < 2) return [];
  const xMin = Math.min(...usable.map((series) => series.points[0].x));
  const xMax = Math.max(...usable.map((series) => series.points[series.points.length - 1].x));
  if (!(xMax > xMin)) return [];

  const tolerance = (xMax - xMin) * 1e-9;
  const cursors = usable.map(() => 0);
  const rows: SeriesRow[] = [];
  for (let i = 0; i < samples; i++) {
    const x = i === samples - 1 ? xMax : xMin + ((xMax - xMin) * i) / (samples - 1);
    const row: SeriesRow = { x };
    usable.forEach((series, index) => {
      const { points } = series;
      if (x < points[0].x - tolerance || x > points[points.length - 1].x + tolerance) {
        row[series.key] = null;
        return;
      }
      let cursor = cursors[index];
      while (cursor < points.length - 2 && points[cursor + 1].x < x) cursor++;
      cursors[index] = cursor;
      const from = points[cursor];
      const to = points[cursor + 1];
      const span = to.x - from.x;
      const t = span > 0 ? Math.min(Math.max((x - from.x) / span, 0), 1) : 0;
      row[series.key] = from.y + (to.y - from.y) * t;
    });
    rows.push(row);
  }
  return rows;
}
