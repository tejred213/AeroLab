"use client";

import { useMemo } from "react";
import { type ChartRow, LineChartPanel } from "@/components/charts/LineChartPanel";
import { MODE_LABELS } from "@/components/dashboard/ResultsPanel";
import { Unavailable } from "@/components/ui/Layout";
import { overallLength } from "@/lib/geometry/parameters";
import { PROBE_OFFSET, probeCentreline, probeVerticalProfile } from "@/lib/simulation/surfaceProbe";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import { useFlowStore } from "@/lib/state/viewStore";
import { unitOf } from "@/lib/utils/units";

function NeedRun({ what }: { what: string }) {
  return (
    <div className="p-3">
      <Unavailable>{what} appear here after a simulation has been run.</Unavailable>
    </div>
  );
}

const FIELD_NOTE = `Reduced-order field, sampled ${Math.round(PROBE_OFFSET * 100)} cm off the surface on the centreline · not CFD`;

/** Flow speed along the body centreline and in the near wake, from the flow field. */
export function VelocityCharts() {
  const field = useFlowStore((state) => state.field);
  const result = useSimStore((state) => state.result);
  const system = useSettingsStore((state) => state.unitSystem);
  const speedUnit = unitOf(system, "speed");
  const lengthUnit = unitOf(system, "length");

  const charts = useMemo(() => {
    if (!field || !result) return null;
    const geometry = result.config.geometry;
    const freestream = field.freestream.speed;
    const surface: ChartRow[] = probeCentreline(field, geometry).map((point) => ({
      x: lengthUnit.toDisplay(point.x),
      upper: point.speedUpper === null ? null : speedUnit.toDisplay(point.speedUpper * freestream),
      lower: point.speedLower === null ? null : speedUnit.toDisplay(point.speedLower * freestream),
    }));
    const length = overallLength(geometry);
    const top = geometry.rideHeight + geometry.roofHeight + 0.8;
    const stations = [
      { key: "ahead", x: -1 },
      { key: "mid", x: length * 0.5 },
      { key: "behind", x: length + 0.5 },
    ];
    // Profiles share the height axis: one row per sampled height.
    const profiles = stations.map((station) => probeVerticalProfile(field, station.x, top));
    const heights = profiles[0].map((point) => point.z);
    const profileRows: ChartRow[] = heights.map((z) => {
      const row: ChartRow = { z: lengthUnit.toDisplay(z) };
      stations.forEach((station, index) => {
        const match = profiles[index].find((point) => Math.abs(point.z - z) < 1e-9);
        row[station.key] = match ? speedUnit.toDisplay(match.speed * freestream) : null;
      });
      return row;
    });
    return { surface, profileRows, freestream: speedUnit.toDisplay(freestream) };
  }, [field, result, speedUnit, lengthUnit]);

  if (!charts) return <NeedRun what="Velocity distributions" />;
  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <LineChartPanel
        title="Flow speed along the centreline"
        note={FIELD_NOTE}
        data={charts.surface}
        xKey="x"
        xLabel={`Distance from nose (${lengthUnit.label})`}
        xDecimals={lengthUnit.decimals === 0 ? 0 : 2}
        yLabel={`Speed (${speedUnit.label})`}
        yDecimals={0}
        series={[
          { key: "upper", label: "Over the body" },
          { key: "lower", label: "Under the floor" },
        ]}
      />
      <LineChartPanel
        title="Speed versus height on the centreline"
        note="Negative = reversed flow. Wake interior is an empirical model, not solved."
        data={charts.profileRows}
        xKey="z"
        xLabel={`Height above ground (${lengthUnit.label})`}
        xDecimals={lengthUnit.decimals === 0 ? 0 : 2}
        yLabel={`Streamwise speed (${speedUnit.label})`}
        yDecimals={0}
        zeroLine
        series={[
          { key: "ahead", label: "1 m ahead of nose" },
          { key: "mid", label: "Mid-length" },
          { key: "behind", label: "0.5 m behind tail" },
        ]}
      />
    </div>
  );
}

/** Pressure coefficient along the centreline, and the local lift loading. */
export function PressureCharts() {
  const field = useFlowStore((state) => state.field);
  const result = useSimStore((state) => state.result);
  const system = useSettingsStore((state) => state.unitSystem);
  const lengthUnit = unitOf(system, "length");

  const rows = useMemo(() => {
    if (!field || !result) return null;
    return probeCentreline(field, result.config.geometry).map<ChartRow>((point) => ({
      x: lengthUnit.toDisplay(point.x),
      upper: point.cpUpper,
      lower: point.cpLower,
      loading: point.cpUpper !== null && point.cpLower !== null ? point.cpLower - point.cpUpper : null,
    }));
  }, [field, result, lengthUnit]);

  if (!rows) return <NeedRun what="Pressure distributions" />;
  const xLabel = `Distance from nose (${lengthUnit.label})`;
  const xDecimals = lengthUnit.decimals === 0 ? 0 : 2;
  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <LineChartPanel
        title="Pressure coefficient along the centreline"
        note={FIELD_NOTE}
        data={rows}
        xKey="x"
        xLabel={xLabel}
        xDecimals={xDecimals}
        yLabel="Cp (–)"
        zeroLine
        series={[
          { key: "upper", label: "Upper surface" },
          { key: "lower", label: "Underbody" },
        ]}
      />
      <LineChartPanel
        title="Local lift loading"
        note="Cp underbody − Cp upper surface. Positive lifts that section; negative presses it down."
        data={rows}
        xKey="x"
        xLabel={xLabel}
        xDecimals={xDecimals}
        yLabel="ΔCp (–)"
        zeroLine
        series={[{ key: "loading", label: "Cp lower − Cp upper", color: "#f2a33a" }]}
      />
    </div>
  );
}

function usePerformanceCharts() {
  const performance = useSimStore((state) => state.performance);
  const result = useSimStore((state) => state.result);
  const system = useSettingsStore((state) => state.unitSystem);
  return { performance, result, system };
}

function provenanceNote(mode: keyof typeof MODE_LABELS): string {
  return `Aerodynamics: ${MODE_LABELS[mode].short} · ${MODE_LABELS[mode].name}`;
}

export function DragCharts() {
  const { performance, result, system } = usePerformanceCharts();
  const speedUnit = unitOf(system, "speed");
  const forceUnit = unitOf(system, "force");
  if (!performance || !result) return <NeedRun what="Drag curves" />;

  const rows: ChartRow[] = performance.speedSweep.map((sample) => ({
    speed: speedUnit.toDisplay(sample.speed),
    drag: forceUnit.toDisplay(sample.drag),
    rolling: forceUnit.toDisplay(sample.rolling),
    grade: forceUnit.toDisplay(sample.grade),
    total: forceUnit.toDisplay(sample.drag + sample.rolling + sample.grade),
    traction: forceUnit.toDisplay(sample.tractionForce),
    cd: sample.speed > 3 ? sample.cd : null,
  }));
  const markers = [{ x: speedUnit.toDisplay(result.config.speed), label: "test speed" }];
  const xLabel = `Vehicle speed (${speedUnit.label})`;
  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <LineChartPanel
        title="Resisting forces versus speed"
        note={`${provenanceNote(result.aero.mode)} · F_total = F_drag + F_rolling + F_grade`}
        data={rows}
        xKey="speed"
        xLabel={xLabel}
        yLabel={`Force (${forceUnit.label})`}
        yDecimals={0}
        markers={markers}
        series={[
          { key: "drag", label: "Aerodynamic drag" },
          { key: "rolling", label: "Rolling resistance" },
          { key: "grade", label: "Grade force" },
          { key: "total", label: "Total resistance", color: "#dfe4ea" },
          { key: "traction", label: "Available wheel force", color: "#58c88a", dashed: true, hidden: true },
        ]}
      />
      <LineChartPanel
        title="Drag coefficient versus speed"
        note="Only the skin-friction part of Cd varies with Reynolds number"
        data={rows}
        xKey="speed"
        xLabel={xLabel}
        yLabel="Cd (–)"
        yDecimals={3}
        markers={markers}
        series={[{ key: "cd", label: "Cd", decimals: 4 }]}
      />
    </div>
  );
}

export function DownforceCharts() {
  const { performance, result, system } = usePerformanceCharts();
  const speedUnit = unitOf(system, "speed");
  const forceUnit = unitOf(system, "force");
  if (!performance || !result) return <NeedRun what="Downforce curves" />;

  const c = result.aero.coefficients;
  const frontShare = Math.abs(c.cl) > 1e-9 ? c.clFront / c.cl : 0.5;
  const rows: ChartRow[] = performance.speedSweep.map((sample) => ({
    speed: speedUnit.toDisplay(sample.speed),
    total: forceUnit.toDisplay(sample.downforce),
    front: forceUnit.toDisplay(sample.downforce * frontShare),
    rear: forceUnit.toDisplay(sample.downforce * (1 - frontShare)),
    drag: forceUnit.toDisplay(sample.drag),
  }));
  const markers = [{ x: speedUnit.toDisplay(result.config.speed), label: "test speed" }];
  const xLabel = `Vehicle speed (${speedUnit.label})`;
  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <LineChartPanel
        title="Downforce versus speed"
        note={`${provenanceNote(result.aero.mode)} · negative values are lift`}
        data={rows}
        xKey="speed"
        xLabel={xLabel}
        yLabel={`Downforce (${forceUnit.label})`}
        yDecimals={0}
        zeroLine
        markers={markers}
        series={[
          { key: "total", label: "Total" },
          { key: "front", label: "Front axle" },
          { key: "rear", label: "Rear axle" },
        ]}
      />
      <LineChartPanel
        title="Downforce and drag versus speed"
        note="The cost of downforce: both grow with the square of speed"
        data={rows}
        xKey="speed"
        xLabel={xLabel}
        yLabel={`Force (${forceUnit.label})`}
        yDecimals={0}
        zeroLine
        markers={markers}
        series={[
          { key: "total", label: "Downforce" },
          { key: "drag", label: "Drag" },
        ]}
      />
    </div>
  );
}

export function PerformanceCharts() {
  const { performance, result, system } = usePerformanceCharts();
  const speedUnit = unitOf(system, "speed");
  const powerUnit = unitOf(system, "power");
  if (!performance || !result) return <NeedRun what="Performance curves" />;

  const trace: ChartRow[] = performance.accelTrace.map((sample) => ({
    time: sample.time,
    speed: speedUnit.toDisplay(sample.speed),
    acceleration: sample.acceleration,
  }));
  const power: ChartRow[] = performance.speedSweep.map((sample) => ({
    speed: speedUnit.toDisplay(sample.speed),
    required: powerUnit.toDisplay(sample.powerRequired),
    aero: powerUnit.toDisplay(sample.powerAero),
    rolling: powerUnit.toDisplay(sample.powerRolling),
    grade: powerUnit.toDisplay(sample.powerGrade),
    available: powerUnit.toDisplay(sample.powerAvailable),
  }));
  const note = provenanceNote(result.aero.mode);
  return (
    <div className="flex h-full min-h-0 gap-2 p-2">
      <LineChartPanel
        title="Speed versus time"
        note={`${note} · full-throttle from rest`}
        data={trace}
        xKey="time"
        xLabel="Time (s)"
        xDecimals={0}
        yLabel={`Speed (${speedUnit.label})`}
        yDecimals={0}
        series={[{ key: "speed", label: "Speed" }]}
      />
      <LineChartPanel
        title="Acceleration versus time"
        note="Dips to negative values are gear changes"
        data={trace}
        xKey="time"
        xLabel="Time (s)"
        xDecimals={0}
        yLabel="Acceleration (m/s²)"
        yDecimals={1}
        zeroLine
        series={[{ key: "acceleration", label: "Acceleration", color: "#f2a33a" }]}
      />
      <LineChartPanel
        title="Power required versus speed"
        note="Aerodynamic power grows with V³. Top speed is where required meets available."
        data={power}
        xKey="speed"
        xLabel={`Vehicle speed (${speedUnit.label})`}
        yLabel={`Power at wheels (${powerUnit.label})`}
        yDecimals={0}
        markers={[{ x: speedUnit.toDisplay(performance.topSpeed), label: "top speed" }]}
        series={[
          { key: "required", label: "Required (total)", color: "#dfe4ea" },
          { key: "aero", label: "Aerodynamic" },
          { key: "rolling", label: "Rolling" },
          { key: "grade", label: "Gradient" },
          { key: "available", label: "Available", color: "#58c88a", dashed: true },
        ]}
      />
    </div>
  );
}
