"use client";

import { type CSSProperties, memo, type ReactNode } from "react";
import { NumberInput } from "@/components/ui/Field";
import { InfoTip } from "@/components/ui/Tooltip";
import { LENGTH_RANGE, overallLength, PARAM_BY_ID } from "@/lib/geometry/parameters";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { currentVehicle, useSimStore } from "@/lib/state/simStore";
import type { ParamBasis, ParamId } from "@/lib/types";
import { type Quantity, quantityOfParam, unitOf } from "@/lib/utils/units";

interface SliderRowProps {
  label: string;
  tooltip: ReactNode;
  quantity: Quantity;
  /** SI values. */
  value: number;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  onChange: (si: number) => void;
  onReset: () => void;
  decimals?: number;
}

/**
 * One adjustable quantity: slider + numeric input + unit + reset + tooltip.
 * Values are held in SI and converted only for display.
 */
export function SliderRow({ label, tooltip, quantity, value, min, max, step, defaultValue, onChange, onReset, decimals }: SliderRowProps) {
  const system = useSettingsStore((state) => state.unitSystem);
  const unit = unitOf(system, quantity);
  const places = decimals ?? unit.decimals;
  const displayStep = Math.abs(unit.toDisplay(step) - unit.toDisplay(0));
  const modified = Math.abs(value - defaultValue) > step * 1e-3;

  return (
    <div className="py-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`flex min-w-0 flex-1 items-center gap-1.5 text-[13px] ${modified ? "font-medium text-ink" : "text-ink-2"}`}>
          <span className="truncate">{label}</span>
          {modified && <span title="Modified from the vehicle default" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </span>
        <InfoTip content={tooltip} label={label} />
        <div className="w-[68px] shrink-0">
          <NumberInput
            ariaLabel={`${label} (${unit.label || "ratio"})`}
            value={unit.toDisplay(value)}
            decimals={places}
            min={unit.toDisplay(min)}
            max={unit.toDisplay(max)}
            step={displayStep}
            onCommit={(display) => onChange(unit.fromDisplay(display))}
          />
        </div>
        <span className="w-7 shrink-0 text-[11px] text-ink-3">{unit.label}</span>
        <button
          type="button"
          aria-label={`Reset ${label} to the vehicle default`}
          title="Reset to vehicle default"
          disabled={!modified}
          onClick={onReset}
          className="flex h-6 w-6 shrink-0 items-center justify-center text-ink-3 transition-colors enabled:hover:bg-raise enabled:hover:text-accent disabled:opacity-25"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2.2 6a3.8 3.8 0 1 0 1.2-2.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            <path d="M1.6 1.6v2.2h2.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <input
        type="range"
        aria-label={label}
        className="mt-1 block w-full"
        style={{ "--fill": `${max > min ? Math.min(Math.max((value - min) / (max - min), 0), 1) * 100 : 0}%` } as CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

/** Where a production-car look-alike's default value of a parameter comes from. */
export const BASIS_LABELS: Record<ParamBasis, string> = {
  published: "a published dimension",
  derived: "computed from published figures",
  estimated: "an estimate from the car's proportions or features, not a published value",
  class: "the generic class value, not specific to this car",
  measured: "measured from the imported 3D model",
};

/** Slider row bound to one geometry parameter of the current session. */
export const ParamControl = memo(function ParamControl({ id }: { id: ParamId }) {
  const definition = PARAM_BY_ID[id];
  const value = useSimStore((state) => state.geometry[id]);
  const defaultValue = useSimStore((state) => currentVehicle(state).geometry[id]);
  const basis = useSimStore((state) => currentVehicle(state).realCar?.basis[id]);
  const setParam = useSimStore((state) => state.setParam);
  const resetParam = useSimStore((state) => state.resetParam);
  return (
    <SliderRow
      label={definition.label}
      tooltip={
        basis ? (
          <>
            {definition.tooltip}
            <span className="mt-1.5 block border-t border-line-strong pt-1.5 text-ink-2">
              Default for this car: {BASIS_LABELS[basis]}.
            </span>
          </>
        ) : (
          definition.tooltip
        )
      }
      quantity={quantityOfParam(definition.kind)}
      value={value}
      min={definition.min}
      max={definition.max}
      step={definition.step}
      defaultValue={defaultValue}
      onChange={(si) => setParam(id, si)}
      onReset={() => resetParam(id)}
      decimals={definition.kind === "ratio" ? 2 : undefined}
    />
  );
});

/** Overall length: a linked control that stretches the wheelbase and keeps the overhangs. */
export function OverallLengthControl() {
  const length = useSimStore((state) => overallLength(state.geometry));
  const defaultLength = useSimStore((state) => overallLength(currentVehicle(state).geometry));
  const setOverallLength = useSimStore((state) => state.setOverallLength);
  return (
    <SliderRow
      label="Overall length"
      tooltip="Front overhang + wheelbase + rear overhang. Editing it stretches the wheelbase and keeps both overhangs. A longer body has more wetted area but gentler pressure gradients."
      quantity="length"
      value={length}
      min={LENGTH_RANGE.min}
      max={LENGTH_RANGE.max}
      step={0.01}
      defaultValue={defaultLength}
      onChange={setOverallLength}
      onReset={() => setOverallLength(defaultLength)}
    />
  );
}

/** Overall height: a linked control that changes the roof height and keeps the ride height. */
export function OverallHeightControl() {
  const height = useSimStore((state) => state.geometry.rideHeight + state.geometry.roofHeight);
  const rideHeight = useSimStore((state) => state.geometry.rideHeight);
  const defaultHeight = useSimStore((state) => {
    const geometry = currentVehicle(state).geometry;
    return geometry.rideHeight + geometry.roofHeight;
  });
  const setOverallHeight = useSimStore((state) => state.setOverallHeight);
  const roof = PARAM_BY_ID.roofHeight;
  return (
    <SliderRow
      label="Overall height"
      tooltip="Ride height + roof height (excluding spoiler and wing). Editing it changes the roof height and keeps the ride height. Height drives frontal area and the size of the wake."
      quantity="length"
      value={height}
      min={rideHeight + roof.min}
      max={rideHeight + roof.max}
      step={0.005}
      defaultValue={defaultHeight}
      onChange={setOverallHeight}
      onReset={() => setOverallHeight(defaultHeight)}
    />
  );
}
