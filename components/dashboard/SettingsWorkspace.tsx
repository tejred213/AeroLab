"use client";

import { type ReactNode, useRef, useState } from "react";
import { MODE_LABELS } from "@/components/dashboard/ResultsPanel";
import { FidelitySelect } from "@/components/simulator/RunControls";
import { AppHeader } from "@/components/ui/AppHeader";
import { Button, Kbd } from "@/components/ui/Button";
import { Checkbox, NumberInput, Select } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Layout";
import { MODEL_VERSION } from "@/lib/physics/model";
import { type Experiment, useExperimentStore } from "@/lib/state/experimentStore";
import { refreshBackendStatus } from "@/lib/state/run";
import { type ComputeTarget, useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";
import type { SimulationMode } from "@/lib/types";
import { downloadJson } from "@/lib/utils/export";
import type { UnitSystem } from "@/lib/utils/units";

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel">
      <h2 className="px-4 pt-3.5 text-[15px] font-semibold text-ink font-stretch-semi-expanded">{title}</h2>
      <div className="px-4 pt-1 pb-3">{children}</div>
    </section>
  );
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line py-3 last:border-b-0">
      <div>
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-ink-3">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const FEATURES: { name: string; status: "available" | "backend" | "soon"; note: string }[] = [
  { name: "Mode A · Analytical engine", status: "available", note: "Browser and backend." },
  { name: "Mode B · Reduced-order engine (3D potential flow)", status: "available", note: "Browser and backend." },
  { name: "Mode C · CFD (OpenFOAM)", status: "backend", note: "Case generation and coefficient import always; solver runs only where OpenFOAM is installed." },
  { name: "Mode D · ML surrogate", status: "backend", note: "Random forest or gradient boosting (the better on held-out data), trained on Mode A or B results." },
  { name: "Parameter sweep, design space, experiment mode", status: "available", note: "Browser; backend optional." },
  { name: "Optimisation · differential evolution", status: "available", note: "Browser and backend." },
  { name: "Optimisation · Bayesian (Gaussian process)", status: "backend", note: "Backend only." },
  { name: "Crosswind (side force, yaw moment)", status: "available", note: "Empirical correlation in Modes A and B." },
  { name: "Export · JSON, CSV, PNG, SVG, printable report (PDF)", status: "available", note: "Report uses the browser's Save as PDF." },
  { name: "Production cars as look-alikes, compared with published Cd", status: "available", note: "17 cars; simplified shapes with estimated proportions, not manufacturer geometry." },
  { name: "Import of real 3D geometry (STL)", status: "soon", note: "Not implemented; vehicles are built from the 31 shape parameters only." },
  { name: "CFD volume-field import (VTK)", status: "soon", note: "Not implemented." },
  { name: "Transient / turbulent flow simulation", status: "soon", note: "Not implemented; out of scope of the reduced-order models." },
];

const SHORTCUTS: [string, string][] = [
  ["Ctrl / ⌘ + S", "Save configuration"],
  ["R", "Reset camera"],
  ["Space", "Start / stop airflow animation"],
  ["1", "Perspective view"],
  ["2", "Front view"],
  ["3", "Side view"],
  ["4", "Top view"],
  ["5", "Rear view"],
];

export function SettingsWorkspace() {
  const settings = useSettingsStore();
  const backend = useBackendStore();
  const experiments = useExperimentStore((state) => state.experiments);
  const [urlDraft, setUrlDraft] = useState(settings.backendUrl);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const importExperiments = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const list = (Array.isArray(parsed) ? parsed : [parsed]) as Partial<Experiment>[];
      const valid = list.filter((entry) => entry && entry.config && entry.aero && entry.performance && entry.spec && entry.powertrain);
      const store = useExperimentStore.getState();
      for (const entry of valid) {
        const { id: _id, number: _number, ...rest } = entry as Experiment;
        void _id;
        void _number;
        store.add({ ...rest, createdAt: rest.createdAt ?? Date.now() });
      }
      setImportMessage(
        valid.length === list.length
          ? `Imported ${valid.length} experiment${valid.length === 1 ? "" : "s"}.`
          : `Imported ${valid.length} of ${list.length}; the rest were not AeroLab experiment records.`,
      );
    } catch {
      setImportMessage("The file is not valid JSON exported from AeroLab.");
    }
  };

  const engines = backend.info?.engines;
  return (
    <div className="grid-backdrop flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-5">
        <h1 className="text-[clamp(26px,2.6vw,34px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">Settings</h1>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <Block title="Units and display">
            <Setting label="Unit system" hint="All calculations are carried out in SI; this only changes what is displayed.">
              <Select<UnitSystem>
                ariaLabel="Unit system"
                value={settings.unitSystem}
                options={[
                  { value: "automotive", label: "Automotive · km/h, mm, hp, bar" },
                  { value: "si", label: "SI · m/s, m, kW, Pa" },
                ]}
                onChange={settings.setUnitSystem}
              />
            </Setting>
            <Setting label="Airflow particles" hint="Number of tracer particles in the 3D viewport. Lower it if the viewport is not smooth.">
              <div className="w-24">
                <NumberInput ariaLabel="Number of airflow particles" value={settings.particleCount} decimals={0} min={200} max={8000} step={200} onCommit={settings.setParticleCount} />
              </div>
            </Setting>
            <Setting label="Grid fidelity" hint="Resolution of the potential-flow solve used by Mode B and by the flow visualisation.">
              <FidelitySelect />
            </Setting>
          </Block>

          <Block title="Computation">
            <Setting
              label="Demo mode"
              hint="Run entirely in the browser with the analytical and reduced-order models. The backend is never contacted."
            >
              <Checkbox checked={settings.demoMode} label="Demo / analytical mode" onChange={settings.setDemoMode} />
            </Setting>
            <Setting label="Compute Modes A and B on" hint="Modes C and D always run on the backend.">
              <Select<ComputeTarget>
                ariaLabel="Where Modes A and B are computed"
                value={settings.computeTarget}
                disabled={settings.demoMode}
                options={[
                  { value: "browser", label: "Browser (Web Worker)" },
                  { value: "backend", label: "Python backend" },
                ]}
                onChange={settings.setComputeTarget}
              />
            </Setting>
            <Setting label="Backend address" hint='Start the backend with "npm run backend" (FastAPI on port 8000).'>
              <div className="flex items-center gap-1">
                <input
                  aria-label="Backend address"
                  className="num h-7 w-52 border border-line bg-bg px-1.5 text-[13px] text-ink focus:border-data"
                  value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)}
                  onBlur={() => settings.setBackendUrl(urlDraft)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <Button size="sm" onClick={() => void refreshBackendStatus()}>
                  Test
                </Button>
              </div>
            </Setting>
            <Setting label="Backend status" hint={backend.lastError ?? undefined}>
              <Badge tone={backend.status === "online" ? "ok" : backend.status === "offline" ? "warn" : "neutral"}>
                {settings.demoMode ? "disabled (demo mode)" : backend.status}
              </Badge>
            </Setting>
            {engines && (
              <ul className="mt-2 space-y-1">
                {(Object.keys(MODE_LABELS) as SimulationMode[]).map((mode) => {
                  const engine = engines[mode];
                  if (!engine) return null;
                  return (
                    <li key={mode} className="grid grid-cols-[150px_90px_1fr] items-start gap-2 text-xs">
                      <span className="text-ink-2">
                        {MODE_LABELS[mode].short} · {MODE_LABELS[mode].name}
                      </span>
                      <span className={`num ${engine.available ? "text-ok" : "text-warn"}`}>{engine.available ? "available" : "unavailable"}</span>
                      <span className="leading-normal text-ink-3">{engine.detail}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="num mt-2 text-[11px] text-ink-3">
              Model version {MODEL_VERSION}
              {backend.info ? ` · backend ${backend.info.version} (model ${backend.info.modelVersion})` : ""}
            </p>
          </Block>

          <Block title="Experiment data">
            <Setting label="Stored experiments" hint="Experiments and saved configurations are kept in this browser's local storage.">
              <span className="num text-[13px] text-ink">{experiments.length}</span>
            </Setting>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button onClick={() => downloadJson(experiments, "aerolab-experiments.json")} disabled={experiments.length === 0}>
                Export all (JSON)
              </Button>
              <Button onClick={() => fileInput.current?.click()}>Import JSON…</Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label="Import experiments from a JSON file"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importExperiments(file);
                  event.target.value = "";
                }}
              />
              <Button
                variant="danger"
                disabled={experiments.length === 0}
                onClick={() => {
                  if (window.confirm("Delete all experiments? This cannot be undone.")) useExperimentStore.getState().clear();
                }}
              >
                Clear all
              </Button>
            </div>
            {importMessage && <p className="mt-2 text-xs text-ink-2">{importMessage}</p>}
          </Block>

          <Block title="Keyboard shortcuts (simulator)">
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {SHORTCUTS.map(([keys, action]) => (
                <li key={keys} className="flex items-center justify-between gap-2 text-[13px] text-ink-2">
                  {action}
                  <Kbd>{keys}</Kbd>
                </li>
              ))}
            </ul>
          </Block>

          <div className="lg:col-span-2">
            <Block title="Feature status">
              <ul>
                {FEATURES.map((feature) => (
                  <li key={feature.name} className="grid grid-cols-[minmax(0,1fr)_130px_minmax(0,1.2fr)] items-center gap-3 border-b border-line py-1.5 last:border-b-0">
                    <span className="text-[13px] text-ink">{feature.name}</span>
                    <span>
                      {feature.status === "available" && <Badge tone="ok">Available</Badge>}
                      {feature.status === "backend" && <Badge tone="data">Needs backend</Badge>}
                      {feature.status === "soon" && <Badge>Coming soon</Badge>}
                    </span>
                    <span className="text-xs text-ink-3">{feature.note}</span>
                  </li>
                ))}
              </ul>
            </Block>
          </div>
        </div>
      </main>
    </div>
  );
}
