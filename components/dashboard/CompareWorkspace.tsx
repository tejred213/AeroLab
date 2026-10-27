"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { type ChartRow, LineChartPanel } from "@/components/charts/LineChartPanel";
import { ComparisonTable } from "@/components/dashboard/ComparisonTable";
import { ProfileDrawing } from "@/components/dashboard/ProfileDrawing";
import { BreakdownBars, MODE_LABELS } from "@/components/dashboard/ResultsPanel";
import { AppHeader } from "@/components/ui/AppHeader";
import { AppLink } from "@/components/ui/AppLink";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Unavailable } from "@/components/ui/Layout";
import { Tabs } from "@/components/ui/Tabs";
import { performanceLocal, simulateLocal } from "@/lib/simulation/client";
import { makePerformanceInput } from "@/lib/simulation/config";
import type { FlowField } from "@/lib/simulation/field";
import { probeCentreline } from "@/lib/simulation/surfaceProbe";
import { type Experiment, useExperimentStore } from "@/lib/state/experimentStore";
import { useSettingsStore } from "@/lib/state/settingsStore";
import type { BodyStyle, FlowLayers } from "@/lib/state/viewStore";
import type { BreakdownItem, PerformanceResult } from "@/lib/types";
import { SERIES_COLORS } from "@/lib/utils/colormap";
import { describeChanges } from "@/lib/utils/describe";
import { resampleSeries } from "@/lib/utils/series";
import { unitOf } from "@/lib/utils/units";
import { useSimStore } from "@/lib/state/simStore";
import { findVehicle } from "@/lib/vehicle/library";
import { appearanceFor } from "@/lib/vehicle/appearance";

const TunnelScene = dynamic(() => import("@/components/3d/TunnelScene").then((module) => module.TunnelScene), { ssr: false });

const NO_LAYERS: FlowLayers = { airflow: false, streamlines: false, velocity: false, pressure: false, wake: false, separation: false, forces: false };
const PRESSURE_LAYERS: FlowLayers = { ...NO_LAYERS };
const VELOCITY_LAYERS: FlowLayers = { ...NO_LAYERS, velocity: true };
const SIDE_CAMERA = { preset: "side" as const, nonce: 0 };
const PERSPECTIVE_CAMERA = { preset: "perspective" as const, nonce: 0 };
const formatNewton = (newton: number) => `${newton.toFixed(0)} N`;

/** Full performance curves for each experiment, recomputed from its stored coefficients. */
function usePerformanceCurves(experiments: Experiment[]): Map<string, PerformanceResult> {
  const [curves, setCurves] = useState<Map<string, PerformanceResult>>(new Map());
  const key = experiments.map((experiment) => experiment.id).join("|");
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      experiments.map(async (experiment) => {
        const performance = await performanceLocal(
          makePerformanceInput(
            experiment.spec,
            experiment.powertrain,
            experiment.config.geometry,
            experiment.aero.coefficients,
            experiment.aero.air.density,
            experiment.config.environment,
            experiment.config.speed,
          ),
        );
        return [experiment.id, performance] as const;
      }),
    )
      .then((entries) => {
        if (!cancelled) setCurves(new Map(entries));
      })
      .catch(() => {
        if (!cancelled) setCurves(new Map());
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return curves;
}

function OverlayCharts({ experiments }: { experiments: Experiment[] }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const curves = usePerformanceCurves(experiments);
  const speed = unitOf(system, "speed");
  const force = unitOf(system, "force");
  const power = unitOf(system, "power");

  const series = experiments.map((experiment, index) => ({
    key: experiment.id,
    label: experiment.name,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
  }));
  // Each experiment's curves are sampled at its own speeds and times; put them on one shared axis.
  const build = (pick: (performance: PerformanceResult) => { x: number; y: number }[]): ChartRow[] =>
    resampleSeries(
      experiments.flatMap((experiment) => {
        const performance = curves.get(experiment.id);
        return performance ? [{ key: experiment.id, points: pick(performance) }] : [];
      }),
    );

  const drag = build((p) => p.speedSweep.map((s) => ({ x: speed.toDisplay(s.speed), y: force.toDisplay(s.drag) })));
  const downforce = build((p) => p.speedSweep.map((s) => ({ x: speed.toDisplay(s.speed), y: force.toDisplay(s.downforce) })));
  const required = build((p) => p.speedSweep.map((s) => ({ x: speed.toDisplay(s.speed), y: power.toDisplay(s.powerRequired) })));
  const trace = build((p) => p.accelTrace.map((s) => ({ x: s.time, y: speed.toDisplay(s.speed) })));
  const xSpeed = `Vehicle speed (${speed.label})`;

  return (
    <div className="grid gap-2 md:grid-cols-2 [&>figure]:h-[250px]">
      <LineChartPanel title="Drag versus speed" data={drag} xKey="x" xLabel={xSpeed} yLabel={`Drag (${force.label})`} yDecimals={0} series={series} />
      <LineChartPanel title="Downforce versus speed" data={downforce} xKey="x" xLabel={xSpeed} yLabel={`Downforce (${force.label})`} yDecimals={0} zeroLine series={series} />
      <LineChartPanel title="Power required versus speed" data={required} xKey="x" xLabel={xSpeed} yLabel={`Power (${power.label})`} yDecimals={0} series={series} />
      <LineChartPanel title="Speed versus time (full throttle)" data={trace} xKey="x" xLabel="Time (s)" yLabel={`Speed (${speed.label})`} yDecimals={0} series={series} />
    </div>
  );
}

/** Coefficient build-up of B minus A, term by term (only meaningful within one mode). */
function breakdownDifference(a: BreakdownItem[], b: BreakdownItem[]): BreakdownItem[] {
  const ids = [...new Set([...a, ...b].map((item) => item.id))];
  return ids.map((id) => {
    const inA = a.find((item) => item.id === id);
    const inB = b.find((item) => item.id === id);
    return { id, label: (inB ?? inA)?.label ?? id, value: (inB?.value ?? 0) - (inA?.value ?? 0) };
  });
}

function useFieldFor(experiment: Experiment | null): { field: FlowField | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; field: FlowField | null; failed: boolean }>({ id: null, field: null, failed: false });
  const id = experiment?.id ?? null;
  useEffect(() => {
    if (!experiment) return;
    let cancelled = false;
    simulateLocal({ ...experiment.config, mode: "analytical", fidelity: "coarse" }, true)
      .then((run) => {
        if (!cancelled) setState({ id: experiment.id, field: run.field, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ id: experiment.id, field: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return state.id === id ? { field: state.field, failed: state.failed } : { field: null, failed: false };
}

type DifferenceView = "geometry" | "pressure" | "velocity" | "cd";

function DifferenceMode({ experiments }: { experiments: Experiment[] }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const [idA, setIdA] = useState(experiments[0].id);
  const [idB, setIdB] = useState(experiments[experiments.length > 1 ? 1 : 0].id);
  const [view, setView] = useState<DifferenceView>("geometry");
  const a = experiments.find((experiment) => experiment.id === idA) ?? experiments[0];
  const b = experiments.find((experiment) => experiment.id === idB) ?? experiments[0];
  const needFields = view === "pressure" || view === "velocity";
  const fieldA = useFieldFor(needFields ? a : null);
  const fieldB = useFieldFor(needFields ? b : null);
  const lengthUnit = unitOf(system, "length");
  const speedUnit = unitOf(system, "speed");

  const options = experiments.map((experiment) => ({ value: experiment.id, label: experiment.name }));
  const changes = describeChanges(system, a.config.geometry, b.config.geometry);

  const probe = useMemo(() => {
    if (!fieldA.field || !fieldB.field) return null;
    const pa = probeCentreline(fieldA.field, a.config.geometry, 80);
    const pb = probeCentreline(fieldB.field, b.config.geometry, 80);
    // Compared at the same fraction of body length, since the two bodies may differ in length.
    return pa.map<ChartRow>((point, index) => {
      const other = pb[index];
      const va = a.config.speed;
      const vb = b.config.speed;
      const diff = (x: number | null, y: number | null) => (x !== null && y !== null ? y - x : null);
      return {
        x: (100 * index) / (pa.length - 1),
        cpA: point.cpUpper,
        cpB: other.cpUpper,
        dCpUpper: diff(point.cpUpper, other.cpUpper),
        dCpLower: diff(point.cpLower, other.cpLower),
        vA: point.speedUpper === null ? null : speedUnit.toDisplay(point.speedUpper * va),
        vB: other.speedUpper === null ? null : speedUnit.toDisplay(other.speedUpper * vb),
        dVUpper:
          point.speedUpper !== null && other.speedUpper !== null
            ? speedUnit.toDisplay(other.speedUpper * vb) - speedUnit.toDisplay(point.speedUpper * va)
            : null,
        dVLower:
          point.speedLower !== null && other.speedLower !== null
            ? speedUnit.toDisplay(other.speedLower * vb) - speedUnit.toDisplay(point.speedLower * va)
            : null,
      };
    });
  }, [fieldA.field, fieldB.field, a, b, speedUnit]);

  const sameMode = a.aero.mode === b.aero.mode;
  // Dressed like in the simulator (appearance only); an imported model's envelope is shown plain.
  const appearanceOf = (experiment: Experiment) => {
    const vehicle = findVehicle(experiment.vehicleId, useSimStore.getState().customVehicles);
    return vehicle && !experiment.config.bodyId ? appearanceFor(vehicle, experiment.config.geometry) : null;
  };
  const scene = (experiment: Experiment, field: FlowField | null, bodyStyle: BodyStyle, layers: FlowLayers) => (
    <div className="h-[230px] min-w-0 flex-1 border border-line">
      <TunnelScene
        geometry={experiment.config.geometry}
        appearance={appearanceOf(experiment)}
        resultGeometry={field ? experiment.config.geometry : null}
        field={field}
        forces={null}
        bodyStyle={bodyStyle}
        bodyOpacity={1}
        layers={layers}
        sliceAxis="y"
        slicePosition={0}
        playing={false}
        particleCount={0}
        camera={SIDE_CAMERA}
        formatForce={formatNewton}
        showLabels={false}
        showGizmo={false}
      />
    </div>
  );
  const xLabel = "Position along the body (% of length)";
  const fieldNote = "Reduced-order field (coarse grid), centreline, sampled off the surface · not CFD";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">A</span>
        <Select ariaLabel="Configuration A" value={a.id} options={options} onChange={setIdA} />
        <span className="label">B</span>
        <Select ariaLabel="Configuration B" value={b.id} options={options} onChange={setIdB} />
        <Tabs
          className="ml-2 border-b-0"
          size="sm"
          label="Difference view"
          active={view}
          onChange={(id) => setView(id as DifferenceView)}
          tabs={[
            { id: "geometry", label: "Geometry difference" },
            { id: "pressure", label: "Pressure difference" },
            { id: "velocity", label: "Velocity difference" },
            { id: "cd", label: "Cd difference" },
          ]}
        />
      </div>

      {view === "geometry" && (
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-panel p-4">
            <div className="label mb-1">Side profile overlay · A solid, B dashed</div>
            <ProfileDrawing
              className="w-full"
              ariaLabel={`Side profiles of ${a.name} and ${b.name} overlaid`}
              layers={[
                { geometry: a.config.geometry, color: SERIES_COLORS[0] },
                { geometry: b.config.geometry, color: SERIES_COLORS[1], dashed: true },
              ]}
            />
            <p className="mt-1 text-xs leading-normal text-ink-2">
              {changes.length === 0 ? "The two geometries are identical." : `B relative to A: ${changes.join(", ")}.`}
            </p>
          </div>
          <div className="h-[260px] border border-line">
            <TunnelScene
              geometry={a.config.geometry}
              ghostGeometry={b.config.geometry}
              resultGeometry={null}
              field={null}
              forces={null}
              bodyStyle="solid"
              bodyOpacity={1}
              layers={NO_LAYERS}
              sliceAxis="y"
              slicePosition={0}
              playing={false}
              particleCount={0}
              camera={PERSPECTIVE_CAMERA}
              formatForce={formatNewton}
              showLabels={false}
            />
          </div>
          <p className="text-xs text-ink-3 lg:col-span-2">3D view: A is drawn solid, B as a translucent blue overlay.</p>
        </div>
      )}

      {needFields && (
        <div className="mt-2">
          {fieldA.failed || fieldB.failed ? (
            <Unavailable>The flow field for one of the configurations could not be computed.</Unavailable>
          ) : !probe ? (
            <p className="text-[13px] text-ink-3">Computing reduced-order flow fields for A and B…</p>
          ) : (
            <>
              <div className="flex gap-2">
                {scene(a, fieldA.field, view === "pressure" ? "pressure" : "solid", view === "pressure" ? PRESSURE_LAYERS : VELOCITY_LAYERS)}
                {scene(b, fieldB.field, view === "pressure" ? "pressure" : "solid", view === "pressure" ? PRESSURE_LAYERS : VELOCITY_LAYERS)}
              </div>
              <p className="mt-1 text-xs text-ink-3">
                Left: A · {a.name}. Right: B · {b.name}.{" "}
                {view === "pressure" ? "Surface coloured by pressure coefficient (blue low, green neutral, red high)." : "Flow speed on the centre plane (blue slow, red fast)."}
              </p>
              <div className="mt-2 grid gap-2 md:grid-cols-2 [&>figure]:h-[240px]">
                {view === "pressure" ? (
                  <>
                    <LineChartPanel
                      title="Upper-surface pressure coefficient"
                      note={fieldNote}
                      data={probe}
                      xKey="x"
                      xLabel={xLabel}
                      yLabel="Cp (–)"
                      zeroLine
                      series={[
                        { key: "cpA", label: `A · ${a.name}` },
                        { key: "cpB", label: `B · ${b.name}`, dashed: true },
                      ]}
                    />
                    <LineChartPanel
                      title="Pressure difference B − A"
                      note={fieldNote}
                      data={probe}
                      xKey="x"
                      xLabel={xLabel}
                      yLabel="ΔCp (–)"
                      zeroLine
                      series={[
                        { key: "dCpUpper", label: "Upper surface" },
                        { key: "dCpLower", label: "Underbody" },
                      ]}
                    />
                  </>
                ) : (
                  <>
                    <LineChartPanel
                      title="Flow speed over the body"
                      note={fieldNote}
                      data={probe}
                      xKey="x"
                      xLabel={xLabel}
                      yLabel={`Speed (${speedUnit.label})`}
                      yDecimals={0}
                      series={[
                        { key: "vA", label: `A · ${a.name}` },
                        { key: "vB", label: `B · ${b.name}`, dashed: true },
                      ]}
                    />
                    <LineChartPanel
                      title="Speed difference B − A"
                      note={fieldNote}
                      data={probe}
                      xKey="x"
                      xLabel={xLabel}
                      yLabel={`ΔSpeed (${speedUnit.label})`}
                      yDecimals={1}
                      zeroLine
                      series={[
                        { key: "dVUpper", label: "Over the body" },
                        { key: "dVLower", label: "Under the floor" },
                      ]}
                    />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {view === "cd" && (
        <div className="mt-2 grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-line bg-panel p-5">
            <div className="label mb-1">ΔCd by component · B − A</div>
            {sameMode ? (
              <BreakdownBars
                items={breakdownDifference(a.aero.breakdown.drag, b.aero.breakdown.drag)}
                total={b.aero.coefficients.cd - a.aero.coefficients.cd}
              />
            ) : (
              <Unavailable>
                A is {MODE_LABELS[a.aero.mode].name} and B is {MODE_LABELS[b.aero.mode].name}: their build-ups use
                different terms and cannot be subtracted. Total ΔCd = {(b.aero.coefficients.cd - a.aero.coefficients.cd).toFixed(4)}.
              </Unavailable>
            )}
          </div>
          <div className="rounded-2xl border border-line bg-panel p-5">
            <div className="label mb-1">ΔCl by component · B − A</div>
            {sameMode ? (
              <BreakdownBars
                items={breakdownDifference(a.aero.breakdown.lift, b.aero.breakdown.lift)}
                total={b.aero.coefficients.cl - a.aero.coefficients.cl}
              />
            ) : (
              <Unavailable>Total ΔCl = {(b.aero.coefficients.cl - a.aero.coefficients.cl).toFixed(4)}.</Unavailable>
            )}
          </div>
          <p className="text-xs text-ink-3 md:col-span-2">
            Length-direction differences are shown in {lengthUnit.label}; coefficient differences are dimensionless. Bars
            to the right of the centre line are increases.
          </p>
        </div>
      )}
    </div>
  );
}

/** Compare page: choose saved configurations and experiments, then compare them on one screen. */
export function CompareWorkspace() {
  const experiments = useExperimentStore((state) => state.experiments);
  const compareIds = useExperimentStore((state) => state.compareIds);
  const toggleCompare = useExperimentStore((state) => state.toggleCompare);
  const setCompare = useExperimentStore((state) => state.setCompare);
  const [section, setSection] = useState("table");

  const selected = compareIds
    .map((id) => experiments.find((experiment) => experiment.id === id))
    .filter((experiment): experiment is Experiment => experiment !== undefined);
  const ordered = [...experiments].reverse();

  return (
    <div className="grid-backdrop flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-5">
        <h1 className="text-[clamp(26px,2.6vw,34px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">Configuration comparison</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          The first selected configuration is the baseline. Selections are shared with the simulator&apos;s History tab.
        </p>

        {experiments.length === 0 ? (
          <div className="mt-4">
            <Unavailable>
              Nothing to compare yet. Run simulations in the{" "}
              <AppLink className="text-data underline" href="/simulator">
                simulator
              </AppLink>
              ; each run is recorded and can be selected here.
            </Unavailable>
          </div>
        ) : (
          <>
            <section className="mt-5 rounded-2xl border border-line bg-panel p-5" aria-label="Configurations to compare">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-[13px] font-medium text-ink">Select configurations ({selected.length} selected)</span>
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => setCompare(experiments.filter((experiment) => experiment.saved).map((experiment) => experiment.id))}>
                    All saved
                  </Button>
                  <Button size="sm" onClick={() => setCompare([])}>
                    Clear
                  </Button>
                </div>
              </div>
              <div className="scroll-thin flex max-h-[132px] flex-wrap gap-1.5 overflow-y-auto">
                {ordered.map((experiment) => {
                  const index = compareIds.indexOf(experiment.id);
                  return (
                    <button
                      key={experiment.id}
                      type="button"
                      aria-pressed={index >= 0}
                      onClick={() => toggleCompare(experiment.id)}
                      className={`flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors ${
                        index >= 0 ? "border-data/70 bg-data/10 text-ink" : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
                      }`}
                    >
                      {index >= 0 && <span className="num text-[11px] font-semibold text-data">{index === 0 ? "Base" : index + 1}</span>}
                      {experiment.saved && <span className="text-accent">★</span>}
                      {experiment.name}
                      <span className="num text-[11px] font-normal text-ink-3">
                        {MODE_LABELS[experiment.aero.mode].short} · Cd {experiment.aero.coefficients.cd.toFixed(3)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            {selected.length < 2 ? (
              <div className="mt-4">
                <Unavailable>Select at least two configurations to compare.</Unavailable>
              </div>
            ) : (
              <>
                <Tabs
                  className="mt-5"
                  label="Comparison sections"
                  active={section}
                  onChange={setSection}
                  tabs={[
                    { id: "table", label: "Table" },
                    { id: "charts", label: "Overlay charts" },
                    { id: "difference", label: "Visual difference (A vs B)" },
                  ]}
                />
                <div className="mt-3">
                  {section === "table" && (
                    <div className="rounded-2xl border border-line bg-panel p-5">
                      <ComparisonTable experiments={selected} headings={selected.map((_, index) => (index === 0 ? "Baseline" : `Config ${index + 1}`))} />
                    </div>
                  )}
                  {section === "charts" && <OverlayCharts experiments={selected} />}
                  {section === "difference" && <DifferenceMode experiments={selected} />}
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
