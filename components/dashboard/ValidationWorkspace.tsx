"use client";

import { type ReactNode, useEffect, useState } from "react";
import { ValidationChart } from "@/components/charts/ValidationChart";
import { ErrorBox } from "@/components/dashboard/ResultsPanel";
import { AppHeader } from "@/components/ui/AppHeader";
import { AppLink } from "@/components/ui/AppLink";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/Layout";
import { Tabs } from "@/components/ui/Tabs";
import { MODEL } from "@/lib/physics/model";
import { simulateLocal } from "@/lib/simulation/client";
import { summarizeValidation, validationConfig, validationRow, type ValidationRow, type ValidationSummary } from "@/lib/simulation/validation";
import { SimulationError } from "@/lib/types";
import { downloadCsv } from "@/lib/utils/export";
import { formatNumber, formatSigned } from "@/lib/utils/units";
import { REAL_CARS } from "@/lib/vehicle/library";

type ValidationMode = "analytical" | "reduced-order";

const MODE_NAMES: Record<ValidationMode, string> = {
  analytical: "Mode A · Analytical",
  "reduced-order": "Mode B · Reduced-order (coarse grid)",
};

/** Results are kept for the session, so switching pages does not recompute them. */
const computed = new Map<ValidationMode, ValidationRow[]>();

/** Published figure ascending; cars without one last. */
function ordered(rows: ValidationRow[]): ValidationRow[] {
  return [...rows].sort((a, b) => (a.publishedCd ?? Infinity) - (b.publishedCd ?? Infinity) || a.predictedCd - b.predictedCd);
}

function Tile({ label, value, detail }: { label: string; value: string; detail: ReactNode }) {
  return (
    <div className="rounded-2xl border border-line bg-panel px-5 py-4">
      <div className="text-[13px] text-ink-2">{label}</div>
      <div className="num mt-2 text-[28px] leading-none font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">{value}</div>
      <div className="mt-2.5 text-xs leading-relaxed text-ink-3">{detail}</div>
    </div>
  );
}

function Summary({ summary, total }: { summary: ValidationSummary; total: number }) {
  const better = summary.skill > 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Tile
        label="Mean absolute error"
        value={formatNumber(summary.meanAbsError, 3)}
        detail={
          <>
            in Cd, over {summary.count} of {total} cars. Using the class reference alone gives{" "}
            <span className="num text-ink-2">{formatNumber(summary.baselineMeanAbsError, 3)}</span>.
          </>
        }
      />
      <Tile
        label="Error versus the class alone"
        value={`${better ? "−" : "+"}${Math.abs(summary.skill * 100).toFixed(0)} %`}
        detail={better ? "error removed by modelling each car's shape, compared with assuming it is an average car of its class." : "The shape model does worse than assuming each car is an average car of its class."}
      />
      <Tile
        label="Bias"
        value={formatSigned(summary.bias, 3)}
        detail={Math.abs(summary.bias) < 0.003 ? "No systematic over- or under-prediction." : summary.bias > 0 ? "The model predicts too much drag on average." : "The model predicts too little drag on average."}
      />
      <Tile
        label="Inside the stated uncertainty"
        value={`${summary.withinOneSigma} / ${summary.withinTwoSigma}`}
        detail={`of ${summary.count} published figures lie within one / two times the model's stated ±. A well-calibrated uncertainty would give about ${Math.round(summary.count * 0.68)} and ${Math.round(summary.count * 0.95)}.`}
      />
      <Tile
        label="Largest miss"
        value={formatSigned(summary.largest.error, 3)}
        detail={`${summary.largest.name}. Rank correlation with the published order: ${formatNumber(summary.rankCorrelation, 2)}.`}
      />
    </div>
  );
}

function ResultTable({ rows }: { rows: ValidationRow[] }) {
  const headings = ["Car", "Class it starts from", "Published Cd", "Predicted Cd", "Difference", "Difference ÷ stated ±", "Frontal area: look-alike / published"];
  return (
    <div className="scroll-thin overflow-x-auto rounded-2xl border border-line bg-panel">
      <table className="w-full min-w-[860px] border-collapse">
        <caption className="sr-only">Published and predicted drag coefficients of the production-car look-alikes</caption>
        <thead>
          <tr className="border-b border-line-strong">
            {headings.map((heading, index) => (
              <th key={heading} scope="col" className={`label px-3 py-1.5 font-normal ${index < 2 ? "text-left" : "text-right"}`}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const sigmas = row.error === null ? null : Math.abs(row.error) / row.uncertainty;
            return (
              <tr key={row.id} className="border-b border-line align-top last:border-b-0">
                <th scope="row" className="px-3 py-1.5 text-left text-[13px] font-normal text-ink">
                  <AppLink href={`/library#${row.id}`} className="hover:text-data hover:underline">
                    {row.name}
                  </AppLink>
                  <span className="block max-w-[52ch] text-[11px] leading-normal text-ink-3">{row.cdNote}</span>
                </th>
                <td className="num px-3 py-1.5 text-[13px] text-ink-2">
                  {row.anchorClassName} · {row.anchorCd.toFixed(2)}
                </td>
                <td className="num px-3 py-1.5 text-right text-[13px] text-ink">{row.publishedCd === null ? "—" : row.publishedCd.toFixed(3)}</td>
                <td className="num px-3 py-1.5 text-right text-[13px] text-ink">
                  {row.predictedCd.toFixed(3)} <span className="text-ink-3">± {row.uncertainty.toFixed(3)}</span>
                </td>
                <td className="num px-3 py-1.5 text-right text-[13px] text-ink">{row.error === null ? "—" : formatSigned(row.error, 3)}</td>
                <td className={`num px-3 py-1.5 text-right text-[13px] ${sigmas !== null && sigmas > 2 ? "text-warn" : "text-ink-2"}`}>
                  {sigmas === null ? "—" : sigmas.toFixed(1)}
                </td>
                <td className="num px-3 py-1.5 text-right text-[13px] text-ink-2">
                  {row.computedArea.toFixed(2)} /{" "}
                  {row.publishedArea === null ? "—" : `${row.publishedArea.toFixed(2)} m² (${formatSigned((row.areaError ?? 0) * 100, 1)} %)`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Compares the models' predictions for the production-car look-alikes with the published drag coefficients. */
export function ValidationWorkspace() {
  const [mode, setMode] = useState<ValidationMode>("analytical");
  const [rows, setRows] = useState<ValidationRow[] | null>(computed.get("analytical") ?? null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  // Mode B solves a flow field per car (several seconds in total), so it runs only when asked for.
  const [requested, setRequested] = useState<Set<ValidationMode>>(new Set(["analytical"]));

  useEffect(() => {
    const existing = computed.get(mode);
    setError(null);
    setRows(existing ?? null);
    if (existing || !requested.has(mode)) return;
    let cancelled = false;
    setProgress(0);
    (async () => {
      const done: ValidationRow[] = [];
      for (const car of REAL_CARS) {
        const run = await simulateLocal(validationConfig(car, mode), false);
        if (cancelled) return;
        done.push(validationRow(car, run.result.aero));
        setProgress(done.length / REAL_CARS.length);
      }
      computed.set(mode, done);
      setRows(done);
    })().catch((failure: unknown) => {
      if (cancelled) return;
      setError({
        code: failure instanceof SimulationError ? failure.code : "VALIDATION_FAILED",
        message: failure instanceof Error ? failure.message : "The comparison could not be computed.",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [mode, requested]);

  const summary = rows ? summarizeValidation(rows) : null;
  const sorted = rows ? ordered(rows) : null;
  const unpublished = rows ? rows.filter((row) => row.publishedCd === null) : [];

  const exportCsv = () => {
    if (!sorted) return;
    downloadCsv(
      ["Car", "Anchor class", "Class reference Cd", "Published Cd", "Predicted Cd", "Stated uncertainty (1 sigma)", "Difference", "Look-alike frontal area (m2)", "Published frontal area (m2)", "Mode", "Note on the published figure"],
      sorted.map((row) => [row.name, row.anchorClassName, row.anchorCd, row.publishedCd, row.predictedCd.toFixed(4), row.uncertainty.toFixed(4), row.error?.toFixed(4) ?? null, row.computedArea.toFixed(3), row.publishedArea, MODE_NAMES[mode], row.cdNote]),
      `aerolab-validation-${mode}.csv`,
    );
  };

  return (
    <div className="grid-backdrop flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-5">
        <h1 className="text-[clamp(26px,2.6vw,34px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">Validation against published figures</h1>
        <p className="mt-2 max-w-[84ch] text-sm leading-relaxed text-ink-2">
          {REAL_CARS.length} production cars are in the <AppLink href="/library" className="text-ink-2 underline hover:text-ink">library</AppLink> as
          parametric look-alikes. Each one is predicted from a generic class: the class reference coefficient, plus the modelled effect of
          reshaping that class into the car. The car&apos;s own published drag coefficient is never an input, so the difference between
          the two is a real test. Conditions: still standard air at {(MODEL.calibration.speed * 3.6).toFixed(0)} km/h.
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <Tabs
            label="Model"
            active={mode}
            onChange={(id) => setMode(id as ValidationMode)}
            tabs={[
              { id: "analytical", label: MODE_NAMES.analytical },
              { id: "reduced-order", label: MODE_NAMES["reduced-order"] },
            ]}
          />
          <Button size="sm" onClick={exportCsv} disabled={!sorted}>
            Export CSV
          </Button>
        </div>

        <div className="mt-4 space-y-4">
          {error && <ErrorBox code={error.code} message={error.message} />}
          {!rows && !error && !requested.has(mode) && (
            <div className="rounded-2xl bg-panel-2 px-5 py-8 text-center text-[13px] text-ink-2">
              <p>Mode B solves a flow field for every car, which takes a few seconds in the browser.</p>
              <Button className="mt-3" variant="primary" onClick={() => setRequested(new Set([...requested, mode]))}>
                Run Mode B on all {REAL_CARS.length} cars
              </Button>
            </div>
          )}
          {!rows && !error && requested.has(mode) && (
            <div className="rounded-2xl border border-line bg-panel px-4 py-4">
              <ProgressBar value={progress} label="Validation progress" />
              <p className="num mt-1 text-xs text-ink-3">
                Simulating {Math.min(Math.round(progress * REAL_CARS.length) + 1, REAL_CARS.length)} of {REAL_CARS.length}…
              </p>
            </div>
          )}

          {summary && sorted && (
            <>
              <Summary summary={summary} total={sorted.length} />
              <ValidationChart rows={sorted} title={`Published and predicted drag coefficient · ${MODE_NAMES[mode]}`} />
              <ResultTable rows={sorted} />
              {summary.meanAbsAreaError !== null && (
                <p className="text-xs leading-normal text-ink-3">
                  Frontal area is a check on the look-alikes themselves, with no aerodynamic model involved: for the {summary.areaCount} cars
                  with a published area, the look-alike differs by {(summary.meanAbsAreaError * 100).toFixed(1)} % on average.
                </p>
              )}
            </>
          )}
        </div>

        <section className="mt-10 max-w-[84ch] border-t border-line pt-6">
          <h2 className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink font-stretch-expanded">How to read this</h2>
          <ul className="mt-3 list-disc space-y-2.5 pl-4 text-sm leading-relaxed text-ink-2 marker:text-ink-3">
            <li>
              <span className="text-ink">It tests the model and the look-alike together.</span> A look-alike has the car&apos;s published length,
              width, height, wheelbase and wheels, but its rake angles, hood and deck lengths, tapers and floor are estimates. They were fixed
              before any model was run on these cars and are not tuned towards the published figures.
            </li>
            <li>
              <span className="text-ink">Published figures are the manufacturers&apos; own.</span> They are quoted for a favourable version,
              such as narrow tyres, the lowest suspension setting or closed cooling shutters, and are not measured to a common standard. A
              difference of 0.01 or more between sources is normal; the note under each car says which figure is used.
            </li>
            <li>
              <span className="text-ink">The models cannot see detail.</span> Underbody panels, grille shutters, wheel designs, mirrors and
              cooling flow are what separate a good car from an average one of the same shape. They enter only through two coarse settings,
              floor flatness and wheel exposure.
            </li>
            <li>
              <span className="text-ink">The stated uncertainty is the model&apos;s own estimate.</span> It grows with the size of the change the
              model predicts from the class. If the model under-reacts to a shape, it also understates its uncertainty; the
              &ldquo;difference ÷ stated ±&rdquo; column shows where that happens (values above 2 are highlighted).
            </li>
            {unpublished.length > 0 && (
              <li>
                <span className="text-ink">No published figure could be verified for {unpublished.map((row) => row.name).join(" and ")}.</span>{" "}
                They are shown as predictions only and are left out of the statistics.
              </li>
            )}
            <li>
              <span className="text-ink">Mode C is not part of this comparison.</span> CFD of a look-alike has no class calibration and
              describes the smooth simplified shape, so it is not a prediction of the production car.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
