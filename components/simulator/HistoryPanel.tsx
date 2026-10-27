"use client";

import { useState } from "react";
import { MODE_LABELS } from "@/components/dashboard/ResultsPanel";
import { Button } from "@/components/ui/Button";
import { Unavailable } from "@/components/ui/Layout";
import { type Experiment, useExperimentStore } from "@/lib/state/experimentStore";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import { describeChanges, describeConditions } from "@/lib/utils/describe";
import { downloadJson, slug } from "@/lib/utils/export";
import { formatNumber, formatSigned } from "@/lib/utils/units";
import { findVehicle } from "@/lib/vehicle/library";

/** Restores an experiment's configuration into the editor (does not run it). */
export function loadExperimentIntoEditor(experiment: Experiment): void {
  const sim = useSimStore.getState();
  const vehicle = findVehicle(experiment.vehicleId, sim.customVehicles);
  if (vehicle) sim.loadVehicle(vehicle, experiment.config.geometry);
  else sim.setGeometry(experiment.config.geometry);
  useSimStore.setState({
    spec: { ...experiment.spec },
    powertrain: structuredClone(experiment.powertrain),
    environment: { ...experiment.config.environment },
    speed: experiment.config.speed,
    mode: experiment.config.mode,
    fidelity: experiment.config.fidelity,
  });
}

function ExperimentRow({ experiment }: { experiment: Experiment }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const store = useExperimentStore();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(experiment.name);
  const inCompare = store.compareIds.includes(experiment.id);
  const isBaseline = store.baselineId === experiment.id;
  // "Changes" are edits to the vehicle as it ships. For a production-car look-alike that is the car's own
  // geometry, not the class geometry its prediction is anchored to.
  const customVehicles = useSimStore((state) => state.customVehicles);
  const vehicle = findVehicle(experiment.vehicleId, customVehicles);
  const changes = describeChanges(system, vehicle?.geometry ?? experiment.config.referenceGeometry, experiment.config.geometry);
  const mode = MODE_LABELS[experiment.aero.mode];

  const commit = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== experiment.name) store.rename(experiment.id, trimmed);
    else setName(experiment.name);
  };

  return (
    <li className="grid grid-cols-[minmax(150px,1.1fr)_minmax(140px,1.6fr)_minmax(120px,1fr)_auto] items-start gap-3 border-b border-line px-3 py-1.5">
      <div className="min-w-0">
        {editing ? (
          <input
            autoFocus
            aria-label="Experiment name"
            className="h-7 w-full border border-data bg-bg px-1.5 text-[13px] text-ink"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setName(experiment.name);
                setEditing(false);
              }
              event.stopPropagation();
            }}
          />
        ) : (
          <div className="flex items-center gap-1.5">
            {experiment.saved && (
              <span className="text-accent" title="Saved configuration" aria-label="Saved configuration">
                ★
              </span>
            )}
            <span className="truncate text-[13px] font-medium text-ink" title={experiment.name}>
              {experiment.name}
            </span>
          </div>
        )}
        <div className="num text-[11px] text-ink-3">
          #{String(experiment.number).padStart(3, "0")} · {experiment.vehicleName} · {mode.short} {mode.name}
          {isBaseline ? " · pinned baseline" : ""}
        </div>
      </div>
      <div className="min-w-0 text-xs leading-normal text-ink-2">
        <span className="text-ink-3">Changes: </span>
        {changes.length === 0 ? (vehicle?.realCar ? "none (look-alike as defined)" : "none (class reference geometry)") : changes.join(", ")}
        <div className="text-ink-3">{describeConditions(system, experiment)}</div>
      </div>
      <div className="num text-xs leading-normal text-ink">
        Cd = {formatNumber(experiment.aero.coefficients.cd, 3)} ± {formatNumber(experiment.aero.uncertainty.cd, 3)}
        <br />
        Cl = {formatSigned(experiment.aero.coefficients.cl, 3)} ± {formatNumber(experiment.aero.uncertainty.cl, 3)}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button size="sm" onClick={() => loadExperimentIntoEditor(experiment)} title="Restore this configuration into the editor">
          Load
        </Button>
        <Button size="sm" active={inCompare} onClick={() => store.toggleCompare(experiment.id)} title="Select for the Compare page">
          Compare
        </Button>
        <Button size="sm" active={isBaseline} onClick={() => store.setBaseline(isBaseline ? null : experiment.id)} title="Pin as the tradeoff baseline">
          Baseline
        </Button>
        <Button size="sm" active={experiment.saved} onClick={() => store.toggleSaved(experiment.id)} title="Keep as a named configuration">
          {experiment.saved ? "Saved" : "Save"}
        </Button>
        <Button size="sm" onClick={() => setEditing(true)}>
          Rename
        </Button>
        <Button size="sm" onClick={() => store.duplicate(experiment.id)}>
          Duplicate
        </Button>
        <Button size="sm" onClick={() => downloadJson(experiment, `${slug(experiment.name)}.json`)} title="Export configuration and results as JSON">
          Export
        </Button>
        <a
          href={`/report?id=${experiment.id}`}
          target="_blank"
          rel="noreferrer"
          title="Open the engineering report (print or save as PDF)"
          className="inline-flex h-7 items-center rounded-lg border border-line-strong px-2.5 text-xs text-ink hover:border-ink-3 hover:bg-raise"
        >
          Report
        </a>
        <Button size="sm" variant="danger" onClick={() => store.remove(experiment.id)}>
          Delete
        </Button>
      </div>
    </li>
  );
}

/** Every simulation run, newest first, with rename / duplicate / compare / delete / export. */
export function HistoryPanel() {
  const experiments = useExperimentStore((state) => state.experiments);
  const clear = useExperimentStore((state) => state.clear);
  const compareCount = useExperimentStore((state) => state.compareIds.length);

  if (experiments.length === 0) {
    return (
      <div className="p-3">
        <Unavailable>Every simulation you run is recorded here as an experiment.</Unavailable>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1">
        <span className="num text-xs text-ink-3">
          {experiments.length} experiment{experiments.length === 1 ? "" : "s"} · {compareCount} selected for comparison
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => downloadJson(experiments, "aerolab-experiments.json")}>
            Export all (JSON)
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (window.confirm("Delete all experiments? This cannot be undone.")) clear();
            }}
          >
            Clear history
          </Button>
        </div>
      </div>
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {[...experiments].reverse().map((experiment) => (
          <ExperimentRow key={experiment.id} experiment={experiment} />
        ))}
      </ul>
    </div>
  );
}
