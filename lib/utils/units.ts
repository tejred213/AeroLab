/**
 * Display units. All calculations and stored values are SI; conversion happens
 * only at the UI boundary through these definitions.
 */
import type { ParamKind } from "@/lib/types";

export type UnitSystem = "si" | "automotive";

export type Quantity =
  | "length"
  | "distance"
  | "area"
  | "speed"
  | "acceleration"
  | "force"
  | "pressure"
  | "power"
  | "torque"
  | "energy"
  | "mass"
  | "density"
  | "temperature"
  | "angle"
  | "ratio"
  | "time"
  | "rpm"
  | "moment";

export interface UnitDefinition {
  label: string;
  /** SI value -> display value */
  toDisplay: (si: number) => number;
  /** display value -> SI value */
  fromDisplay: (display: number) => number;
  decimals: number;
}

const linear = (label: string, factor: number, decimals: number): UnitDefinition => ({
  label,
  toDisplay: (si) => si * factor,
  fromDisplay: (display) => display / factor,
  decimals,
});

const METRIC_HORSEPOWER = 735.49875;

const SI_UNITS: Record<Quantity, UnitDefinition> = {
  length: linear("m", 1, 3),
  distance: linear("m", 1, 0),
  area: linear("m²", 1, 3),
  speed: linear("m/s", 1, 1),
  acceleration: linear("m/s²", 1, 2),
  force: linear("N", 1, 0),
  pressure: linear("Pa", 1, 0),
  power: linear("kW", 1e-3, 1),
  torque: linear("N·m", 1, 0),
  energy: linear("MJ", 1e-6, 0),
  mass: linear("kg", 1, 0),
  density: linear("kg/m³", 1, 3),
  temperature: linear("K", 1, 1),
  angle: linear("°", 1, 1),
  ratio: linear("", 1, 2),
  time: linear("s", 1, 2),
  rpm: linear("rpm", 1, 0),
  moment: linear("N·m", 1, 0),
};

const AUTOMOTIVE_UNITS: Record<Quantity, UnitDefinition> = {
  ...SI_UNITS,
  length: linear("mm", 1000, 0),
  distance: linear("km", 1e-3, 0),
  speed: linear("km/h", 3.6, 0),
  pressure: linear("bar", 1e-5, 4),
  power: linear("hp", 1 / METRIC_HORSEPOWER, 0),
  energy: linear("kWh", 1 / 3.6e6, 1),
  temperature: {
    label: "°C",
    toDisplay: (si) => si - 273.15,
    fromDisplay: (display) => display + 273.15,
    decimals: 1,
  },
};

export function unitOf(system: UnitSystem, quantity: Quantity): UnitDefinition {
  return system === "si" ? SI_UNITS[quantity] : AUTOMOTIVE_UNITS[quantity];
}

export function quantityOfParam(kind: ParamKind): Quantity {
  if (kind === "length") return "length";
  if (kind === "angle") return "angle";
  return "ratio";
}

/** Formats an SI value in the display unit, without the unit label. */
export function formatValue(system: UnitSystem, quantity: Quantity, si: number | null | undefined, decimals?: number): string {
  if (si === null || si === undefined || !Number.isFinite(si)) return "—";
  const unit = unitOf(system, quantity);
  return unit.toDisplay(si).toFixed(decimals ?? unit.decimals);
}

/** Formats an SI value with its display unit label. */
export function formatWithUnit(system: UnitSystem, quantity: Quantity, si: number | null | undefined, decimals?: number): string {
  const text = formatValue(system, quantity, si, decimals);
  const { label } = unitOf(system, quantity);
  return label && text !== "—" ? `${text} ${label}` : text;
}

/** Fixed-decimals number formatting for dimensionless values (coefficients). */
export function formatNumber(value: number | null | undefined, decimals = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(decimals);
}

/** Signed formatting for differences, e.g. "+0.012" / "−0.012". */
export function formatSigned(value: number | null | undefined, decimals = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(decimals));
  if (rounded === 0) return (0).toFixed(decimals);
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(decimals)}`;
}
