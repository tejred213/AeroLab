import { diffGeometry, PARAM_BY_ID } from "@/lib/geometry/parameters";
import type { Experiment } from "@/lib/state/experimentStore";
import type { GeometryParams, ParamId } from "@/lib/types";
import { formatSigned, formatWithUnit, quantityOfParam, type UnitSystem, unitOf } from "@/lib/utils/units";

/** Formats a geometry-parameter value in display units, with its unit. */
export function formatParam(system: UnitSystem, id: ParamId, value: number): string {
  const definition = PARAM_BY_ID[id];
  if (definition.kind === "ratio") return value.toFixed(2);
  return formatWithUnit(system, quantityOfParam(definition.kind), value);
}

/** e.g. "Ride height −20 mm" for each parameter that differs between two geometries. */
export function describeChanges(system: UnitSystem, base: GeometryParams, modified: GeometryParams): string[] {
  return diffGeometry(base, modified).map(({ id, from, to }) => {
    const definition = PARAM_BY_ID[id];
    if (definition.kind === "ratio") return `${definition.label} ${formatSigned(to - from, 2)}`;
    const unit = unitOf(system, quantityOfParam(definition.kind));
    return `${definition.label} ${formatSigned(unit.toDisplay(to) - unit.toDisplay(from), unit.decimals)} ${unit.label}`;
  });
}

/** One-line statement of the test conditions of an experiment. */
export function describeConditions(system: UnitSystem, experiment: Experiment): string {
  const { environment, speed } = experiment.config;
  const parts = [
    formatWithUnit(system, "speed", speed),
    formatWithUnit(system, "temperature", environment.temperature),
    environment.airDensityMode === "direct"
      ? `ρ ${environment.airDensity.toFixed(3)} kg/m³`
      : formatWithUnit("si", "pressure", environment.pressure),
  ];
  if (environment.windSpeed > 0.05) {
    parts.push(`wind ${formatWithUnit(system, "speed", environment.windSpeed)} @ ${environment.windAngle.toFixed(0)}°`);
  }
  if (Math.abs(environment.gradient) > 0.01) parts.push(`gradient ${environment.gradient.toFixed(1)}°`);
  return parts.join(" · ");
}
