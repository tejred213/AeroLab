"use client";

import { SliderRow } from "@/components/controls/ParamControl";
import { QuantityField } from "@/components/controls/VehiclePanel";
import { FieldRow, Select } from "@/components/ui/Field";
import { Section } from "@/components/ui/Layout";
import { InfoTip } from "@/components/ui/Tooltip";
import { resolveAir, STANDARD_ENVIRONMENT } from "@/lib/physics/atmosphere";
import { dynamicPressure } from "@/lib/physics/forces";
import { relativeWind } from "@/lib/physics/wind";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import { GLOSSARY } from "@/lib/utils/glossary";
import { formatWithUnit } from "@/lib/utils/units";
import { gradientPercent } from "@/lib/vehicle/performance";

/** Top view of the car with the ambient wind and the resulting relative wind. */
export function WindDiagram({ windSpeed, windAngle, speed }: { windSpeed: number; windAngle: number; speed: number }) {
  const wind = relativeWind(speed, windSpeed, windAngle);
  const yaw = (wind.yawAngleDeg * Math.PI) / 180;
  // Flow travels in +X (to the right); +Y is drawn downward.
  const arrow = (angle: number, length: number, color: string, dashed = false) => {
    const tipX = 78;
    const tipY = 50;
    const tailX = tipX - length * Math.cos(angle);
    const tailY = tipY - length * Math.sin(angle);
    return (
      <g stroke={color} fill={color} strokeWidth="1.5">
        <line x1={tailX} y1={tailY} x2={tipX} y2={tipY} strokeDasharray={dashed ? "4 3" : undefined} />
        <polygon
          stroke="none"
          points={`${tipX},${tipY} ${tipX - 8 * Math.cos(angle - 0.35)},${tipY - 8 * Math.sin(angle - 0.35)} ${tipX - 8 * Math.cos(angle + 0.35)},${tipY - 8 * Math.sin(angle + 0.35)}`}
        />
      </g>
    );
  };
  return (
    <svg viewBox="0 0 200 100" className="w-full rounded-lg border border-line bg-bg" role="img" aria-label={`Relative wind yaw angle ${wind.yawAngleDeg.toFixed(1)} degrees`}>
      <rect x="84" y="36" width="72" height="28" rx="9" fill="none" stroke="var(--color-ink-2)" strokeWidth="1.2" />
      <path d="M100 38 L100 62 M138 38 L138 62" stroke="var(--color-ink-3)" strokeWidth="1" />
      <text x="120" y="53" textAnchor="middle" fontSize="8" fill="var(--color-ink-3)">
        front ◂ car
      </text>
      {arrow(yaw, 62, "var(--color-data)")}
      {windSpeed > 0.05 && arrow((windAngle * Math.PI) / 180, 14 + 30 * Math.min(windSpeed / 30, 1), "var(--color-accent)", true)}
      <text x="4" y="11" fontSize="8" fill="var(--color-data)">
        ━ relative wind
      </text>
      <text x="4" y="22" fontSize="8" fill="var(--color-accent)">
        ╌ ambient wind
      </text>
    </svg>
  );
}

export function EnvironmentPanel() {
  const environment = useSimStore((state) => state.environment);
  const setEnvironment = useSimStore((state) => state.setEnvironment);
  const speed = useSimStore((state) => state.speed);
  const setSpeed = useSimStore((state) => state.setSpeed);
  const system = useSettingsStore((state) => state.unitSystem);

  const air = resolveAir(environment);
  const wind = relativeWind(speed, environment.windSpeed, environment.windAngle);
  const readout = (label: string, value: string, tip?: string) => (
    <div className="flex items-center justify-between gap-2 py-px">
      <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
        {label}
        {tip && <InfoTip content={tip} label={label} />}
      </span>
      <span className="num text-[13px] text-ink">{value}</span>
    </div>
  );

  return (
    <div>
      <Section title="Test condition">
        <SliderRow
          label="Vehicle speed"
          tooltip="Road speed of the vehicle. In still air this is also the wind-tunnel air speed. Aerodynamic forces grow with its square."
          quantity="speed"
          value={speed}
          min={0}
          max={100}
          step={1 / 3.6}
          defaultValue={150 / 3.6}
          onChange={setSpeed}
          onReset={() => setSpeed(150 / 3.6)}
        />
        <SliderRow
          label="Road gradient"
          tooltip="Slope of the road in degrees. Positive is uphill and adds the resisting force m g sin θ; negative is downhill."
          quantity="angle"
          value={environment.gradient}
          min={-10}
          max={20}
          step={0.5}
          defaultValue={0}
          onChange={(gradient) => setEnvironment({ gradient })}
          onReset={() => setEnvironment({ gradient: 0 })}
        />
        {readout("Gradient", `${gradientPercent(environment.gradient).toFixed(1)} %`)}
      </Section>

      <Section title="Air">
        <FieldRow label="Density from">
          <Select
            ariaLabel="Air density source"
            className="w-full"
            value={environment.airDensityMode}
            options={[
              { value: "computed", label: "T, p, RH" },
              { value: "direct", label: "Direct" },
            ]}
            onChange={(airDensityMode) => setEnvironment({ airDensityMode })}
          />
        </FieldRow>
        {environment.airDensityMode === "direct" ? (
          <QuantityField
            label="Air density ρ"
            quantity="density"
            value={environment.airDensity}
            min={0.6}
            max={1.6}
            tooltip="Used exactly as entered. Temperature is still used for viscosity (Reynolds number)."
            onChange={(airDensity) => setEnvironment({ airDensity })}
          />
        ) : (
          <>
            <QuantityField label="Pressure" quantity="pressure" value={environment.pressure} min={55000} max={108000} onChange={(pressure) => setEnvironment({ pressure })} />
            <QuantityField
              label="Relative humidity"
              quantity="ratio"
              unitLabel="%"
              value={environment.humidity * 100}
              min={0}
              max={100}
              decimals={0}
              onChange={(percent) => setEnvironment({ humidity: percent / 100 })}
            />
          </>
        )}
        <QuantityField label="Temperature" quantity="temperature" value={environment.temperature} min={233.15} max={323.15} onChange={(temperature) => setEnvironment({ temperature })} />
        <div className="mt-1 border-t border-line pt-1">
          {readout("Air density ρ", formatWithUnit(system, "density", air.density), "Moist-air density from the ideal-gas law applied to dry air and water vapour, unless entered directly.")}
          {readout("Dynamic pressure q", formatWithUnit("si", "pressure", dynamicPressure(air.density, wind.relativeSpeed)), GLOSSARY.dynamicPressure)}
        </div>
      </Section>

      <Section title="Wind">
        <SliderRow
          label="Wind speed"
          tooltip="Speed of the ambient wind over the road."
          quantity="speed"
          value={environment.windSpeed}
          min={0}
          max={30}
          step={0.5}
          defaultValue={STANDARD_ENVIRONMENT.windSpeed}
          onChange={(windSpeed) => setEnvironment({ windSpeed })}
          onReset={() => setEnvironment({ windSpeed: 0 })}
        />
        <SliderRow
          label="Wind direction"
          tooltip="0° is a pure headwind; ±90° is a pure crosswind. A crosswind yaws the relative wind and adds side force and yaw moment."
          quantity="angle"
          value={environment.windAngle}
          min={-90}
          max={90}
          step={1}
          defaultValue={0}
          onChange={(windAngle) => setEnvironment({ windAngle })}
          onReset={() => setEnvironment({ windAngle: 0 })}
        />
        <div className="my-1.5">
          <WindDiagram windSpeed={environment.windSpeed} windAngle={environment.windAngle} speed={speed} />
        </div>
        {readout("Relative air speed", formatWithUnit(system, "speed", wind.relativeSpeed))}
        {readout("Aerodynamic yaw angle", `${wind.yawAngleDeg.toFixed(1)} °`, GLOSSARY.yawAngle)}
      </Section>
    </div>
  );
}
