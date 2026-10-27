"use client";

import { useEffect, useRef, useState } from "react";
import { MODE_LABELS } from "@/components/dashboard/ResultsPanel";
import { Button, Kbd } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { useExperimentStore } from "@/lib/state/experimentStore";
import { isResultStale, runSimulation } from "@/lib/state/run";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import { useViewStore } from "@/lib/state/viewStore";
import type { Fidelity, SimulationMode } from "@/lib/types";
import type { UnitSystem } from "@/lib/utils/units";

const MODE_OPTIONS = (Object.keys(MODE_LABELS) as SimulationMode[]).map((mode) => ({
  value: mode,
  label: `${MODE_LABELS[mode].short} · ${MODE_LABELS[mode].name}${mode === "cfd" || mode === "ml-surrogate" ? " (backend)" : ""}`,
}));

export function ModeSelect() {
  const mode = useSimStore((state) => state.mode);
  const setMode = useSimStore((state) => state.setMode);
  return <Select<SimulationMode> ariaLabel="Simulation mode" size="md" className="w-[172px] sm:min-w-[132px] min-[1180px]:shrink-0" value={mode} options={MODE_OPTIONS} onChange={setMode} />;
}

export function FidelitySelect() {
  const fidelity = useSimStore((state) => state.fidelity);
  const setFidelity = useSimStore((state) => state.setFidelity);
  const cfd = useSimStore((state) => state.mode === "cfd");
  return (
    <Select<Fidelity>
      ariaLabel="Grid fidelity of the flow solve"
      size="md"
      className="sm:shrink-0"
      value={fidelity}
      options={[
        { value: "coarse", label: "Grid: coarse" },
        { value: "medium", label: "Grid: medium" },
        // A fine CFD mesh takes too much compute to run on the shared backend; Modes A and B still offer it.
        cfd
          ? { value: "fine", label: "Grid: fine (not for CFD)", disabled: true }
          : { value: "fine", label: "Grid: fine (slow)" },
      ]}
      onChange={setFidelity}
    />
  );
}

export function UnitToggle() {
  const system = useSettingsStore((state) => state.unitSystem);
  const setUnitSystem = useSettingsStore((state) => state.setUnitSystem);
  return (
    <Select<UnitSystem>
      ariaLabel="Unit system"
      size="md"
      className="sm:shrink-0"
      value={system}
      options={[
        { value: "automotive", label: "km/h · mm · hp" },
        { value: "si", label: "SI · m/s · m · kW" },
      ]}
      onChange={setUnitSystem}
    />
  );
}

export function RunButton() {
  const running = useSimStore((state) => state.running);
  return (
    <Button variant="primary" onClick={() => void runSimulation()} disabled={running} title="Run the simulation for the current configuration">
      {running ? (
        "Running…"
      ) : (
        <>
          Run
          <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden>
            <path d="M1 1.2v7.6a.5.5 0 0 0 .76.43l6.2-3.8a.5.5 0 0 0 0-.86L1.76.77A.5.5 0 0 0 1 1.2Z" fill="currentColor" />
          </svg>
        </>
      )}
    </Button>
  );
}

/**
 * Saves the current configuration, with its results, as a named configuration.
 * If the displayed result is missing or stale the simulation is run first.
 */
export function SaveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const sim = useSimStore.getState();
    const experiments = useExperimentStore.getState().experiments;
    const current = experiments.find((experiment) => experiment.id === sim.resultExperimentId);
    setName(current && !isResultStale(sim.result) && current.saved ? current.name : "");
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setBusy(true);
    const sim = useSimStore.getState();
    let id = sim.resultExperimentId;
    if (!sim.result || isResultStale(sim.result) || !id) {
      const experiment = await runSimulation();
      id = experiment?.id ?? null;
    }
    if (id) {
      const store = useExperimentStore.getState();
      const experiment = store.experiments.find((entry) => entry.id === id);
      if (experiment) {
        if (name.trim()) store.rename(id, name.trim());
        if (!experiment.saved) store.toggleSaved(id);
        if (!store.compareIds.includes(id)) store.toggleCompare(id);
      }
      onClose();
    }
    setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overscroll-contain bg-black/60 pt-24 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Save configuration"
      onClick={onClose}
    >
      <div className="w-[400px] max-w-[calc(100vw-24px)] rounded-2xl border border-line-strong bg-panel p-5 shadow-2xl shadow-black" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-[15px] font-semibold text-ink font-stretch-semi-expanded">Save configuration</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-2">
          Stores the geometry, conditions and results as a named configuration and adds it to the comparison set. If the
          inputs changed since the last run, the simulation is run first.
        </p>
        <label className="label mt-4 block" htmlFor="save-name">
          Name
        </label>
        <input
          id="save-name"
          ref={input}
          name="configuration-name"
          autoComplete="off"
          className="mt-1 h-8 w-full border border-line bg-bg px-2.5 text-[13px] text-ink focus:border-data"
          placeholder="e.g. Low ride height…"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") onClose();
            event.stopPropagation();
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Header controls of the simulator: project, mode, fidelity, units, save, compare, run. */
export function RunControls({ compact, onSave }: { compact: boolean; onSave: () => void }) {
  const projectName = useSimStore((state) => state.projectName);
  const setProjectName = useSimStore((state) => state.setProjectName);
  const setDockTab = useViewStore((state) => state.setDockTab);
  const setDockSize = useViewStore((state) => state.setDockSize);

  if (compact) {
    return (
      <>
        <ModeSelect />
        <RunButton />
      </>
    );
  }
  return (
    <>
      <input
        aria-label="Project name"
        name="project-name"
        autoComplete="off"
        className="h-8 w-20 max-w-44 flex-1 border border-transparent bg-transparent px-2 text-[13px] font-medium text-ink-2 transition-colors hover:border-line hover:text-ink focus:border-data focus:text-ink"
        value={projectName}
        onChange={(event) => setProjectName(event.target.value)}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <ModeSelect />
      {/* Below 1440 px these two live in the parameter panel's "Simulation settings" instead. */}
      <span className="hidden items-center gap-1.5 min-[1440px]:flex">
        <FidelitySelect />
        <UnitToggle />
      </span>
      <Button variant="ghost" className="!px-2.5" onClick={onSave} title="Save configuration (Ctrl/Cmd + S)">
        Save
        <span className="hidden 2xl:inline-flex">
          <Kbd>⌘S</Kbd>
        </span>
      </Button>
      <Button
        variant="ghost"
        className="!px-2.5"
        onClick={() => {
          setDockTab("tradeoff");
          setDockSize("normal");
        }}
        title="Compare the current result with the baseline run"
      >
        Compare
      </Button>
      <RunButton />
    </>
  );
}
