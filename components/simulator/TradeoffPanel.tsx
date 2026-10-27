"use client";

import { ComparisonTable } from "@/components/dashboard/ComparisonTable";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Unavailable } from "@/components/ui/Layout";
import { baselineFor, type Experiment, useExperimentStore } from "@/lib/state/experimentStore";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import { formatSigned, unitOf } from "@/lib/utils/units";

/** Neutral statement of how drag and downforce moved together between two runs. */
function tradeoffStatement(baseline: Experiment, current: Experiment, forceLabel: string, toDisplay: (n: number) => number): string {
  const dDrag = toDisplay(current.aero.forces.drag) - toDisplay(baseline.aero.forces.drag);
  const dDown = toDisplay(current.aero.forces.downforce) - toDisplay(baseline.aero.forces.downforce);
  const drag = `${formatSigned(dDrag, 0)} ${forceLabel} drag`;
  const down = `${formatSigned(dDown, 0)} ${forceLabel} downforce`;
  if (Math.abs(dDrag) < 0.5 && Math.abs(dDown) < 0.5) return "The two configurations produce essentially the same aerodynamic forces.";
  if (dDown > 0.5 && dDrag > 0.5) {
    return `${down} was obtained at a cost of ${drag} (${(dDown / dDrag).toFixed(1)} N of downforce per N of drag). More downforce usually increases drag.`;
  }
  if (dDown > 0.5 && dDrag <= 0.5) return `${down} together with ${drag}: in this model the change improves both, which is typical of ride-height and underbody changes.`;
  if (dDown < -0.5 && dDrag < -0.5) return `${drag}, with ${down}: drag was reduced by giving up downforce.`;
  return `${drag} and ${down}.`;
}

/** ORIGINAL vs MODIFIED: the current result against a baseline experiment. */
export function TradeoffPanel() {
  const experiments = useExperimentStore((state) => state.experiments);
  const baselineId = useExperimentStore((state) => state.baselineId);
  const setBaseline = useExperimentStore((state) => state.setBaseline);
  const currentId = useSimStore((state) => state.resultExperimentId);
  const system = useSettingsStore((state) => state.unitSystem);

  const current = experiments.find((experiment) => experiment.id === currentId) ?? null;
  const baseline = baselineFor(experiments, baselineId, currentId);

  if (!current) {
    return (
      <div className="p-3">
        <Unavailable>
          Run a simulation, change a parameter, and run again. The two runs are compared here: baseline on the left,
          modified on the right.
        </Unavailable>
      </div>
    );
  }

  const force = unitOf(system, "force");
  const options = experiments
    .filter((experiment) => experiment.id !== current.id)
    .map((experiment) => ({ value: experiment.id, label: experiment.name }))
    .reverse();

  return (
    <div className="flex h-full min-h-0 gap-4 overflow-auto p-3">
      <div className="min-w-[420px] flex-1">
        {baseline ? (
          <ComparisonTable experiments={[baseline, current]} headings={["Baseline", "Modified"]} />
        ) : (
          <Unavailable>
            Only one run so far. Change a parameter (for example ride height) and run again to see the tradeoff against
            this run.
          </Unavailable>
        )}
      </div>
      <div className="w-[280px] shrink-0">
        <div className="label mb-1">Baseline</div>
        <div className="flex items-center gap-2">
          <Select
            ariaLabel="Baseline experiment"
            className="min-w-0 flex-1"
            value={baselineId && baselineId !== current.id ? baselineId : ""}
            options={[{ value: "", label: "Previous run (automatic)" }, ...options]}
            onChange={(id) => setBaseline(id || null)}
          />
          <Button size="sm" onClick={() => setBaseline(current.id)} title="Compare all later runs against the current result">
            Pin current
          </Button>
        </div>
        {baseline && (
          <p className="mt-3 border-l-2 border-data pl-2 text-[13px] leading-normal text-ink-2">
            {tradeoffStatement(baseline, current, force.label, force.toDisplay)}
          </p>
        )}
        <p className="mt-3 text-xs leading-normal text-ink-3">
          Differences between two runs of the same mode are the most reliable output of the simplified models. Absolute
          values carry the uncertainty shown in the results panel.
        </p>
      </div>
    </div>
  );
}
