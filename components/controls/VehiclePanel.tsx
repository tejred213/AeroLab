"use client";

import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Checkbox, FieldRow, NumberInput, Select } from "@/components/ui/Field";
import { Section } from "@/components/ui/Layout";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import type { Drivetrain, EvPowertrain, IcePowertrain, PowerCurvePoint } from "@/lib/types";
import { type Quantity, unitOf } from "@/lib/utils/units";
import { getBuiltInVehicle } from "@/lib/vehicle/library";
import { powertrainCurve } from "@/lib/vehicle/powertrain";

interface QuantityFieldProps {
  label: string;
  quantity: Quantity;
  value: number;
  onChange: (si: number) => void;
  min: number;
  max: number;
  decimals?: number;
  tooltip?: ReactNode;
  /** Unit label override for dimensionless values. */
  unitLabel?: string;
}

/** Numeric field for an SI quantity, displayed in the active unit system. */
export function QuantityField({ label, quantity, value, onChange, min, max, decimals, tooltip, unitLabel }: QuantityFieldProps) {
  const system = useSettingsStore((state) => state.unitSystem);
  const unit = unitOf(system, quantity);
  const lo = unit.toDisplay(min);
  const hi = unit.toDisplay(max);
  return (
    <FieldRow label={label} unit={unitLabel ?? unit.label} tooltip={tooltip}>
      <NumberInput
        ariaLabel={`${label} (${unitLabel ?? unit.label})`}
        value={unit.toDisplay(value)}
        decimals={decimals ?? unit.decimals}
        min={Math.min(lo, hi)}
        max={Math.max(lo, hi)}
        onCommit={(display) => onChange(unit.fromDisplay(display))}
      />
    </FieldRow>
  );
}

/** Compact plot of the engine / motor power and torque curves. */
function PowertrainCurvePlot() {
  const powertrain = useSimStore((state) => state.powertrain);
  const system = useSettingsStore((state) => state.unitSystem);
  const curve = useMemo(() => powertrainCurve(powertrain, 48), [powertrain]);
  const width = 264;
  const height = 96;
  const pad = { left: 4, right: 4, top: 6, bottom: 14 };
  const maxRpm = curve[curve.length - 1].rpm;
  const maxPower = Math.max(...curve.map((point) => point.powerW));
  const maxTorque = Math.max(...curve.map((point) => point.torqueNm));
  const x = (rpm: number) => pad.left + ((width - pad.left - pad.right) * rpm) / maxRpm;
  const y = (fraction: number) => height - pad.bottom - (height - pad.top - pad.bottom) * fraction;
  const path = (values: number[], max: number) =>
    values.map((value, i) => `${i === 0 ? "M" : "L"}${x(curve[i].rpm).toFixed(1)},${y(value / max).toFixed(1)}`).join(" ");
  const power = unitOf(system, "power");
  return (
    <figure className="mt-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full rounded-lg border border-line bg-bg"
        role="img"
        aria-label="Power and torque versus shaft speed"
      >
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="var(--color-line-strong)" />
        <path d={path(curve.map((point) => point.torqueNm), maxTorque)} fill="none" stroke="var(--color-data)" strokeWidth="1.3" strokeDasharray="4 3" />
        <path d={path(curve.map((point) => point.powerW), maxPower)} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
        <text x={pad.left} y={height - 3} className="num" fontSize="8" fill="var(--color-ink-3)">
          0
        </text>
        <text x={width - pad.right} y={height - 3} textAnchor="end" className="num" fontSize="8" fill="var(--color-ink-3)">
          {Math.round(maxRpm)} rpm
        </text>
      </svg>
      <figcaption className="num mt-1 flex justify-between text-[11px] text-ink-3">
        <span className="text-accent">
          ━ power, peak {power.toDisplay(maxPower).toFixed(0)} {power.label}
        </span>
        <span className="text-data">╌ torque, peak {maxTorque.toFixed(0)} N·m</span>
      </figcaption>
    </figure>
  );
}

function PowerCurveEditor({ powertrain, onChange }: { powertrain: IcePowertrain; onChange: (next: IcePowertrain) => void }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const power = unitOf(system, "power");
  const enabled = powertrain.powerCurve !== null;
  const points = powertrain.powerCurve ?? [];

  const seedCurve = (): PowerCurvePoint[] =>
    powertrainCurve({ ...powertrain, powerCurve: null }, 6).map((point) => ({
      rpm: Math.round(point.rpm / 50) * 50,
      powerW: Math.round(point.powerW / 100) * 100,
    }));

  const update = (index: number, change: Partial<PowerCurvePoint>) =>
    onChange({ ...powertrain, powerCurve: points.map((point, i) => (i === index ? { ...point, ...change } : point)) });

  return (
    <div className="mt-1">
      <Checkbox
        checked={enabled}
        label="User-defined power curve"
        onChange={(checked) => onChange({ ...powertrain, powerCurve: checked ? seedCurve() : null })}
      />
      {enabled && (
        <div className="mt-1">
          <div className="label grid grid-cols-[1fr_1fr_20px] gap-1 pb-0.5">
            <span>Engine speed · rpm</span>
            <span>Power · {power.label}</span>
            <span />
          </div>
          {points.map((point, index) => (
            <div key={index} className="grid grid-cols-[1fr_1fr_20px] items-center gap-1 py-px">
              <NumberInput
                ariaLabel={`Curve point ${index + 1} engine speed (rpm)`}
                value={point.rpm}
                decimals={0}
                min={0}
                max={25000}
                step={100}
                onCommit={(rpm) => update(index, { rpm })}
              />
              <NumberInput
                ariaLabel={`Curve point ${index + 1} power (${power.label})`}
                value={power.toDisplay(point.powerW)}
                decimals={power.decimals}
                min={0}
                max={power.toDisplay(2e6)}
                onCommit={(display) => update(index, { powerW: power.fromDisplay(display) })}
              />
              <button
                type="button"
                aria-label={`Remove curve point ${index + 1}`}
                disabled={points.length <= 2}
                onClick={() => onChange({ ...powertrain, powerCurve: points.filter((_, i) => i !== index) })}
                className="h-6 w-6 text-ink-3 enabled:hover:text-err disabled:opacity-30"
              >
                ×
              </button>
            </div>
          ))}
          <Button
            size="sm"
            className="mt-1"
            onClick={() => {
              const last = points[points.length - 1];
              onChange({ ...powertrain, powerCurve: [...points, { rpm: last.rpm + 500, powerW: last.powerW }] });
            }}
          >
            Add point
          </Button>
          <p className="mt-1 text-xs leading-normal text-ink-3">
            Power is interpolated linearly between points (sorted by engine speed) and replaces the simplified curve.
          </p>
        </div>
      )}
    </div>
  );
}

function IceFields({ powertrain }: { powertrain: IcePowertrain }) {
  const setPowertrain = useSimStore((state) => state.setPowertrain);
  const set = (changes: Partial<IcePowertrain>) => setPowertrain({ ...powertrain, ...changes });
  const [ratioText, setRatioText] = useState<string | null>(null);

  const commitRatios = (text: string) => {
    const ratios = text
      .split(/[\s,;]+/)
      .map(Number)
      .filter((ratio) => Number.isFinite(ratio) && ratio > 0.2 && ratio < 8);
    if (ratios.length >= 1 && ratios.length <= 10) set({ gearRatios: ratios });
    setRatioText(null);
  };

  return (
    <>
      <QuantityField label="Peak power" quantity="power" value={powertrain.peakPowerW} min={20000} max={1200000} onChange={(peakPowerW) => set({ peakPowerW })} />
      <QuantityField label="…at engine speed" quantity="rpm" value={powertrain.peakPowerRpm} min={2000} max={12000} onChange={(peakPowerRpm) => set({ peakPowerRpm })} />
      <QuantityField label="Peak torque" quantity="torque" value={powertrain.peakTorqueNm} min={50} max={2000} onChange={(peakTorqueNm) => set({ peakTorqueNm })} />
      <QuantityField label="…at engine speed" quantity="rpm" value={powertrain.peakTorqueRpm} min={1000} max={10000} onChange={(peakTorqueRpm) => set({ peakTorqueRpm })} />
      <QuantityField label="Idle speed" quantity="rpm" value={powertrain.idleRpm} min={500} max={2000} onChange={(idleRpm) => set({ idleRpm })} />
      <QuantityField label="Redline" quantity="rpm" value={powertrain.redlineRpm} min={3000} max={14000} onChange={(redlineRpm) => set({ redlineRpm })} />
      <QuantityField label="Final drive ratio" quantity="ratio" unitLabel=": 1" value={powertrain.finalDrive} min={1.5} max={7} decimals={2} onChange={(finalDrive) => set({ finalDrive })} />
      <QuantityField
        label="Drivetrain efficiency"
        quantity="ratio"
        unitLabel="–"
        value={powertrain.drivetrainEfficiency}
        min={0.6}
        max={1}
        decimals={2}
        tooltip="Fraction of engine power that reaches the tyre contact patches."
        onChange={(drivetrainEfficiency) => set({ drivetrainEfficiency })}
      />
      <QuantityField label="Shift time" quantity="time" value={powertrain.shiftTime} min={0} max={1.5} onChange={(shiftTime) => set({ shiftTime })} tooltip="Time without drive force during each gear change." />
      <label className="mt-1 block">
        <span className="text-[13px] text-ink-2">Gear ratios (comma separated)</span>
        <input
          type="text"
          aria-label="Gear ratios, comma separated"
          className="num mt-0.5 h-7 w-full border border-line bg-bg px-1.5 text-[13px] text-ink hover:border-line-strong focus:border-data"
          value={ratioText ?? powertrain.gearRatios.join(", ")}
          onChange={(event) => setRatioText(event.target.value)}
          onBlur={(event) => commitRatios(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            event.stopPropagation();
          }}
        />
      </label>
      <PowerCurveEditor powertrain={powertrain} onChange={setPowertrain} />
    </>
  );
}

function EvFields({ powertrain }: { powertrain: EvPowertrain }) {
  const setPowertrain = useSimStore((state) => state.setPowertrain);
  const set = (changes: Partial<EvPowertrain>) => setPowertrain({ ...powertrain, ...changes });
  return (
    <>
      <QuantityField label="Peak motor power" quantity="power" value={powertrain.peakPowerW} min={20000} max={1500000} onChange={(peakPowerW) => set({ peakPowerW })} />
      <QuantityField label="Peak torque" quantity="torque" value={powertrain.peakTorqueNm} min={50} max={3000} onChange={(peakTorqueNm) => set({ peakTorqueNm })} />
      <QuantityField label="Maximum motor speed" quantity="rpm" value={powertrain.maxMotorRpm} min={4000} max={25000} onChange={(maxMotorRpm) => set({ maxMotorRpm })} />
      <QuantityField label="Reduction ratio" quantity="ratio" unitLabel=": 1" value={powertrain.gearRatio} min={3} max={16} decimals={2} onChange={(gearRatio) => set({ gearRatio })} />
      <QuantityField label="Drivetrain efficiency" quantity="ratio" unitLabel="–" value={powertrain.drivetrainEfficiency} min={0.6} max={1} decimals={2} onChange={(drivetrainEfficiency) => set({ drivetrainEfficiency })} />
      <QuantityField
        label="Battery capacity"
        quantity="energy"
        value={powertrain.batteryCapacityJ}
        min={3.6e7}
        max={7.2e8}
        tooltip="Usable energy. Used only for the steady-speed range estimate."
        onChange={(batteryCapacityJ) => set({ batteryCapacityJ })}
      />
    </>
  );
}

export function VehiclePanel() {
  const spec = useSimStore((state) => state.spec);
  const setSpec = useSimStore((state) => state.setSpec);
  const powertrain = useSimStore((state) => state.powertrain);
  const setPowertrain = useSimStore((state) => state.setPowertrain);
  const resetPowertrain = useSimStore((state) => state.resetPowertrain);

  const switchType = (type: "ICE" | "EV") => {
    if (type === powertrain.type) return;
    // Start from a representative template of the other kind.
    setPowertrain(structuredClone(getBuiltInVehicle(type === "EV" ? "generic-ev" : "sedan").powertrain));
  };

  return (
    <div>
      <Section
        title="Chassis"
        actions={
          <Button size="sm" variant="ghost" onClick={resetPowertrain} title="Reset chassis and powertrain to the vehicle defaults">
            Reset
          </Button>
        }
      >
        <QuantityField label="Mass" quantity="mass" value={spec.mass} min={500} max={4000} onChange={(mass) => setSpec({ mass })} />
        <QuantityField label="CG height" quantity="length" value={spec.cgHeight} min={0.25} max={1.1} onChange={(cgHeight) => setSpec({ cgHeight })} tooltip="Height of the centre of gravity. Sets how much load transfers to the rear axle under acceleration." />
        <QuantityField
          label="Front weight share"
          quantity="ratio"
          unitLabel="–"
          value={spec.weightDistFront}
          min={0.3}
          max={0.7}
          decimals={2}
          tooltip="Static fraction of the weight carried by the front axle."
          onChange={(weightDistFront) => setSpec({ weightDistFront })}
        />
        <FieldRow label="Driven wheels">
          <Select<Drivetrain>
            ariaLabel="Driven wheels"
            value={spec.drivetrain}
            className="w-full"
            options={[
              { value: "FWD", label: "Front" },
              { value: "RWD", label: "Rear" },
              { value: "AWD", label: "All" },
            ]}
            onChange={(drivetrain) => setSpec({ drivetrain })}
          />
        </FieldRow>
        <QuantityField
          label="Rolling resistance Crr"
          quantity="ratio"
          unitLabel="–"
          value={spec.crr}
          min={0.004}
          max={0.03}
          decimals={4}
          tooltip="Rolling resistance coefficient: F_rr = C_rr × tyre normal load. Typical road tyres: 0.007 to 0.013."
          onChange={(crr) => setSpec({ crr })}
        />
        <QuantityField
          label="Tyre friction μ"
          quantity="ratio"
          unitLabel="–"
          value={spec.tireMu}
          min={0.3}
          max={1.6}
          decimals={2}
          tooltip="Peak tyre-road friction coefficient. Caps the drive force the driven wheels can transmit."
          onChange={(tireMu) => setSpec({ tireMu })}
        />
      </Section>
      <Section title="Powertrain">
        <FieldRow label="Type">
          <Select
            ariaLabel="Powertrain type"
            value={powertrain.type}
            className="w-full"
            options={[
              { value: "ICE", label: "ICE" },
              { value: "EV", label: "Electric" },
            ]}
            onChange={switchType}
          />
        </FieldRow>
        {powertrain.type === "ICE" ? <IceFields powertrain={powertrain} /> : <EvFields powertrain={powertrain} />}
        <PowertrainCurvePlot />
      </Section>
    </div>
  );
}
