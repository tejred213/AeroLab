"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ReportChart } from "@/components/charts/ReportChart";
import { COMPARISON_METRICS } from "@/components/dashboard/ComparisonTable";
import { ProfileDrawing } from "@/components/dashboard/ProfileDrawing";
import { formatDuration, MODE_LABELS, SOURCE_LABELS, UNCERTAINTY_NOTES } from "@/components/dashboard/ResultsPanel";
import { AppLink } from "@/components/ui/AppLink";
import { clampParam, PARAM_BY_ID, PARAM_DEFINITIONS, PARAM_GROUPS } from "@/lib/geometry/parameters";
import { isGeometryValid } from "@/lib/geometry/validate";
import { MODEL_VERSION } from "@/lib/physics/model";
import { runAnalytical } from "@/lib/simulation/analyticalEngine";
import { performanceLocal } from "@/lib/simulation/client";
import { makePerformanceInput } from "@/lib/simulation/config";
import { baselineFor, type Experiment, useExperimentStore } from "@/lib/state/experimentStore";
import { useArrival } from "@/lib/state/pageTransition";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import type { BreakdownItem, ParamId, PerformanceResult } from "@/lib/types";
import { describeConditions, formatParam } from "@/lib/utils/describe";
import { downloadJson, slug } from "@/lib/utils/export";
import { formatNumber, formatSigned, formatWithUnit, quantityOfParam, type UnitSystem, unitOf } from "@/lib/utils/units";
import { findVehicle } from "@/lib/vehicle/library";
import { gradientPercent } from "@/lib/vehicle/performance";

const LIMITATIONS = [
  "AeroLab is an educational and research-oriented tool. Its results are estimates from simplified models and are not a substitute for wind-tunnel testing or validated CFD.",
  "The geometry is a simplified parametric body. Mirrors, cooling openings, panel gaps, underbody detail, wheel design and rotating wheels are not modelled explicitly.",
  "Modes A and B do not solve viscous or turbulent flow. Separation, base pressure and wake structure come from empirical closures and are the largest source of error.",
  "Absolute coefficients are anchored to an approximate class reference; the models are most trustworthy for the direction and rough size of changes between similar configurations.",
  "Uncertainty values are model-based estimates, not statistical confidence intervals from measurements.",
  "The vehicle-performance model is one-dimensional (longitudinal) with constant tyre properties and a simplified powertrain; it ignores suspension motion, pitch, tyre load sensitivity and thermal effects.",
  "Results outside the ranges flagged by the warnings section should not be relied on.",
];

const SENSITIVITY_PARAMS: ParamId[] = [
  "rideHeight",
  "roofHeight",
  "width",
  "windshieldAngle",
  "rearWindowAngle",
  "rearTaper",
  "floorFlatness",
  "diffuserAngle",
  "spoilerAngle",
  "spoilerHeight",
  "splitterExtension",
  "wheelExposure",
];

interface SensitivityRow {
  id: ParamId;
  delta: number;
  dCd: number;
  dCl: number;
}

/** One-at-a-time sensitivities about the experiment's geometry, with the analytical model. */
function localSensitivity(experiment: Experiment): SensitivityRow[] {
  const rows: SensitivityRow[] = [];
  const config = { ...experiment.config, mode: "analytical" as const };
  let base;
  try {
    base = runAnalytical(config);
  } catch {
    return rows;
  }
  for (const id of SENSITIVITY_PARAMS) {
    const definition = PARAM_BY_ID[id];
    const step = 0.05 * (definition.max - definition.min);
    const value = config.geometry[id];
    // Step upward unless that leaves the range.
    const target = clampParam(id, value + step) > value + 1e-12 ? clampParam(id, value + step) : clampParam(id, value - step);
    const geometry = { ...config.geometry, [id]: target };
    if (Math.abs(target - value) < 1e-12 || !isGeometryValid(geometry)) continue;
    try {
      const perturbed = runAnalytical({ ...config, geometry });
      rows.push({
        id,
        delta: target - value,
        dCd: perturbed.coefficients.cd - base.coefficients.cd,
        dCl: perturbed.coefficients.cl - base.coefficients.cl,
      });
    } catch {
      // Points the model cannot evaluate are left out of the table.
    }
  }
  return rows;
}

function Heading({ number, children }: { number: number; children: ReactNode }) {
  return (
    <h2 className="mt-6 mb-2 border-b border-neutral-400 pb-1 text-[13px] font-bold tracking-wide text-neutral-900 uppercase">
      {number}. {children}
    </h2>
  );
}

function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-[3px] text-[11px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-neutral-600">{label}</dt>
          <dd className="font-mono text-neutral-900 tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BreakdownTable({ title, items }: { title: string; items: BreakdownItem[] }) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return (
    <table className="print-avoid-break w-full border-collapse text-[11px]">
      <caption className="mb-1 text-left font-semibold text-neutral-800">{title}</caption>
      <tbody>
        {items
          .filter((item) => Math.abs(item.value) > 5e-5)
          .map((item) => (
            <tr key={item.id} className="border-b border-neutral-200">
              <td className="py-[2px] text-neutral-700">{item.label}</td>
              <td className="py-[2px] text-right font-mono tabular-nums">{formatSigned(item.value, 4)}</td>
            </tr>
          ))}
        <tr className="border-t border-neutral-500 font-semibold">
          <td className="py-[2px]">Total</td>
          <td className="py-[2px] text-right font-mono tabular-nums">{formatSigned(total, 4)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function metricCell(system: UnitSystem, experiment: Experiment, index: number): string {
  const row = COMPARISON_METRICS[index];
  const value = row.value(experiment);
  if (value === null || !Number.isFinite(value)) return "—";
  if (!row.quantity) return row.signed ? formatSigned(value, row.decimals ?? 3) : formatNumber(value, row.decimals ?? 3);
  const unit = unitOf(system, row.quantity);
  return `${unit.toDisplay(value).toFixed(row.decimals ?? unit.decimals)} ${unit.label}`;
}

/** Print-ready engineering report for one experiment. */
export function ReportView() {
  // The sheet fades in after a navigation, like the pages of the app (globals.css).
  const arrival = useArrival("app");
  const experiments = useExperimentStore((state) => state.experiments);
  const baselineId = useExperimentStore((state) => state.baselineId);
  const customVehicles = useSimStore((state) => state.customVehicles);
  const system = useSettingsStore((state) => state.unitSystem);
  const id = useMemo(() => new URLSearchParams(window.location.search).get("id"), []);
  const experiment = experiments.find((entry) => entry.id === id) ?? null;
  const [performance, setPerformance] = useState<PerformanceResult | null>(null);

  useEffect(() => {
    if (!experiment) return;
    let cancelled = false;
    performanceLocal(
      makePerformanceInput(
        experiment.spec,
        experiment.powertrain,
        experiment.config.geometry,
        experiment.aero.coefficients,
        experiment.aero.air.density,
        experiment.config.environment,
        experiment.config.speed,
      ),
    )
      .then((result) => {
        if (!cancelled) setPerformance(result);
      })
      .catch(() => {
        if (!cancelled) setPerformance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [experiment]);

  const sensitivity = useMemo(() => (experiment ? localSensitivity(experiment) : []), [experiment]);

  if (!experiment) {
    return (
      <div data-arriving={arrival ?? undefined} className="report-page flex min-h-dvh items-center justify-center bg-neutral-200 p-8 text-sm text-neutral-800">
        <p>
          This report refers to an experiment that is not stored in this browser.{" "}
          <AppLink className="underline" href="/simulator">
            Open the simulator
          </AppLink>{" "}
          and create it from the History tab.
        </p>
      </div>
    );
  }

  const { aero, config, spec, powertrain } = experiment;
  const vehicle = findVehicle(experiment.vehicleId, customVehicles);
  const realCar = vehicle?.realCar ?? null;
  const imported = vehicle?.importedModel ?? null;
  // Edits are marked against the vehicle as it ships; the calibration anchor can be a different geometry.
  const baseGeometry = vehicle?.geometry ?? config.referenceGeometry;
  const c = aero.coefficients;
  const f = aero.forces;
  const mode = MODE_LABELS[aero.mode];
  const baseline = baselineFor(experiments, baselineId, experiment.id);
  const speedUnit = unitOf(system, "speed");
  const forceUnit = unitOf(system, "force");
  const powerUnit = unitOf(system, "power");
  const env = config.environment;

  return (
    <div data-arriving={arrival ?? undefined} className="report-page min-h-dvh bg-neutral-300 py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-3 flex max-w-[820px] items-center justify-between px-2">
        <AppLink href="/simulator" className="text-xs text-neutral-700 underline">
          ← Back to simulator
        </AppLink>
        <div className="flex gap-2">
          <button
            type="button"
            className="h-8 border border-neutral-500 bg-white px-3 text-xs text-neutral-900 hover:bg-neutral-100"
            onClick={() => downloadJson(experiment, `${slug(experiment.name)}.json`)}
          >
            Export JSON
          </button>
          <button
            type="button"
            className="h-8 border border-neutral-900 bg-neutral-900 px-3 text-xs font-semibold text-white hover:bg-neutral-700"
            onClick={() => window.print()}
          >
            Print / Save as PDF
          </button>
        </div>
      </div>

      <article className="mx-auto max-w-[820px] bg-white px-10 py-9 text-neutral-900 shadow-lg print:max-w-none print:p-0 print:shadow-none">
        <header className="border-b-2 border-neutral-900 pb-3">
          <p className="text-[10px] font-semibold tracking-[0.25em] text-neutral-600">AEROLAB</p>
          <h1 className="mt-1 text-xl font-bold">AeroLab Simulation Report</h1>
          <p className="mt-1 text-[11px] text-neutral-700">
            {experiment.name} · {experiment.vehicleName} · generated {new Date().toLocaleString()}
          </p>
          <p className="mt-2 border border-neutral-400 bg-neutral-100 px-2 py-1.5 text-[11px] leading-snug text-neutral-800">
            <strong>
              {mode.short} · {mode.name}.
            </strong>{" "}
            {aero.provenance} Results are model estimates with the uncertainty stated below, not measurements.
          </p>
        </header>

        <Heading number={1}>Configuration</Heading>
        <KeyValues
          rows={[
            ["Experiment", `#${String(experiment.number).padStart(3, "0")} · ${experiment.name}`],
            ["Project", experiment.projectName],
            imported
              ? [
                  "Vehicle",
                  `${experiment.vehicleName}: imported 3D model (${imported.fileName}, ${imported.triangles.toLocaleString("en-US")} triangles). ` +
                    (config.bodyId
                      ? `Solved on its outer envelope sampled every ${Math.round(imported.resolution * 1000)} mm; mirrors, gaps, intakes and underbody detail are not resolved. `
                      : "A shape parameter was changed, so this run used the parametric shape fitted to the model, not its envelope. ") +
                    "The accuracy of the model itself is not verified.",
                ]
              : realCar
              ? [
                  "Vehicle",
                  `${experiment.vehicleName}: parametric look-alike built from published dimensions and estimated proportions, not the manufacturer's surfaces`,
                ]
              : ["Base vehicle class", `${experiment.vehicleName} (generic; approximate reference Cd ${config.reference.cd.toFixed(2)}, Cl ${config.reference.cl.toFixed(2)})`],
            ...(imported
              ? ([
                  [
                    "3D model source",
                    [imported.source.title, imported.source.author && `by ${imported.source.author}`, imported.source.licence && `licence: ${imported.source.licence}`, imported.source.url]
                      .filter(Boolean)
                      .join(" · ") || "not recorded",
                  ],
                  ...(realCar ? [] : [["Calibration anchor", `${imported.anchorClassName} class (generic; approximate reference Cd ${config.reference.cd.toFixed(2)}, Cl ${config.reference.cl.toFixed(2)})`]]),
                ] as [string, string][])
              : []),
            ...(realCar
              ? ([
                  ["Calibration anchor", `${realCar.anchorClassName} class (generic; approximate reference Cd ${config.reference.cd.toFixed(2)}, Cl ${config.reference.cl.toFixed(2)})`],
                  [
                    "Published Cd",
                    realCar.published.cd === null
                      ? `not available. ${realCar.published.cdNote}`
                      : `${realCar.published.cd.toFixed(3)} (not used by the model; this run: ${aero.coefficients.cd.toFixed(3)}). ${realCar.published.cdNote}`,
                  ],
                ] as [string, ReactNode][])
              : []),
            ["Run on", new Date(experiment.createdAt).toLocaleString()],
            ["Mass", formatWithUnit(system, "mass", spec.mass)],
            ["Driven wheels / weight on front axle", `${spec.drivetrain} / ${(spec.weightDistFront * 100).toFixed(0)} %`],
            ["Rolling resistance coefficient / tyre friction", `${spec.crr.toFixed(4)} / ${spec.tireMu.toFixed(2)}`],
            [
              "Powertrain",
              powertrain.type === "EV"
                ? `Electric · ${formatWithUnit(system, "power", powertrain.peakPowerW)} · ${powertrain.peakTorqueNm.toFixed(0)} N·m · ratio ${powertrain.gearRatio.toFixed(2)}`
                : `ICE · ${formatWithUnit(system, "power", powertrain.peakPowerW)} @ ${powertrain.peakPowerRpm} rpm · ${powertrain.peakTorqueNm.toFixed(0)} N·m · ${powertrain.gearRatios.length} gears${powertrain.powerCurve ? " · user-defined power curve" : ""}`,
            ],
          ]}
        />

        <Heading number={2}>Geometry</Heading>
        <ProfileDrawing
          theme="light"
          className="mb-2 h-[130px] w-full"
          ariaLabel="Side profile of the simulated geometry over the class reference"
          layers={[
            { geometry: config.referenceGeometry, color: "#9ca3af", dashed: true },
            { geometry: config.geometry, color: "#111827" },
          ]}
        />
        <p className="mb-2 text-[10px] text-neutral-600">
          Solid: simulated geometry. Dashed: {realCar ? `${realCar.anchorClassName} class geometry (calibration anchor)` : "class reference geometry"}.
        </p>
        {/* CSS columns, not a grid: a grid stretches the short tables to the height of the tallest one. */}
        <div className="columns-2 gap-x-8">
          {PARAM_GROUPS.map((group) => (
            <table key={group.id} className="print-avoid-break mb-3 w-full break-inside-avoid border-collapse text-[10.5px]">
              <caption className="mb-0.5 text-left font-semibold text-neutral-800">{group.label}</caption>
              <tbody>
                {PARAM_DEFINITIONS.filter((definition) => definition.group === group.id).map((definition) => {
                  const value = config.geometry[definition.id];
                  const changed = Math.abs(value - baseGeometry[definition.id]) > definition.step * 1e-3;
                  return (
                    <tr key={definition.id} className="border-b border-neutral-200">
                      <td className="py-[1.5px] text-neutral-700">{definition.label}</td>
                      <td className={`py-[1.5px] text-right font-mono tabular-nums ${changed ? "font-bold" : ""}`}>
                        {formatParam(system, definition.id, value)}
                        {changed ? " *" : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
        </div>
        <p className="text-[10px] text-neutral-600">
          * modified from {realCar ? "the look-alike as defined in the library" : "the class reference geometry"}.
        </p>
        <div className="mt-2">
          <KeyValues
            rows={[
              ["Overall length × height", `${formatWithUnit(system, "length", aero.metrics.length)} × ${formatWithUnit(system, "length", aero.metrics.overallHeight)}`],
              ["Frontal area (computed from geometry)", formatWithUnit(system, "area", aero.metrics.frontalArea)],
              ["Ground clearance", formatWithUnit(system, "length", aero.metrics.groundClearance)],
              ["Effective rear slope", `${aero.metrics.effectiveSlantDeg.toFixed(1)} °`],
            ]}
          />
        </div>

        <Heading number={3}>Environment</Heading>
        <KeyValues
          rows={[
            ["Vehicle speed", formatWithUnit(system, "speed", config.speed)],
            ["Air temperature", formatWithUnit(system, "temperature", env.temperature)],
            ["Air pressure / relative humidity", env.airDensityMode === "direct" ? "not used (density entered directly)" : `${formatWithUnit("si", "pressure", env.pressure)} / ${(env.humidity * 100).toFixed(0)} %`],
            ["Air density", `${aero.air.density.toFixed(4)} kg/m³ (${env.airDensityMode === "direct" ? "entered directly" : "computed from T, p, RH"})`],
            ["Ambient wind", env.windSpeed > 0.05 ? `${formatWithUnit(system, "speed", env.windSpeed)} at ${env.windAngle.toFixed(0)}° (0° = headwind)` : "none"],
            ["Relative air speed / yaw angle", `${formatWithUnit(system, "speed", aero.wind.relativeSpeed)} / ${aero.wind.yawAngleDeg.toFixed(1)} °`],
            ["Road gradient", `${env.gradient.toFixed(1)} ° (${gradientPercent(env.gradient).toFixed(1)} %)`],
            ["Dynamic pressure / Reynolds number", `${f.dynamicPressure.toFixed(0)} Pa / ${aero.air.reynolds.toExponential(2)}`],
          ]}
        />

        <Heading number={4}>Simulation Method</Heading>
        <KeyValues
          rows={[
            ["Mode", `${mode.short} · ${mode.name}`],
            ["Source", SOURCE_LABELS[aero.source]],
            ["Model version", MODEL_VERSION],
            ["Grid fidelity setting", config.fidelity],
            ...(aero.solver
              ? ([
                  ["Grid", `${aero.solver.gridSize.join(" × ")} = ${aero.solver.cells.toLocaleString()} cells (${aero.solver.fluidCells.toLocaleString()} fluid)`],
                  ["Linear solve", `${aero.solver.iterations} CG iterations, residual ${aero.solver.residual.toExponential(1)}${aero.solver.converged ? "" : " (NOT converged)"}`],
                  ["Uncalibrated Cd / Cl", `${aero.solver.rawCd.toFixed(3)} / ${formatSigned(aero.solver.rawCl, 3)}`],
                ] as [string, ReactNode][])
              : []),
            ...(aero.cfd
              ? ([
                  ["Solver", `OpenFOAM ${aero.cfd.openfoamVersion} simpleFoam, steady RANS, k-omega SST, ${aero.cfd.processors} process(es)`],
                  [
                    "Mesh",
                    `${aero.cfd.meshSetting} setting · ${aero.cfd.cells === null ? "cell count not read" : `${aero.cfd.cells.toLocaleString()} cells`} · surface cells ${aero.cfd.surfaceCellMm[0].toFixed(0)}–${aero.cfd.surfaceCellMm[1].toFixed(0)} mm · ${aero.cfd.prismLayers === 0 ? "no prism layers" : `${aero.cfd.prismLayers} prism layers`}`,
                  ],
                  [
                    "Mesh checks",
                    aero.cfd.meshChecksFailed === null ? "report not read" : aero.cfd.meshChecksFailed === 0 ? "passed" : `${aero.cfd.meshChecksFailed} FAILED`,
                  ],
                  [
                    "y+ on the body",
                    aero.cfd.yPlusBody
                      ? `average ${aero.cfd.yPlusBody.average.toFixed(0)} (${aero.cfd.yPlusBody.min.toFixed(0)} to ${aero.cfd.yPlusBody.max.toFixed(0)}); wall functions are meant for 30 to 300`
                      : "not read",
                  ],
                  [
                    "Iterations",
                    `${aero.cfd.iterations} of ${aero.cfd.iterationLimit}${aero.cfd.settledAt ? " (stopped: Cd and Cl settled)" : ""} · residual targets ${aero.cfd.residualTargetsMet ? "met" : "NOT met"} · ${formatDuration(aero.cfd.wallTimeS)}`,
                  ],
                ] as [string, ReactNode][])
              : []),
            ...(aero.surrogate
              ? ([
                  ["Surrogate", `${aero.surrogate.algorithm}, ${aero.surrogate.trainingSamples} samples from ${MODE_LABELS[aero.surrogate.sourceMode].name}`],
                  ["Validation RMSE Cd / Cl", `${aero.surrogate.validationRmseCd.toFixed(4)} / ${aero.surrogate.validationRmseCl.toFixed(4)}`],
                  ["Validation R² Cd / Cl", `${aero.surrogate.validationR2Cd.toFixed(3)} / ${aero.surrogate.validationR2Cl.toFixed(3)}`],
                ] as [string, ReactNode][])
              : []),
            ["Reference calibration offsets", `ΔCd ${formatSigned(aero.calibration.cdOffset, 4)}, ΔCl ${formatSigned(aero.calibration.clOffset, 4)}`],
          ]}
        />
        <p className="mt-2 text-[11px] leading-snug text-neutral-700">{aero.provenance}</p>

        <Heading number={5}>Aerodynamic Results</Heading>
        <div className="grid grid-cols-4 gap-2">
          {[
            ["Cd", `${c.cd.toFixed(3)} ± ${aero.uncertainty.cd.toFixed(3)}`],
            ["Cl", `${formatSigned(c.cl, 3)} ± ${aero.uncertainty.cl.toFixed(3)}`],
            ["Drag", formatWithUnit(system, "force", f.drag)],
            [f.lift < 0 ? "Downforce" : "Lift", formatWithUnit(system, "force", Math.abs(f.lift))],
          ].map(([label, value]) => (
            <div key={label} className="border border-neutral-400 px-2 py-1.5">
              <div className="text-[9px] tracking-wider text-neutral-600 uppercase">{label}</div>
              <div className="font-mono text-[15px] font-semibold tabular-nums">{value}</div>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-neutral-600">
          {UNCERTAINTY_NOTES[aero.mode]} They are not measurement error bars.
        </p>
        <div className="mt-2">
          <KeyValues
            rows={[
              ["Cl front / rear", `${formatSigned(c.clFront, 3)} / ${formatSigned(c.clRear, 3)}`],
              ["Drag area CdA", `${(c.cd * c.frontalArea).toFixed(3)} m²`],
              ["Aerodynamic efficiency −Cl/Cd", formatSigned(-c.cl / c.cd, 2)],
              ["Side force / yaw moment", `${formatWithUnit(system, "force", f.side)} / ${formatWithUnit(system, "moment", f.yawMoment)}`],
              ["Base pressure coefficient", formatSigned(aero.rearFlow.basePressureCoefficient, 3)],
              ["Upper-surface separation at", `x = ${formatWithUnit(system, "length", aero.rearFlow.separationX)} (separated fraction of rear window ${(aero.rearFlow.separationFraction * 100).toFixed(0)} %)`],
            ]}
          />
        </div>
        <div className="mt-3 grid grid-cols-2 items-start gap-x-8">
          <BreakdownTable title="Drag coefficient build-up" items={aero.breakdown.drag} />
          <BreakdownTable title="Lift coefficient build-up" items={aero.breakdown.lift} />
        </div>
        {aero.warnings.length > 0 && (
          <div className="print-avoid-break mt-3 border border-neutral-500 px-2 py-1.5">
            <p className="text-[11px] font-semibold">Warnings</p>
            <ul className="mt-0.5 list-disc pl-4 text-[11px] leading-snug">
              {aero.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          </div>
        )}

        <Heading number={6}>Vehicle Performance</Heading>
        <KeyValues
          rows={[
            ["Estimated top speed", `${formatWithUnit(system, "speed", experiment.performance.topSpeed)} (${experiment.performance.topSpeedLimit}-limited)`],
            ...experiment.performance.accelTimes.map<[string, ReactNode]>((entry) => [
              `0–${entry.target} km/h`,
              entry.time === null ? "not reached" : `${entry.time.toFixed(1)} s`,
            ]),
            ["Power required at 100 / 200 km/h", `${formatWithUnit(system, "power", experiment.performance.power100)} / ${formatWithUnit(system, "power", experiment.performance.power200)}`],
            ["Maximum gradient held at 30 km/h", `${experiment.performance.maxGradeDeg.toFixed(1)} °`],
            ["Acceleration traction-limited", experiment.performance.tractionLimited ? "yes, during part of the run" : "no"],
            ...(experiment.performance.rangeAt100 !== null
              ? ([["Steady range at 100 km/h", formatWithUnit(system, "distance", experiment.performance.rangeAt100)]] as [string, ReactNode][])
              : []),
            [
              `Forces at ${formatWithUnit(system, "speed", config.speed)}`,
              `drag ${formatWithUnit(system, "force", experiment.performance.forcesAtSpeed.drag)}, rolling ${formatWithUnit(system, "force", experiment.performance.forcesAtSpeed.rolling)}, grade ${formatWithUnit(system, "force", experiment.performance.forcesAtSpeed.grade)}, total ${formatWithUnit(system, "force", experiment.performance.forcesAtSpeed.total)}`,
            ],
          ]}
        />
        {performance && (
          <div className="mt-3 grid grid-cols-2 gap-4">
            <ReportChart
              title="Resisting forces versus speed"
              xLabel={`Vehicle speed (${speedUnit.label})`}
              yLabel={`Force (${forceUnit.label})`}
              series={[
                { label: "Aerodynamic drag", points: performance.speedSweep.map((s) => ({ x: speedUnit.toDisplay(s.speed), y: forceUnit.toDisplay(s.drag) })) },
                { label: "Rolling", points: performance.speedSweep.map((s) => ({ x: speedUnit.toDisplay(s.speed), y: forceUnit.toDisplay(s.rolling) })) },
                { label: "Total", points: performance.speedSweep.map((s) => ({ x: speedUnit.toDisplay(s.speed), y: forceUnit.toDisplay(s.drag + s.rolling + s.grade) })), dashed: true },
              ]}
            />
            <ReportChart
              title="Power at the wheels versus speed"
              xLabel={`Vehicle speed (${speedUnit.label})`}
              yLabel={`Power (${powerUnit.label})`}
              series={[
                { label: "Required", points: performance.speedSweep.map((s) => ({ x: speedUnit.toDisplay(s.speed), y: powerUnit.toDisplay(s.powerRequired) })) },
                { label: "Available", points: performance.speedSweep.map((s) => ({ x: speedUnit.toDisplay(s.speed), y: powerUnit.toDisplay(s.powerAvailable) })), dashed: true },
              ]}
            />
            <ReportChart
              title="Speed versus time (full throttle)"
              xLabel="Time (s)"
              yLabel={`Speed (${speedUnit.label})`}
              series={[{ label: "Speed", points: performance.accelTrace.map((s) => ({ x: s.time, y: speedUnit.toDisplay(s.speed) })) }]}
            />
            <ReportChart
              title="Downforce versus speed"
              xLabel={`Vehicle speed (${speedUnit.label})`}
              yLabel={`Downforce (${forceUnit.label})`}
              series={[{ label: "Downforce", points: performance.speedSweep.map((s) => ({ x: speedUnit.toDisplay(s.speed), y: forceUnit.toDisplay(s.downforce) })) }]}
            />
          </div>
        )}

        <Heading number={7}>Comparison</Heading>
        {baseline ? (
          <>
            <table className="print-avoid-break w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-neutral-500 text-left">
                  <th className="py-[2px] font-semibold">Quantity</th>
                  <th className="py-[2px] text-right font-semibold">Baseline: {baseline.name}</th>
                  <th className="py-[2px] text-right font-semibold">This run: {experiment.name}</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON_METRICS.map((row, index) => (
                  <tr key={row.label} className="border-b border-neutral-200">
                    <td className="py-[2px] text-neutral-700">{row.label}</td>
                    <td className="py-[2px] text-right font-mono tabular-nums">{metricCell(system, baseline, index)}</td>
                    <td className="py-[2px] text-right font-mono tabular-nums">{metricCell(system, experiment, index)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[10px] text-neutral-600">
              Baseline: {MODE_LABELS[baseline.aero.mode].short} · {describeConditions(system, baseline)}.
              {baseline.aero.mode !== aero.mode ? " The two runs use different simulation modes; differences partly reflect the models." : ""}
            </p>
          </>
        ) : (
          <p className="text-[11px] text-neutral-700">No baseline experiment was available for comparison.</p>
        )}

        <Heading number={8}>Sensitivity Analysis</Heading>
        <p className="mb-1.5 text-[11px] leading-snug text-neutral-700">
          One-at-a-time changes about this geometry, evaluated with the Mode A analytical model at the same conditions.
          They indicate which parameters the model is most sensitive to; they are not validated gradients.
        </p>
        {sensitivity.length > 0 ? (
          <table className="print-avoid-break w-full border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-neutral-500 text-left">
                <th className="py-[2px] font-semibold">Parameter</th>
                <th className="py-[2px] text-right font-semibold">Change applied</th>
                <th className="py-[2px] text-right font-semibold">ΔCd</th>
                <th className="py-[2px] text-right font-semibold">ΔCl</th>
              </tr>
            </thead>
            <tbody>
              {sensitivity.map((row) => {
                const definition = PARAM_BY_ID[row.id];
                const unit = unitOf(system, quantityOfParam(definition.kind));
                const change =
                  definition.kind === "ratio"
                    ? formatSigned(row.delta, 2)
                    : `${formatSigned(unit.toDisplay(row.delta) - unit.toDisplay(0), unit.decimals)} ${unit.label}`;
                return (
                  <tr key={row.id} className="border-b border-neutral-200">
                    <td className="py-[2px] text-neutral-700">{definition.label}</td>
                    <td className="py-[2px] text-right font-mono tabular-nums">{change}</td>
                    <td className="py-[2px] text-right font-mono tabular-nums">{formatSigned(row.dCd, 4)}</td>
                    <td className="py-[2px] text-right font-mono tabular-nums">{formatSigned(row.dCl, 4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-[11px] text-neutral-700">Sensitivities could not be evaluated for this configuration.</p>
        )}

        <Heading number={9}>Assumptions</Heading>
        <p className="text-[11px] font-semibold">Aerodynamic model</p>
        <ul className="mt-0.5 list-disc pl-4 text-[11px] leading-snug">
          {aero.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        {performance && (
          <>
            <p className="mt-2 text-[11px] font-semibold">Vehicle-performance model</p>
            <ul className="mt-0.5 list-disc pl-4 text-[11px] leading-snug">
              {performance.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </>
        )}

        <Heading number={10}>Limitations</Heading>
        <ul className="list-disc pl-4 text-[11px] leading-snug">
          {LIMITATIONS.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>

        <footer className="mt-6 border-t border-neutral-400 pt-2 text-[9px] text-neutral-600">
          AeroLab · model version {MODEL_VERSION} · generic vehicle classes with approximate reference values · not for certification or safety-critical use.
        </footer>
      </article>
    </div>
  );
}
