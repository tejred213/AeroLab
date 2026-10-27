"use client";

import type { ReactNode } from "react";
import { WindDiagram } from "@/components/controls/EnvironmentPanel";
import { Badge, Section, Unavailable } from "@/components/ui/Layout";
import { InfoTip } from "@/components/ui/Tooltip";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import type { AeroResult, BreakdownItem, PerformanceResult, RealCarInfo, ResultSource, SimulationMode, SimWarning } from "@/lib/types";
import { GLOSSARY, type GlossaryKey } from "@/lib/utils/glossary";
import { formatNumber, formatSigned, formatValue, formatWithUnit, unitOf } from "@/lib/utils/units";
import { resistances } from "@/lib/vehicle/performance";
import { makePerformanceInput } from "@/lib/simulation/config";
import { diffGeometry } from "@/lib/geometry/parameters";
import { findVehicle } from "@/lib/vehicle/library";

export const MODE_LABELS: Record<SimulationMode, { short: string; name: string; tone: "data" | "accent" | "ok" | "warn" }> = {
  analytical: { short: "Mode A", name: "Analytical", tone: "data" },
  "reduced-order": { short: "Mode B", name: "Reduced-order", tone: "accent" },
  cfd: { short: "Mode C", name: "CFD", tone: "ok" },
  "ml-surrogate": { short: "Mode D", name: "ML surrogate", tone: "warn" },
};

export const SOURCE_LABELS: Record<ResultSource, string> = {
  browser: "Computed in browser",
  backend: "Computed on backend",
  imported: "Imported from solver file",
};

/** States which model produced a result; shown wherever numbers are displayed. */
export function ProvenanceBadge({ aero }: { aero: Pick<AeroResult, "mode" | "source"> }) {
  const mode = MODE_LABELS[aero.mode];
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={mode.tone}>
        {mode.short} · {mode.name}
      </Badge>
      <Badge>{SOURCE_LABELS[aero.source]}</Badge>
    </span>
  );
}

interface FigureProps {
  label: string;
  value: string;
  unit?: string;
  detail?: ReactNode;
  tip: GlossaryKey;
}

/** The one figure the panel leads with. */
function HeadlineFigure({ label, value, detail, tip }: FigureProps) {
  return (
    <div className="pb-4">
      <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
        {label}
        <InfoTip content={GLOSSARY[tip]} label={label} />
      </div>
      <div className="mt-1.5 flex items-baseline gap-2.5">
        <span className="num text-[44px] leading-none font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">{value}</span>
        {detail && <span className="num text-sm text-ink-2">{detail}</span>}
      </div>
    </div>
  );
}

/** A key figure: what it is and its supporting value on the left, the figure itself on the right. */
function KeyFigure({ label, value, unit, detail, tip }: FigureProps) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
          {label}
          <InfoTip content={GLOSSARY[tip]} label={label} />
        </div>
        {detail && <div className="num mt-0.5 text-xs text-ink-3">{detail}</div>}
      </div>
      <div className="shrink-0 text-right whitespace-nowrap">
        <span className="num text-[22px] leading-none font-semibold tracking-[-0.01em] text-ink">{value}</span>
        {unit && <span className="ml-1 text-xs text-ink-3">{unit}</span>}
      </div>
    </div>
  );
}

function Row({ label, value, tip }: { label: string; value: ReactNode; tip?: GlossaryKey }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[5px]">
      <span className="flex min-w-0 items-center gap-1.5 self-center text-[13px] text-ink-2">
        <span className="truncate">{label}</span>
        {tip && <InfoTip content={GLOSSARY[tip]} label={label} />}
      </span>
      <span className="num shrink-0 text-right text-[13px] font-medium text-ink">{value}</span>
    </div>
  );
}

/** Paragraph of explanation under a group of figures. */
function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs leading-relaxed text-ink-3 ${className}`}>{children}</p>;
}

function WarningList({ warnings }: { warnings: SimWarning[] }) {
  if (warnings.length === 0) return <Note>No warnings for this configuration.</Note>;
  return (
    <ul className="space-y-1.5">
      {warnings.map((warning) => {
        const info = warning.severity === "info";
        return (
          <li key={warning.code} className={`flex gap-2.5 rounded-lg px-3 py-2.5 text-xs leading-relaxed ${info ? "bg-data/8" : "bg-warn/10"}`}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className={`mt-0.5 shrink-0 ${info ? "text-data" : "text-warn"}`}>
              {info ? (
                <>
                  <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M7 6.2v3.8M7 3.9v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </>
              ) : (
                <>
                  <path d="M7 1.6 13 12.2H1Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M7 5.6v3M7 10.3v.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </>
              )}
            </svg>
            <span className="text-ink">
              <span className={`mr-1 font-semibold ${info ? "text-data" : "text-warn"}`}>{info ? "Note" : "Warning"}</span>
              {warning.message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Signed horizontal bars for a coefficient build-up, with the numbers alongside. */
export function BreakdownBars({ items, total }: { items: BreakdownItem[]; total: number }) {
  const visible = items.filter((item) => Math.abs(item.value) > 5e-5);
  const largest = Math.max(...visible.map((item) => Math.abs(item.value)), 1e-6);
  return (
    <div>
      {visible.map((item) => {
        const width = (Math.abs(item.value) / largest) * 50;
        return (
          <div key={item.id} className="grid grid-cols-[1fr_76px_58px] items-center gap-2.5 py-1">
            <span className="truncate text-xs text-ink-2" title={item.label}>
              {item.label}
            </span>
            <span className="relative h-2.5" aria-hidden>
              <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
              <span
                className={`absolute inset-y-[2px] ${item.value >= 0 ? "rounded-r-full bg-data" : "rounded-l-full bg-accent"}`}
                style={item.value >= 0 ? { left: "50%", width: `${width}%` } : { right: "50%", width: `${width}%` }}
              />
            </span>
            <span className="num text-right text-xs text-ink">{formatSigned(item.value, 4)}</span>
          </div>
        );
      })}
      <div className="mt-1.5 grid grid-cols-[1fr_76px_58px] gap-2.5 border-t border-line pt-2">
        <span className="text-xs font-semibold text-ink">Total</span>
        <span />
        <span className="num text-right text-xs font-semibold text-ink">{formatSigned(total, 4)}</span>
      </div>
    </div>
  );
}

function PerformanceRows({ performance }: { performance: PerformanceResult }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const speedUnit = unitOf(system, "speed");
  const limit: Record<PerformanceResult["topSpeedLimit"], string> = {
    power: "power-limited",
    redline: "rev-limited (redline)",
    "motor-rpm": "motor-speed-limited",
    none: "above model range",
  };
  return (
    <>
      {performance.accelTimes.map((entry) => (
        <Row
          key={entry.target}
          label={`0–${speedUnit.toDisplay(entry.target / 3.6).toFixed(0)} ${speedUnit.label}`}
          value={entry.time === null ? "not reached" : `${entry.time.toFixed(1)} s`}
          tip={entry.target === 100 ? "accel" : undefined}
        />
      ))}
      <Row label="Top speed limit" value={limit[performance.topSpeedLimit]} />
      <Row label="Max gradient @ 30 km/h" value={`${performance.maxGradeDeg.toFixed(1)} °`} tip="maxGrade" />
      {performance.rangeAt100 !== null && (
        <Row label="Range @ 100 km/h" value={formatWithUnit(system, "distance", performance.rangeAt100)} tip="range" />
      )}
    </>
  );
}

/** For a production-car look-alike: the model's prediction next to the published figure it never saw. */
function PublishedComparison({ vehicleName, info, aero, modified }: { vehicleName: string; info: RealCarInfo; aero: AeroResult; modified: boolean }) {
  const { published } = info;
  const predicted = aero.coefficients.cd;
  const difference = published.cd === null ? null : predicted - published.cd;
  const sigmas = difference === null || aero.uncertainty.cd <= 0 ? null : Math.abs(difference) / aero.uncertainty.cd;
  const areaError = published.frontalArea === null ? null : (aero.coefficients.frontalArea - published.frontalArea) / published.frontalArea;
  const comparable = aero.mode === "analytical" || aero.mode === "reduced-order";
  return (
    <Section title="Compared with the published figure">
      {published.cd === null ? (
        <Note className="text-ink-2">No published drag coefficient to compare with. {published.cdNote}</Note>
      ) : (
        <>
          <Row label="Published Cd" value={formatNumber(published.cd, 3)} />
          <Row label="This model" value={`${formatNumber(predicted, 3)} ± ${formatNumber(aero.uncertainty.cd, 3)}`} />
          <Row
            label="Difference"
            value={`${formatSigned(difference, 3)}${sigmas === null ? "" : ` · ${sigmas < 0.05 ? "0.0" : sigmas.toFixed(1)} σ`}`}
          />
        </>
      )}
      {areaError !== null && (
        <Row
          label="Frontal area vs published"
          value={`${formatNumber(aero.coefficients.frontalArea, 2)} vs ${formatNumber(published.frontalArea, 2)} m² (${formatSigned(areaError * 100, 1)} %)`}
        />
      )}
      {published.cd !== null && <Note className="mt-2">{published.cdNote}</Note>}
      <Note className="mt-1.5">
        {modified
          ? `The geometry has been edited, so this is no longer the ${vehicleName} look-alike; the published figure describes the unmodified car.`
          : comparable
            ? `The prediction starts from the ${info.anchorClassName} class and adds the modelled effect of this shape; the published figure is not an input. The shape is a simplified look-alike with estimated proportions, so the difference measures the model and the look-alike together.`
            : aero.mode === "cfd"
              ? "Mode C is CFD of the simplified look-alike, without the class calibration. It is not a prediction of the production car and is expected to differ from the published figure."
              : "Mode D reproduces the model it was trained on; compare Mode A or Mode B with the published figure instead."}
      </Note>
    </Section>
  );
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds.toFixed(0)} s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** What the ± values of each mode do and do not cover. */
export const UNCERTAINTY_NOTES: Record<SimulationMode, string> = {
  analytical: "± values: uncertainty reflects model assumptions of the semi-empirical correlations.",
  "reduced-order": "± values: uncertainty reflects model assumptions and reduced-order approximation.",
  cfd: "± values: iteration scatter of the solver's force coefficients and their drift between averaging windows. Mesh and turbulence-model error are not included.",
  "ml-surrogate":
    "± values: held-out validation error and disagreement between the fitted regressors, combined with the uncertainty of the model that produced the training data.",
};

export function ResultsPanel({ stale }: { stale: boolean }) {
  const result = useSimStore((state) => state.result);
  const performance = useSimStore((state) => state.performance);
  const error = useSimStore((state) => state.error);
  const spec = useSimStore((state) => state.spec);
  const powertrain = useSimStore((state) => state.powertrain);
  const system = useSettingsStore((state) => state.unitSystem);
  const experimentId = useSimStore((state) => state.resultExperimentId);
  const customVehicles = useSimStore((state) => state.customVehicles);

  if (!result) {
    return (
      <div className="p-4">
        {error ? (
          <ErrorBox code={error.code} message={error.message} />
        ) : (
          <Unavailable>
            No results yet. Set the geometry and conditions, then press <strong className="text-ink">Run</strong>. Nothing
            is computed until you do.
          </Unavailable>
        )}
      </div>
    );
  }

  const { aero, config } = result;
  const c = aero.coefficients;
  const f = aero.forces;
  const isDownforce = f.lift < 0;
  const cdTotal = aero.breakdown.drag.reduce((sum, item) => sum + item.value, 0);
  const clTotal = aero.breakdown.lift.reduce((sum, item) => sum + item.value, 0);
  const yawed = Math.abs(aero.wind.yawAngleDeg) > 0.05;
  const vehicle = findVehicle(config.vehicleId, customVehicles);
  const realCar = vehicle?.realCar ?? null;
  // The published figure describes the car as built; an edited geometry is a different shape.
  const modified = vehicle ? diffGeometry(vehicle.geometry, config.geometry).length > 0 : false;
  // Modes C and D report coefficients only; the rear-flow figures are still the empirical closure.
  const rearFlowIsEstimate = aero.mode === "cfd" || aero.mode === "ml-surrogate";

  const input = makePerformanceInput(spec, powertrain, config.geometry, c, aero.air.density, config.environment, config.speed);
  const powerAt = (kmh: number) => {
    const v = kmh / 3.6;
    return resistances(input, v).total * v;
  };
  const allWarnings: SimWarning[] = [...aero.warnings];
  if (performance?.tractionLimited) {
    allWarnings.push({
      code: "TRACTION_LIMITED",
      severity: "warning",
      message: "Vehicle performance is traction-limited: during part of the acceleration the tyres cannot transmit the available drive force.",
    });
  }

  return (
    <div className={stale ? "opacity-60" : ""}>
      {error && (
        <div className="border-b border-line p-4">
          <ErrorBox code={error.code} message={error.message} />
        </div>
      )}
      {/* Which model produced the numbers comes first, directly over the numbers. */}
      <div className="border-b border-line px-4 pt-3.5">
        <div className="mb-3.5">
          <ProvenanceBadge aero={aero} />
        </div>
        <HeadlineFigure label="Drag coefficient (Cd)" value={formatNumber(c.cd, 3)} detail={`± ${formatNumber(aero.uncertainty.cd, 3)}`} tip="cd" />
        <KeyFigure
          label="Drag"
          value={formatValue(system, "force", f.drag)}
          unit={unitOf(system, "force").label}
          detail={`CdA ${formatNumber(c.cd * c.frontalArea, 3)} m²`}
          tip="drag"
        />
        <KeyFigure
          label={isDownforce ? "Downforce" : "Lift"}
          value={formatValue(system, "force", Math.abs(f.lift))}
          unit={unitOf(system, "force").label}
          detail={`Cl ${formatSigned(c.cl, 3)} ± ${formatNumber(aero.uncertainty.cl, 3)}`}
          tip={isDownforce ? "downforce" : "lift"}
        />
        <KeyFigure
          label="Top speed"
          value={performance ? formatValue(system, "speed", performance.topSpeed) : "—"}
          unit={unitOf(system, "speed").label}
          detail={performance ? `0–100: ${performance.accelTimes.find((entry) => entry.target === 100)?.time?.toFixed(1) ?? "n/a"} s` : ""}
          tip="topSpeed"
        />
      </div>

      <div className="border-b border-line px-4 py-3.5">
        <p className="text-xs leading-relaxed text-ink-2">{aero.provenance}</p>
        <p className="num mt-1.5 text-xs text-ink-3">
          {aero.source === "imported"
            ? "imported, not computed by AeroLab"
            : result.cached
              ? "cached result"
              : `computed in ${result.durationMs < 1000 ? `${result.durationMs.toFixed(0)} ms` : result.durationMs < 90000 ? `${(result.durationMs / 1000).toFixed(2)} s` : formatDuration(result.durationMs / 1000)}`}
          {" · "}at {formatWithUnit(system, "speed", config.speed)}
        </p>
        {experimentId && (
          <a
            href={`/report?id=${experimentId}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2.5 inline-flex h-7 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-xs font-medium text-ink transition-colors hover:border-ink-3/70 hover:bg-raise"
          >
            Engineering report (PDF)
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
              <path d="M3 1.5h5.5V7M8.5 1.5 1.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        )}
      </div>

      {realCar && <PublishedComparison vehicleName={vehicle!.name} info={realCar} aero={aero} modified={modified} />}

      <Section title="Aerodynamics">
        <Row label="Cl (total)" value={`${formatSigned(c.cl, 3)} ± ${formatNumber(aero.uncertainty.cl, 3)}`} tip="cl" />
        <Row label="Cl front / rear" value={`${formatSigned(c.clFront, 3)} / ${formatSigned(c.clRear, 3)}`} tip="clFront" />
        <Row label="Efficiency −Cl/Cd" value={formatSigned(-c.cl / c.cd, 2)} tip="efficiency" />
        <Row label="Frontal area" value={formatWithUnit(system, "area", c.frontalArea)} tip="frontalArea" />
        <Row label="Dynamic pressure" value={formatWithUnit("si", "pressure", f.dynamicPressure)} tip="dynamicPressure" />
        <Row label="Reynolds number" value={aero.air.reynolds.toExponential(2)} tip="reynolds" />
        <Row
          label={rearFlowIsEstimate ? "Base pressure Cp (empirical est.)" : "Base pressure Cp"}
          value={formatSigned(aero.rearFlow.basePressureCoefficient, 3)}
          tip="basePressure"
        />
        <Row
          label={rearFlowIsEstimate ? "Separation at x (empirical est.)" : "Separation at x"}
          value={formatWithUnit(system, "length", aero.rearFlow.separationX)}
          tip="separation"
        />
        {rearFlowIsEstimate && (
          <Note className="mt-1.5">
            Base pressure and separation location come from AeroLab&apos;s empirical rear-flow correlation for this
            geometry, not from the {aero.mode === "cfd" ? "CFD solution" : "surrogate"}.
          </Note>
        )}
        <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-ink-3">
          <span className="mt-[3px] flex">
            <InfoTip content={GLOSSARY.uncertainty} label="uncertainty" />
          </span>
          <span>{UNCERTAINTY_NOTES[aero.mode]}</span>
        </p>
      </Section>

      {yawed && (
        <Section title="Crosswind">
          <WindDiagram windSpeed={config.environment.windSpeed} windAngle={config.environment.windAngle} speed={config.speed} />
          <div className="mt-1.5">
            <Row label="Yaw angle" value={`${aero.wind.yawAngleDeg.toFixed(1)} °`} tip="yawAngle" />
            <Row label="Side force" value={formatWithUnit(system, "force", f.side)} tip="sideForce" />
            <Row label="Yaw moment" value={formatWithUnit(system, "moment", f.yawMoment)} tip="yawMoment" />
            <Row label="Cs / Cn" value={`${formatSigned(c.cs, 3)} / ${formatSigned(c.cmYaw, 3)}`} tip="cs" />
          </div>
        </Section>
      )}

      <Section title="Vehicle performance">
        {performance ? (
          <>
            <Row label="Power @ 100 km/h" value={formatWithUnit(system, "power", powerAt(100))} tip="powerRequired" />
            <Row label="Power @ 200 km/h" value={formatWithUnit(system, "power", powerAt(200))} />
            <PerformanceRows performance={performance} />
          </>
        ) : (
          <Note>Performance not computed.</Note>
        )}
      </Section>

      <Section title={`Forces at ${formatWithUnit(system, "speed", config.speed)}`}>
        <Row label="Aerodynamic drag" value={formatWithUnit(system, "force", f.drag)} tip="drag" />
        {performance && (
          <>
            <Row label="Rolling resistance" value={formatWithUnit(system, "force", performance.forcesAtSpeed.rolling)} tip="rolling" />
            <Row label="Grade force" value={formatWithUnit(system, "force", performance.forcesAtSpeed.grade)} tip="grade" />
            <Row label="Total resistance" value={formatWithUnit(system, "force", performance.forcesAtSpeed.total)} tip="totalResistance" />
            <Row label="Power required" value={formatWithUnit(system, "power", performance.forcesAtSpeed.powerRequired)} tip="powerRequired" />
          </>
        )}
      </Section>

      <Section title="Warnings" actions={allWarnings.length > 0 ? <Badge tone="warn">{allWarnings.length}</Badge> : null}>
        <WarningList warnings={allWarnings} />
      </Section>

      <Section title="Cd build-up" collapsible defaultOpen={false}>
        <BreakdownBars items={aero.breakdown.drag} total={cdTotal} />
        <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-ink-3">
          <span className="mt-[3px] flex">
            <InfoTip content={GLOSSARY.calibration} label="reference calibration" />
          </span>
          <span>Model terms plus the offset that anchors the class reference.</span>
        </p>
      </Section>
      <Section title="Cl build-up" collapsible defaultOpen={false}>
        <BreakdownBars items={aero.breakdown.lift} total={clTotal} />
      </Section>

      {aero.solver && (
        <Section title="Solver diagnostics" collapsible defaultOpen={false}>
          <Row label="Grid" value={`${aero.solver.gridSize.join(" × ")} (${aero.solver.cells.toLocaleString()} cells)`} />
          <Row label="Fluid cells" value={aero.solver.fluidCells.toLocaleString()} />
          <Row label="CG iterations" value={String(aero.solver.iterations)} />
          <Row label="Residual" value={`${aero.solver.residual.toExponential(1)}${aero.solver.converged ? "" : " (not converged)"}`} />
          <Row label="Blockage ratio" value={`${(aero.solver.blockageRatio * 100).toFixed(1)} %`} tip="blockage" />
          <Row label="Raw Cd / Cl" value={`${formatNumber(aero.solver.rawCd, 3)} / ${formatSigned(aero.solver.rawCl, 3)}`} tip="calibration" />
        </Section>
      )}

      {aero.cfd && (
        <Section title="CFD run" collapsible defaultOpen>
          <Row label="Solver" value={`OpenFOAM ${aero.cfd.openfoamVersion} · simpleFoam`.replace("  ", " ")} />
          {aero.cfd.surface && (
            <Row
              label="Geometry"
              value={`wrapped 3D model · ${aero.cfd.surface.triangles.toLocaleString()} triangles${
                aero.cfd.surface.voxel ? ` · ${Math.round(aero.cfd.surface.voxel * 1000)} mm grid` : ""
              }`}
            />
          )}
          <Row label="Mesh setting" value={aero.cfd.meshSetting} />
          <Row label="Cells" value={aero.cfd.cells === null ? "not read" : aero.cfd.cells.toLocaleString()} />
          <Row label="Surface cell size" value={`${aero.cfd.surfaceCellMm[0].toFixed(0)}–${aero.cfd.surfaceCellMm[1].toFixed(0)} mm`} />
          <Row label="Prism layers" value={aero.cfd.prismLayers === 0 ? "none" : String(aero.cfd.prismLayers)} />
          <Row
            label="Mesh checks"
            value={aero.cfd.meshChecksFailed === null ? "not read" : aero.cfd.meshChecksFailed === 0 ? "passed" : `${aero.cfd.meshChecksFailed} failed`}
          />
          <Row
            label="y+ on body (average)"
            value={aero.cfd.yPlusBody ? `${aero.cfd.yPlusBody.average.toFixed(0)} · wall functions: 30–300` : "not read"}
          />
          <Row label="Iterations" value={`${aero.cfd.iterations} of ${aero.cfd.iterationLimit}${aero.cfd.settledAt ? " · stopped, Cd and Cl settled" : ""}`} />
          <Row label="Residual targets" value={aero.cfd.residualTargetsMet ? "met" : "not met"} />
          <Row label="Processes" value={String(aero.cfd.processors)} />
          <Row label="Run time" value={formatDuration(aero.cfd.wallTimeS)} />
          <p className="mono mt-2 text-[11px] leading-normal break-all text-ink-3">{aero.cfd.caseDir}</p>
        </Section>
      )}

      {aero.surrogate && (
        <Section title="Surrogate model" collapsible defaultOpen>
          <Row label="Algorithm" value={aero.surrogate.algorithm} />
          <Row label="Training samples" value={String(aero.surrogate.trainingSamples)} />
          <Row label="Trained on" value={MODE_LABELS[aero.surrogate.sourceMode].name} />
          <Row label="Validation RMSE Cd / Cl" value={`${aero.surrogate.validationRmseCd.toFixed(4)} / ${aero.surrogate.validationRmseCl.toFixed(4)}`} />
          <Row label="Validation R² Cd / Cl" value={`${aero.surrogate.validationR2Cd.toFixed(3)} / ${aero.surrogate.validationR2Cl.toFixed(3)}`} />
          <Row label="Inference time" value={`${aero.surrogate.inferenceTimeMs.toFixed(2)} ms`} />
        </Section>
      )}

      <Section title="Assumptions" collapsible defaultOpen={false}>
        <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-ink-2 marker:text-ink-3">
          {aero.assumptions.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        {performance && (
          <>
            <p className="label mt-3 mb-1.5">Vehicle-performance model</p>
            <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-ink-2 marker:text-ink-3">
              {performance.assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          </>
        )}
      </Section>
    </div>
  );
}

export function ErrorBox({ code, message }: { code: string; message: string }) {
  return (
    <div role="alert" className="rounded-lg border border-err/50 bg-err/10 px-3 py-2.5 text-xs leading-relaxed text-ink">
      <p className="mb-0.5 text-[11px] font-semibold tracking-wide text-err">{code.replaceAll("_", " ")}</p>
      {message}
    </div>
  );
}
