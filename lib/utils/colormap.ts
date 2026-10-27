/**
 * Colour scales for the physics visualisations. Every use is paired with a
 * numeric legend; colour is never the only carrier of a value.
 */

type Rgb = [number, number, number];

const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16) / 255,
  parseInt(value.slice(3, 5), 16) / 255,
  parseInt(value.slice(5, 7), 16) / 255,
];

/** blue -> cyan -> green -> yellow -> red */
const STOPS: Rgb[] = ["#2b5fd9", "#29c4e0", "#4ed06a", "#f2d53c", "#e8452c"].map(hex);

export const SCALE_CSS_GRADIENT = "linear-gradient(to right, #2b5fd9, #29c4e0, #4ed06a, #f2d53c, #e8452c)";

function interpolate(stops: Rgb[], t: number, out: Float32Array | number[], offset: number): void {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const f = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  out[offset] = a[0] + (b[0] - a[0]) * f;
  out[offset + 1] = a[1] + (b[1] - a[1]) * f;
  out[offset + 2] = a[2] + (b[2] - a[2]) * f;
}

/** Writes the colour for t in [0, 1] into out[offset..offset+2] (components 0..1). */
export function scaleColor(t: number, out: Float32Array | number[], offset = 0): void {
  interpolate(STOPS, t, out, offset);
}

/** One hue, pale to deep, for flow drawn on a white backdrop (the landing page): pale = slow, deep = fast. */
const INK_STOPS: Rgb[] = ["#b9c8e0", "#5a8be0", "#2456c4", "#0b1a45"].map(hex);

/** As scaleColor, on the single-hue scale for a white backdrop. */
export function inkColor(t: number, out: Float32Array | number[], offset = 0): void {
  interpolate(INK_STOPS, t, out, offset);
}

/** Speed-ratio range shown by the velocity scale (V / V_inf). */
export const VELOCITY_RANGE: [number, number] = [0, 1.6];

export function velocityT(speedRatio: number): number {
  return (speedRatio - VELOCITY_RANGE[0]) / (VELOCITY_RANGE[1] - VELOCITY_RANGE[0]);
}

/** Pressure-coefficient range shown by the pressure scale. Cp = 0 maps to the middle (green). */
export const PRESSURE_RANGE: [number, number] = [-1.2, 1.0];

export function pressureT(cp: number): number {
  return cp < 0 ? 0.5 * (1 - cp / PRESSURE_RANGE[0]) : 0.5 + (0.5 * cp) / PRESSURE_RANGE[1];
}

/** Sequential scale for heatmaps of arbitrary metrics: t in [0, 1]. */
export function scaleCss(t: number): string {
  const rgb: number[] = [0, 0, 0];
  scaleColor(t, rgb);
  return `rgb(${Math.round(rgb[0] * 255)} ${Math.round(rgb[1] * 255)} ${Math.round(rgb[2] * 255)})`;
}

/** Categorical series colours for charts (distinguishable on the dark background). */
export const SERIES_COLORS = ["#5cc8f0", "#f2a33a", "#58c88a", "#c58af9", "#ef6060", "#e6d25a", "#7f9cf5", "#f58ab8"];
