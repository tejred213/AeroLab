"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ErrorBox } from "@/components/dashboard/ResultsPanel";
import { Button } from "@/components/ui/Button";
import { Checkbox, NumberInput, Select } from "@/components/ui/Field";
import { Badge, ProgressBar, Unavailable } from "@/components/ui/Layout";
import {
  type CfdCaseInfo,
  cfdCaseDownloadUrl,
  generateCfdCase,
  importCfdResult,
  listSurrogates,
  type SurrogateModel,
  trainSurrogate,
} from "@/lib/simulation/backendApi";
import { buildCfdSurface, cfdSurfaceOf, uploadedCfdSurface, useCfdSurfaceStore } from "@/lib/import/cfdSurface";
import { useImportedModel } from "@/lib/import/useImportedModel";
import { currentConfig, recordExternalResult, refreshBackendStatus } from "@/lib/state/run";
import { useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";
import { currentVehicle, type SimError, useSimStore } from "@/lib/state/simStore";
import { type ImportedModelInfo, type JobProgress, type SimulationConfig, SimulationError } from "@/lib/types";

function asError(error: unknown): SimError {
  return {
    code: error instanceof SimulationError ? error.code : "REQUEST_FAILED",
    message: error instanceof Error ? error.message : "The request failed.",
  };
}

/** Geometry parameters varied when generating surrogate training data. */
const SURROGATE_PARAMETERS = [
  "rideHeight",
  "roofHeight",
  "rearWindowAngle",
  "rearDeckLength",
  "windshieldAngle",
  "rearTaper",
  "floorFlatness",
  "diffuserAngle",
  "diffuserLength",
  "spoilerAngle",
  "spoilerHeight",
  "splitterExtension",
  "wingChord",
  "wingAngle",
  "wheelExposure",
  "mirrorWidth",
  "rimOpenness",
  "grilleOpening",
];

/** The configuration Mode C is asked for: an imported 3D model goes as its wrapped surface. */
async function cfdConfig(): Promise<SimulationConfig> {
  const config = { ...currentConfig(), mode: "cfd" as const };
  const model = currentVehicle(useSimStore.getState()).importedModel;
  if (!config.bodyId || !model) return config;
  const { bodyId: _browserOnly, ...rest } = config;
  return { ...rest, cfdSurface: await uploadedCfdSurface(model) };
}

const VOXELS = [
  { value: "0.02", label: "20 mm (quick look)" },
  { value: "0.015", label: "15 mm" },
  { value: "0.01", label: "10 mm (large)" },
];
const SEALS = [
  { value: "0.03", label: "30 mm" },
  { value: "0.06", label: "60 mm" },
  { value: "0.1", label: "100 mm" },
  { value: "0.2", label: "200 mm" },
];

/**
 * For an imported 3D model: builds the closed surface that Mode C meshes, from the model's own triangles.
 * The surface can be shown in the viewport, so that what goes to the mesher is seen before any solver time is spent.
 */
function WrapBlock({ model }: { model: ImportedModelInfo }) {
  const wrap = useCfdSurfaceStore((state) => state.wraps[model.bodyId]);
  const show = useCfdSurfaceStore((state) => state.show);
  const setShow = useCfdSurfaceStore((state) => state.setShow);
  const [voxel, setVoxel] = useState("0.015");
  const [seal, setSeal] = useState("0.03");
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [error, setError] = useState<SimError | null>(null);

  useEffect(() => {
    void cfdSurfaceOf(model.bodyId);
  }, [model.bodyId]);

  const build = async () => {
    setError(null);
    setProgress({ state: "PREPARING", progress: 0, message: "Starting" });
    try {
      await buildCfdSurface(model, { voxel: Number(voxel), seal: Number(seal) }, setProgress);
      setShow(true);
    } catch (failure) {
      setError(asError(failure));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-line bg-panel-2 p-3">
      <h4 className="text-xs font-semibold text-ink">CFD surface of the imported model</h4>
      <p className="mt-1 text-xs leading-normal text-ink-3">
        A model file is loose panels, not one skin, so it is shrink-wrapped first: the air is flooded in from outside on
        a fine grid and the boundary it cannot pass becomes one closed surface. Mirrors, wheels, wheel arches and the
        underbody as modelled are kept; anything finer than the grid and any cooling flow are not.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-2">Grid</span>
        <Select ariaLabel="Voxel size of the wrap" value={voxel} options={VOXELS} onChange={setVoxel} />
        <span className="text-ink-2">Seal gaps up to</span>
        <Select ariaLabel="Largest gap that is sealed" value={seal} options={SEALS} onChange={setSeal} />
        <Button onClick={build} disabled={progress !== null}>
          {wrap ? "Build again" : "Build the CFD surface"}
        </Button>
      </div>
      {progress && <p role="status" className="num mt-1.5 text-xs text-ink-2">{Math.round(progress.progress * 100)} % · {progress.message}</p>}
      {wrap && !progress && (
        <>
          <p className="num mt-2 text-xs text-ink">
            {wrap.triangles.toLocaleString()} triangles · closed · {Math.round(wrap.voxel * 1000)} mm grid · gaps to{" "}
            {Math.round(wrap.seal * 1000)} mm sealed
          </p>
          <p className="num mt-0.5 text-xs text-ink-2">
            Frontal area {wrap.frontalArea.toFixed(3)} m² · surface {wrap.area.toFixed(1)} m² · volume {wrap.volume.toFixed(2)} m³ ·{" "}
            {(wrap.max[0] - wrap.min[0]).toFixed(2)} × {(wrap.max[1] - wrap.min[1]).toFixed(2)} × {(wrap.max[2] - wrap.min[2]).toFixed(2)} m
          </p>
          {wrap.warnings.map((warning) => (
            <p key={warning} className="mt-1 text-xs leading-normal text-warn">{warning}</p>
          ))}
          <div className="mt-1.5">
            <Checkbox
              checked={show}
              onChange={setShow}
              label="Show the CFD surface in the viewport"
              hint="This is exactly what the mesher receives. Mode C then uses the model as imported: changes to the geometry parameters are not in it."
            />
          </div>
        </>
      )}
      {!wrap && !progress && (
        <p className="mt-1.5 text-xs text-ink-3">
          Not built yet. Running Mode C builds it with these default settings; build it here first to look at it before
          any solver time is spent.
        </p>
      )}
      {error && (
        <div className="mt-2">
          <ErrorBox code={error.code} message={error.message} />
        </div>
      )}
    </div>
  );
}

function CfdSection() {
  const importedModel = useImportedModel();
  const info = useBackendStore((state) => state.info);
  const cfd = info?.engines.cfd;
  const [busy, setBusy] = useState(false);
  const [caseInfo, setCaseInfo] = useState<CfdCaseInfo | null>(null);
  const [error, setError] = useState<SimError | null>(null);
  const [coefficientFile, setCoefficientFile] = useState("");
  const [imported, setImported] = useState<string | null>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      setCaseInfo(await generateCfdCase(await cfdConfig()));
    } catch (failure) {
      setError(asError(failure));
    } finally {
      setBusy(false);
    }
  };

  const importResult = async () => {
    setBusy(true);
    setError(null);
    setImported(null);
    try {
      const result = await importCfdResult({ config: await cfdConfig(), coefficientFile });
      const experiment = await recordExternalResult(result);
      setImported(`Recorded as ${experiment.name}. Cd ${result.aero.coefficients.cd.toFixed(4)}, Cl ${result.aero.coefficients.cl.toFixed(4)}.`);
    } catch (failure) {
      setError(asError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="min-w-[380px] flex-1">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Mode C · CFD (OpenFOAM adapter)</h3>
        <Badge tone={cfd?.available ? "ok" : "warn"}>{cfd?.available ? "Solver found" : "Solver not installed"}</Badge>
      </div>
      <p className="text-xs leading-normal text-ink-2">{cfd?.detail}</p>
      <p className="mt-1 text-xs leading-normal text-ink-3">
        AeroLab never reports CFD numbers it did not obtain from a solver. Without OpenFOAM on the backend machine, Mode
        C fails with an explicit error. You can still generate the complete case, run it on another machine and import
        the force coefficients.
      </p>
      <p className="mt-1 text-xs leading-normal text-ink-3">
        The mesh follows the <strong className="text-ink-2">Grid</strong> setting in the header. Coarse (about 0.4
        million cells, no prism layers) is a quick check that the pipeline runs, not a result to quote; medium and fine
        (about 0.7 and 3 million cells) add prism layers and take from tens of minutes to hours.
        {cfd?.available ? " To run it, choose Mode C in the header and press Run." : ""}
      </p>

      {importedModel?.active && <WrapBlock model={importedModel.model} />}

      <div className="mt-2 flex items-center gap-2">
        <Button onClick={generate} disabled={busy}>
          Generate OpenFOAM case for the current geometry
        </Button>
      </div>
      {caseInfo && (
        <div className="mt-2 rounded-xl border border-line bg-panel-2 p-3">
          <p className="num text-xs text-ink">
            Case {caseInfo.caseId} · {caseInfo.meshSetting} mesh · about {caseInfo.cellEstimate.toLocaleString()} cells
            (estimate)
          </p>
          <p className="num mt-0.5 text-xs text-ink-2">
            {caseInfo.prismLayers === 0 ? "no prism layers" : `${caseInfo.prismLayers} prism layers`} · up to{" "}
            {caseInfo.iterations} iterations · {caseInfo.processors} process{caseInfo.processors === 1 ? "" : "es"}
          </p>
          <p className="num mt-0.5 text-[11px] break-all text-ink-3">{caseInfo.path}</p>
          <p className="mt-1 text-xs leading-normal text-ink-2">{caseInfo.files.length} files: {caseInfo.files.join(", ")}</p>
          <a
            className="mt-1.5 inline-flex h-7 items-center rounded-lg border border-line-strong px-2 text-xs text-data hover:border-data"
            href={cfdCaseDownloadUrl(caseInfo.caseId)}
          >
            Download case (.zip)
          </a>
        </div>
      )}

      <div className="label mt-3 mb-1">Import force coefficients from a solver run</div>
      <textarea
        aria-label="Contents of the OpenFOAM forceCoeffs output file"
        className="num scroll-thin h-20 w-full resize-none border border-line bg-bg p-1.5 text-[11px] text-ink focus:border-data"
        placeholder={"Paste postProcessing/forceCoeffs/0/coefficient.dat here\n# Time  Cd  Cs  Cl  CmRoll  CmPitch  CmYaw …"}
        value={coefficientFile}
        onChange={(event) => setCoefficientFile(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <div className="mt-1 flex items-center gap-2">
        <Button onClick={importResult} disabled={busy || coefficientFile.trim().length === 0}>
          Import as Mode C result
        </Button>
        <span className="text-[11px] text-ink-3">Volume-field import (VTK): coming soon</span>
      </div>
      {imported && <p className="mt-1.5 text-xs text-ok">{imported}</p>}
      {error && (
        <div className="mt-2">
          <ErrorBox code={error.code} message={error.message} />
        </div>
      )}
    </section>
  );
}

function SurrogateSection() {
  const [models, setModels] = useState<SurrogateModel[]>([]);
  const [error, setError] = useState<SimError | null>(null);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [samples, setSamples] = useState(1200);
  const [spread, setSpread] = useState(0.35);
  const [sourceMode, setSourceMode] = useState<"analytical" | "reduced-order">("analytical");

  const refresh = useCallback(async () => {
    try {
      setModels(await listSurrogates());
    } catch (failure) {
      setError(asError(failure));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const train = async () => {
    setError(null);
    setProgress({ state: "QUEUED", progress: 0, message: "Queued" });
    try {
      await trainSurrogate({ config: currentConfig(), sourceMode, samples, parameters: SURROGATE_PARAMETERS, spread, seed: 7 }, setProgress);
      await refresh();
      await refreshBackendStatus();
    } catch (failure) {
      setError(asError(failure));
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="min-w-[380px] flex-1">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Mode D · ML surrogate</h3>
        <Badge tone={models.length > 0 ? "ok" : "neutral"}>{models.length > 0 ? `${models.length} model${models.length === 1 ? "" : "s"}` : "Not trained"}</Badge>
      </div>
      <p className="text-xs leading-normal text-ink-3">
        A regression model learns Cd and Cl from geometry, air density and speed, using results generated by another
        mode. A random forest and gradient boosting are both fitted; the one with the lower error on held-out samples
        is used. It interpolates that data quickly; it is never more accurate than the model that produced the data,
        and it is not physically exact.
      </p>

      <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1">
        <span className="text-[13px] text-ink-2">Training data from</span>
        <Select
          ariaLabel="Engine that generates training data"
          value={sourceMode}
          options={[
            { value: "analytical", label: "Mode A · Analytical" },
            { value: "reduced-order", label: "Mode B · Reduced-order (coarse, slow)" },
          ]}
          onChange={setSourceMode}
        />
        <span className="text-[13px] text-ink-2">Samples (Latin hypercube)</span>
        <div className="w-24">
          <NumberInput ariaLabel="Number of training samples" value={samples} decimals={0} min={40} max={5000} step={50} onCommit={setSamples} />
        </div>
        <span className="text-[13px] text-ink-2">Parameter spread (fraction of range)</span>
        <div className="w-24">
          <NumberInput ariaLabel="Parameter spread" value={spread} decimals={2} min={0.05} max={1} step={0.05} onCommit={setSpread} />
        </div>
      </div>
      <div className="mt-2">
        <Button variant="primary" onClick={train} disabled={progress !== null}>
          {progress ? "Training…" : "Generate data and train"}
        </Button>
      </div>
      {progress && (
        <div className="mt-2">
          <ProgressBar value={progress.progress} label="Surrogate training progress" />
          <p className="num mt-0.5 text-[11px] text-ink-3">
            {progress.state} · {progress.message}
          </p>
        </div>
      )}
      {error && (
        <div className="mt-2">
          <ErrorBox code={error.code} message={error.message} />
        </div>
      )}

      {models.length > 0 && (
        <table className="mt-3 w-full border-collapse">
          <caption className="label pb-1 text-left">Trained models · scores are on held-out validation samples</caption>
          <thead>
            <tr className="border-b border-line-strong">
              {["Vehicle", "Trained on", "Samples", "Algorithm", "RMSE Cd / Cl", "R² Cd / Cl", "Inference"].map((heading) => (
                <th key={heading} scope="col" className="label px-1.5 py-1 text-left font-normal">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.map((model) => {
              const rejected = (model.candidates ?? []).filter((candidate) => !candidate.selected);
              return (
                <Fragment key={model.modelId}>
                  <tr className="num border-b border-line text-xs text-ink">
                    <td className="px-1.5 py-[5px]">{model.vehicleId}</td>
                    <td className="px-1.5 py-[5px]">{model.sourceMode}</td>
                    <td className="px-1.5 py-[5px]">{model.trainingSamples}</td>
                    <td className="px-1.5 py-[5px]">{model.algorithm} · used</td>
                    <td className="px-1.5 py-[5px]">
                      {model.validationRmseCd.toFixed(4)} / {model.validationRmseCl.toFixed(4)}
                    </td>
                    <td className="px-1.5 py-[5px]">
                      {model.validationR2Cd.toFixed(3)} / {model.validationR2Cl.toFixed(3)}
                    </td>
                    <td className="px-1.5 py-[5px]">{model.inferenceTimeMs.toFixed(2)} ms</td>
                  </tr>
                  {rejected.map((candidate) => (
                    <tr key={candidate.key} className="num border-b border-line text-xs text-ink-3">
                      <td className="px-1.5 py-[5px]" colSpan={3} />
                      <td className="px-1.5 py-[5px]">{candidate.algorithm} · not used</td>
                      <td className="px-1.5 py-[5px]">
                        {candidate.validationRmseCd.toFixed(4)} / {candidate.validationRmseCl.toFixed(4)}
                      </td>
                      <td className="px-1.5 py-[5px]">
                        {candidate.validationR2Cd.toFixed(3)} / {candidate.validationR2Cl.toFixed(3)}
                      </td>
                      <td className="px-1.5 py-[5px]" />
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="mt-2 text-xs leading-normal text-ink-3">
        To use a trained model, choose <strong className="text-ink-2">Mode D</strong> in the header and run. Predictions
        are made with the most recent model trained for the selected base vehicle.
      </p>
    </section>
  );
}

/** Backend-only engines: the CFD adapter and the ML surrogate. */
export function EnginesPanel() {
  const status = useBackendStore((state) => state.status);
  const demoMode = useSettingsStore((state) => state.demoMode);
  const backendUrl = useSettingsStore((state) => state.backendUrl);

  if (demoMode || status !== "online") {
    return (
      <div className="p-3">
        <Unavailable>
          <strong className="text-ink">Modes C (CFD) and D (ML surrogate) need the Python backend.</strong>{" "}
          {demoMode
            ? "Demo mode is on, so the backend is not used. Turn it off in Settings."
            : `No backend is answering at ${backendUrl}. Start it with "npm run backend" from the project folder.`}{" "}
          Modes A and B keep working in the browser.
          <span className="mt-2 block">
            <Button size="sm" onClick={() => void refreshBackendStatus()}>
              Check again
            </Button>
          </span>
        </Unavailable>
      </div>
    );
  }
  return (
    <div className="scroll-thin flex h-full min-h-0 flex-wrap gap-6 overflow-auto p-3">
      <CfdSection />
      <SurrogateSection />
    </div>
  );
}
