"use client";

import { useDeferredValue, useMemo } from "react";
import { OverallHeightControl, OverallLengthControl, ParamControl } from "@/components/controls/ParamControl";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Section } from "@/components/ui/Layout";
import { InfoTip } from "@/components/ui/Tooltip";
import { computeMetrics } from "@/lib/geometry/metrics";
import { PARAM_DEFINITIONS } from "@/lib/geometry/parameters";
import { buildBodyShape } from "@/lib/geometry/profile";
import { shapeFor } from "@/lib/geometry/sampledBody";
import { useImportedModel } from "@/lib/import/useImportedModel";
import { validateGeometry } from "@/lib/geometry/validate";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { allVehicles, currentVehicle, useSimStore } from "@/lib/state/simStore";
import type { ParamId } from "@/lib/types";
import { GLOSSARY } from "@/lib/utils/glossary";
import { formatWithUnit } from "@/lib/utils/units";

const idsOf = (group: string): ParamId[] =>
  PARAM_DEFINITIONS.filter((definition) => definition.group === group).map((definition) => definition.id);

const BODY_IDS = idsOf("body");
const UNDERBODY_IDS = idsOf("underbody");
const WHEEL_IDS = idsOf("wheels");
const AERO_IDS = idsOf("aero");
const DETAIL_IDS = idsOf("details");

/** Live read-out of quantities derived from the geometry, plus validity. */
function DerivedGeometry() {
  const geometry = useDeferredValue(useSimStore((state) => state.geometry));
  const system = useSettingsStore((state) => state.unitSystem);
  const imported = useImportedModel();
  // For an imported 3D model the figures come from its measured envelope, as in the solver.
  const bodyId = imported?.active && imported.bodyReady ? imported.model.bodyId : undefined;
  const derived = useMemo(() => {
    const issues = validateGeometry(geometry).filter((issue) => issue.severity === "error");
    if (issues.length > 0) return { issues, metrics: null };
    let shape = buildBodyShape(geometry);
    try {
      shape = shapeFor(geometry, bodyId);
    } catch {
      // The deferred geometry and the model can be out of step for one render: keep the parametric shape.
    }
    return { issues, metrics: computeMetrics(shape) };
  }, [geometry, bodyId]);

  const row = (label: string, value: string, tip?: string) => (
    <div className="flex items-center justify-between gap-2 py-px">
      <span className="flex items-center gap-1.5 text-[13px] text-ink-3">
        {label}
        {tip && <InfoTip content={tip} label={label} />}
      </span>
      <span className="num text-[13px] text-ink">{value}</span>
    </div>
  );

  if (!derived.metrics) {
    return (
      <div role="alert" className="rounded-lg border border-err/50 bg-err/10 px-3 py-2.5 text-xs leading-relaxed text-ink">
        <p className="mb-1 font-semibold text-err">Invalid geometry</p>
        <ul className="list-disc space-y-0.5 pl-4">
          {derived.issues.map((issue) => (
            <li key={issue.code + issue.message}>{issue.message}</li>
          ))}
        </ul>
      </div>
    );
  }
  const { metrics } = derived;
  const belowLimit = metrics.groundClearance < geometry.minGroundClearance;
  return (
    <div>
      {row("Overall length", formatWithUnit(system, "length", metrics.length))}
      {row("Overall height", formatWithUnit(system, "length", metrics.overallHeight))}
      {row("Frontal area", formatWithUnit(system, "area", metrics.frontalArea), GLOSSARY.frontalArea)}
      {row("Roof length", formatWithUnit(system, "length", metrics.roofLength))}
      {row("Effective rear slope", `${metrics.effectiveSlantDeg.toFixed(1)} °`, "Angle of the line from the roof trailing edge to the tail edge. Governs whether the rear flow stays attached.")}
      <div className="flex items-center justify-between gap-2 py-px">
        <span className="text-[13px] text-ink-3">Ground clearance</span>
        <span className={`num text-[13px] ${belowLimit ? "text-warn" : "text-ink"}`}>
          {formatWithUnit(system, "length", metrics.groundClearance)}
          {belowLimit ? " · below limit" : ""}
        </span>
      </div>
    </div>
  );
}

function VehicleSelector() {
  const vehicleId = useSimStore((state) => state.vehicleId);
  const customVehicles = useSimStore((state) => state.customVehicles);
  const selectVehicle = useSimStore((state) => state.selectVehicle);
  const resetGeometry = useSimStore((state) => state.resetGeometry);
  const vehicle = useSimStore((state) => currentVehicle(state));
  const options = allVehicles(customVehicles).map((entry) => ({
    value: entry.id,
    label: entry.name,
    group: entry.custom ? "Custom vehicles" : entry.realCar ? "Production cars (look-alikes)" : "Generic classes",
  }));
  const real = vehicle.realCar;
  return (
    <div>
      <div className="flex items-center gap-2">
        <Select ariaLabel="Base vehicle" value={vehicleId} options={options} onChange={selectVehicle} className="flex-1" />
        <Button size="sm" onClick={resetGeometry} title="Reset all geometry parameters to the vehicle defaults">
          Reset all
        </Button>
      </div>
      <p className="mt-1.5 text-xs leading-normal text-ink-3">{vehicle.description}</p>
      {real ? (
        <div className="mt-1.5 border-l-2 border-line-strong pl-2 text-xs leading-normal text-ink-3">
          <p className="num text-ink-2">
            Published Cd {real.published.cd === null ? "not available" : real.published.cd.toFixed(3)}
          </p>
          <p>{real.published.cdNote}</p>
          <p className="mt-1">
            The simulator does not use that figure. It predicts this car from the {real.anchorClassName} class (reference
            Cd {vehicle.reference.cd.toFixed(2)}, Cl {vehicle.reference.cl.toFixed(2)}) plus the modelled effect of its
            shape.
          </p>
        </div>
      ) : (
        <p className="num mt-1 text-xs text-ink-3">
          Class reference (approx.): Cd {vehicle.reference.cd.toFixed(2)} · Cl {vehicle.reference.cl.toFixed(2)}
        </p>
      )}
    </div>
  );
}

export function GeometryPanel() {
  return (
    <div>
      <Section title="Base vehicle">
        <VehicleSelector />
      </Section>
      <Section title="Derived geometry">
        <DerivedGeometry />
      </Section>
      <Section title="Body" collapsible>
        <OverallLengthControl />
        <OverallHeightControl />
        {BODY_IDS.map((id) => (
          <ParamControl key={id} id={id} />
        ))}
      </Section>
      <Section title="Underbody" collapsible>
        {UNDERBODY_IDS.map((id) => (
          <ParamControl key={id} id={id} />
        ))}
      </Section>
      <Section title="Wheels" collapsible>
        {WHEEL_IDS.map((id) => (
          <ParamControl key={id} id={id} />
        ))}
      </Section>
      <Section title="Details" collapsible>
        <p className="mb-1 text-xs leading-normal text-ink-3">
          Details that carry drag and are part of the calculation: door mirrors, how open the rims are, and the cooling
          intake. Glass, door lines, lights and paint are drawn only.
        </p>
        {DETAIL_IDS.map((id) => (
          <ParamControl key={id} id={id} />
        ))}
      </Section>
    </div>
  );
}

export function AeroDevicesPanel() {
  return (
    <div>
      <Section title="Aero devices">
        <p className="mb-1 text-xs leading-normal text-ink-3">
          Set a device&apos;s size to zero to remove it. Devices trade drag for downforce; compare runs to see by how much.
        </p>
        {AERO_IDS.map((id) => (
          <ParamControl key={id} id={id} />
        ))}
      </Section>
      <Section title="Underbody aero" collapsible>
        {(["rideHeight", "floorFlatness", "diffuserAngle", "diffuserLength"] as ParamId[]).map((id) => (
          <ParamControl key={id} id={id} />
        ))}
      </Section>
    </div>
  );
}
