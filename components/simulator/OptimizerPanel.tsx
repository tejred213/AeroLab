"use client";

import { useState } from "react";
import { type ChartRow, LineChartPanel } from "@/components/charts/LineChartPanel";
import { type AnalysisEngine, EngineSelect, initialEngine, studyConfig, TaskStatus } from "@/components/simulator/AnalysisControls";
import { Button } from "@/components/ui/Button";
import { Checkbox, NumberInput, Select } from "@/components/ui/Field";
import { PARAM_BY_ID } from "@/lib/geometry/parameters";
import { MODEL } from "@/lib/physics/model";
import {
  type Candidate,
  type Constraint,
  type ConstraintMetric,
  type DesignMetrics,
  type DesignVariable,
  type Objective,
  OBJECTIVES,
  type OptimizationAlgorithm,
} from "@/lib/simulation/optimize";
import { executeOptimization, useAnalysisStore } from "@/lib/state/analysisStore";
import { useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import type { ParamId } from "@/lib/types";
import { formatParam } from "@/lib/utils/describe";
import { formatNumber, formatSigned, type Quantity, quantityOfParam, type UnitSystem, unitOf } from "@/lib/utils/units";

/** Parameters offered as design variables, with the default search band around the current value. */
const VARIABLE_CHOICES: ParamId[] = [
  "rideHeight",
  "spoilerAngle",
  "spoilerHeight",
  "wingChord",
  "wingAngle",
  "diffuserAngle",
  "diffuserLength",
  "splitterExtension",
  "sideSkirtDepth",
  "rearWindowAngle",
  "windshieldAngle",
  "rearTaper",
  "floorFlatness",
  "roofHeight",
];

const METRIC_INFO: Record<ConstraintMetric, { label: string; quantity: Quantity | null; decimals: number }> = {
  cd: { label: "Cd", quantity: null, decimals: 3 },
  cl: { label: "Cl", quantity: null, decimals: 3 },
  drag: { label: "Drag", quantity: "force", decimals: 0 },
  downforce: { label: "Downforce", quantity: "force", decimals: 0 },
  topSpeed: { label: "Top speed", quantity: "speed", decimals: 1 },
  efficiency: { label: "Efficiency", quantity: null, decimals: 2 },
};

function metricText(system: UnitSystem, metric: ConstraintMetric, value: number): string {
  const info = METRIC_INFO[metric];
  if (!Number.isFinite(value)) return "—";
  if (!info.quantity) return metric === "cl" || metric === "efficiency" ? formatSigned(value, info.decimals) : formatNumber(value, info.decimals);
  const unit = unitOf(system, info.quantity);
  return `${unit.toDisplay(value).toFixed(info.decimals)} ${unit.label}`;
}

function objectiveMetric(objective: Objective): ConstraintMetric {
  if (objective === "min-drag") return "drag";
  if (objective === "max-downforce") return "downforce";
  if (objective === "max-efficiency") return "efficiency";
  return "topSpeed";
}

interface VariableState {
  enabled: boolean;
  min: number;
  max: number;
}

/** Enabled by default: enough freedom to trade drag against downforce (ride height, floor and rear devices). */
const DEFAULT_VARIABLES: ParamId[] = ["rideHeight", "spoilerAngle", "spoilerHeight", "wingChord", "wingAngle", "diffuserAngle"];

function initialVariables(geometry: Record<ParamId, number>): Record<string, VariableState> {
  const state: Record<string, VariableState> = {};
  for (const id of VARIABLE_CHOICES) {
    const definition = PARAM_BY_ID[id];
    const span = definition.max - definition.min;
    state[id] = {
      enabled: DEFAULT_VARIABLES.includes(id),
      min: Math.max(definition.min, geometry[id] - 0.25 * span),
      max: Math.min(definition.max, geometry[id] + 0.25 * span),
    };
  }
  // Spec example: ride height >= 80 mm, spoiler angle searched from flat.
  state.rideHeight.min = Math.max(PARAM_BY_ID.rideHeight.min, 0.08);
  state.spoilerAngle.min = 0;
  // Devices that most cars start without are searched over their whole range.
  state.spoilerHeight = { ...state.spoilerHeight, min: 0, max: PARAM_BY_ID.spoilerHeight.max };
  state.wingChord = { ...state.wingChord, min: 0, max: PARAM_BY_ID.wingChord.max };
  // Keep the wing below its stall onset, where the model's downforce stops rising.
  state.wingAngle = { ...state.wingAngle, min: 0, max: Math.min(PARAM_BY_ID.wingAngle.max, MODEL.wing.stallOnsetDeg) };
  return state;
}

function CandidateTable({ candidates, baseline, variables }: { candidates: Candidate[]; baseline: Candidate; variables: DesignVariable[] }) {
  const system = useSettingsStore((state) => state.unitSystem);
  const setGeometry = useSimStore((state) => state.setGeometry);
  const metrics: ConstraintMetric[] = ["cd", "cl", "drag", "downforce", "topSpeed"];
  const columns = [{ label: "Current", candidate: baseline }, ...candidates.map((candidate, index) => ({ label: index === 0 ? "Best" : `#${index + 1}`, candidate }))];
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line-strong">
          <th scope="col" className="label px-2 py-1 text-left font-normal">
            Design
          </th>
          {columns.map((column) => (
            <th key={column.label} scope="col" className="px-2 py-1 text-right">
              <span className="label block">{column.label}</span>
              <span className={`num text-[11px] ${column.candidate.feasible ? "text-ok" : "text-warn"}`}>
                {column.candidate.feasible ? "meets constraints" : "violates constraints"}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {variables.map((variable) => (
          <tr key={variable.param} className="border-b border-line">
            <th scope="row" className="px-2 py-[5px] text-left text-[13px] font-normal text-ink-2">
              {PARAM_BY_ID[variable.param].label}
            </th>
            {columns.map((column) => (
              <td key={column.label} className="num px-2 py-[5px] text-right text-[13px] text-accent">
                {formatParam(system, variable.param, column.candidate.geometry[variable.param])}
              </td>
            ))}
          </tr>
        ))}
        {metrics.map((metric, index) => (
          <tr key={metric} className={`border-b border-line ${index === 0 ? "border-t-2 border-t-line-strong" : ""}`}>
            <th scope="row" className="px-2 py-[5px] text-left text-[13px] font-normal text-ink-2">
              {METRIC_INFO[metric].label}
            </th>
            {columns.map((column) => (
              <td key={column.label} className="num px-2 py-[5px] text-right text-[13px] text-ink">
                {metricText(system, metric, column.candidate.metrics[metric as keyof DesignMetrics])}
              </td>
            ))}
          </tr>
        ))}
        <tr>
          <th scope="row" className="px-2 py-1 text-left text-[13px] font-normal text-ink-3">
            Show geometry
          </th>
          {columns.map((column) => (
            <td key={column.label} className="px-2 py-1 text-right">
              <Button size="sm" onClick={() => setGeometry(column.candidate.geometry)} title="Load this geometry into the editor and 3D view">
                Load
              </Button>
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

/** Searches the geometry parameter space for designs that best meet an objective under constraints. */
export function OptimizerPanel() {
  const geometry = useSimStore((state) => state.geometry);
  const mode = useSimStore((state) => state.mode);
  const system = useSettingsStore((state) => state.unitSystem);
  const demoMode = useSettingsStore((state) => state.demoMode);
  const backendOnline = useBackendStore((state) => state.status === "online");
  const task = useAnalysisStore((state) => state.optimization);

  const [objective, setObjective] = useState<Objective>("max-top-speed");
  const [engine, setEngine] = useState<AnalysisEngine>(() => initialEngine(mode));
  const [algorithm, setAlgorithm] = useState<OptimizationAlgorithm>("differential-evolution");
  const [iterations, setIterations] = useState(40);
  const [variables, setVariables] = useState(() => initialVariables(geometry));
  const [constraints, setConstraints] = useState<Constraint[]>([{ metric: "downforce", op: ">=", value: 150 }]);

  const activeVariables: DesignVariable[] = VARIABLE_CHOICES.filter((id) => variables[id].enabled).map((id) => ({
    param: id,
    min: Math.min(variables[id].min, variables[id].max),
    max: Math.max(variables[id].min, variables[id].max),
  }));

  const run = () => {
    const sim = useSimStore.getState();
    void executeOptimization({
      config: studyConfig(engine),
      spec: sim.spec,
      powertrain: sim.powertrain,
      objective,
      variables: activeVariables,
      constraints,
      algorithm,
      iterations,
      seed: 12345,
    });
  };

  const updateConstraint = (index: number, change: Partial<Constraint>) =>
    setConstraints(constraints.map((constraint, i) => (i === index ? { ...constraint, ...change } : constraint)));

  const plotMetric = objectiveMetric(task.result?.request.objective ?? objective);
  const plotInfo = METRIC_INFO[plotMetric];
  const plotUnit = plotInfo.quantity ? unitOf(system, plotInfo.quantity) : null;
  const historyRows: ChartRow[] = task.history.map((step) => ({
    iteration: step.iteration,
    value: plotUnit ? plotUnit.toDisplay(step.metrics[plotMetric]) : step.metrics[plotMetric],
  }));
  const milestones = task.history.filter(
    (step, index, all) => [0, 1, 10, 25, 50, 100].includes(step.iteration) || index === all.length - 1,
  );

  return (
    <div className="flex h-full min-h-0">
      <div className="scroll-thin w-[330px] shrink-0 overflow-y-auto border-r border-line p-2.5">
        <div className="label mb-1">Objective</div>
        <Select<Objective>
          ariaLabel="Optimisation objective"
          className="w-full"
          value={objective}
          options={OBJECTIVES.map((entry) => ({ value: entry.id, label: entry.label }))}
          onChange={setObjective}
        />

        <div className="mt-2.5 flex items-center justify-between">
          <span className="label">Constraints</span>
          <Button size="sm" variant="ghost" onClick={() => setConstraints([...constraints, { metric: "cd", op: "<=", value: 0.3 }])}>
            + Add
          </Button>
        </div>
        {constraints.length === 0 && <p className="text-xs text-ink-3">None. Only the variable bounds limit the search.</p>}
        {constraints.map((constraint, index) => {
          const info = METRIC_INFO[constraint.metric];
          const unit = info.quantity ? unitOf(system, info.quantity) : null;
          return (
            <div key={index} className="grid grid-cols-[1fr_44px_64px_28px_18px] items-center gap-1 py-px">
              <Select<ConstraintMetric>
                ariaLabel={`Constraint ${index + 1} metric`}
                value={constraint.metric}
                options={(Object.keys(METRIC_INFO) as ConstraintMetric[]).map((metric) => ({ value: metric, label: METRIC_INFO[metric].label }))}
                onChange={(metric) => updateConstraint(index, { metric })}
              />
              <Select
                ariaLabel={`Constraint ${index + 1} direction`}
                value={constraint.op}
                options={[
                  { value: ">=", label: "≥" },
                  { value: "<=", label: "≤" },
                ]}
                onChange={(op) => updateConstraint(index, { op })}
              />
              <NumberInput
                ariaLabel={`Constraint ${index + 1} limit`}
                value={unit ? unit.toDisplay(constraint.value) : constraint.value}
                decimals={info.decimals}
                onCommit={(display) => updateConstraint(index, { value: unit ? unit.fromDisplay(display) : display })}
              />
              <span className="num text-[11px] text-ink-3">{unit?.label ?? ""}</span>
              <button
                type="button"
                aria-label={`Remove constraint ${index + 1}`}
                className="text-ink-3 hover:text-err"
                onClick={() => setConstraints(constraints.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </div>
          );
        })}

        <div className="label mt-2.5 mb-1">Design variables and bounds</div>
        {VARIABLE_CHOICES.map((id) => {
          const definition = PARAM_BY_ID[id];
          const unit = unitOf(system, quantityOfParam(definition.kind));
          const decimals = definition.kind === "ratio" ? 2 : unit.decimals;
          const state = variables[id];
          const bound = (key: "min" | "max") => (
            <NumberInput
              ariaLabel={`${definition.label} ${key === "min" ? "lower" : "upper"} bound (${unit.label})`}
              disabled={!state.enabled}
              value={unit.toDisplay(state[key])}
              decimals={decimals}
              min={unit.toDisplay(definition.min)}
              max={unit.toDisplay(definition.max)}
              onCommit={(display) => setVariables({ ...variables, [id]: { ...state, [key]: unit.fromDisplay(display) } })}
            />
          );
          return (
            <div key={id} className="grid grid-cols-[1fr_52px_52px_22px] items-center gap-1">
              <Checkbox
                checked={state.enabled}
                label={<span className="truncate">{definition.label}</span>}
                onChange={(enabled) => setVariables({ ...variables, [id]: { ...state, enabled } })}
              />
              {bound("min")}
              {bound("max")}
              <span className="num text-[11px] text-ink-3">{unit.label}</span>
            </div>
          );
        })}

        <div className="label mt-2.5 mb-1">Search</div>
        <EngineSelect value={engine} onChange={setEngine} />
        <div className="mt-1 grid grid-cols-[1fr_70px] items-center gap-1">
          <Select<OptimizationAlgorithm>
            ariaLabel="Optimisation algorithm"
            value={algorithm}
            options={[
              { value: "differential-evolution", label: "Differential evolution (genetic)" },
              {
                value: "bayesian",
                label: backendOnline && !demoMode ? "Bayesian (GP, backend)" : "Bayesian (backend offline)",
                disabled: !backendOnline || demoMode,
              },
            ]}
            onChange={setAlgorithm}
          />
          <NumberInput ariaLabel="Iterations" value={iterations} decimals={0} min={5} max={300} step={5} onCommit={setIterations} />
        </div>
        <p className="mt-0.5 text-right text-[11px] text-ink-3">iterations</p>
        <div className="mt-1.5">
          <Button variant="primary" onClick={run} disabled={task.running || activeVariables.length === 0}>
            {task.running ? "Optimising…" : `Optimise ${activeVariables.length} variable${activeVariables.length === 1 ? "" : "s"}`}
          </Button>
        </div>
        <TaskStatus task={task} label="Optimisation progress" />
        {engine === "reduced-order" && (
          <p className="mt-2 text-xs leading-normal text-ink-3">
            Mode B solves the flow for every candidate: expect minutes for a full search. Mode A is instant.
          </p>
        )}
      </div>

      <div className="scroll-thin flex min-w-0 flex-1 flex-col gap-2 overflow-auto p-2">
        {task.history.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-ink-3">
            Set an objective, constraints and the variables the optimiser may change, then run it.
          </div>
        ) : (
          <>
            <div className="flex min-h-[170px] shrink-0 gap-2">
              <LineChartPanel
                title={`Best ${plotInfo.label.toLowerCase()} found versus iteration`}
                note={task.result ? `${task.result.algorithm} · ${task.result.provenance} · ${task.result.evaluations} evaluations` : "Running…"}
                data={historyRows}
                xKey="iteration"
                xLabel="Iteration"
                yLabel={`${plotInfo.label} (${plotUnit?.label || "–"})`}
                yDecimals={plotInfo.decimals}
                series={[{ key: "value", label: `Best ${plotInfo.label}`, decimals: plotInfo.decimals + 1 }]}
              />
              <div className="w-[230px] shrink-0 rounded-xl border border-line bg-panel p-3">
                <div className="label mb-1">Progress</div>
                <ul className="num space-y-0.5 text-xs">
                  {milestones.map((step) => (
                    <li key={step.iteration} className="flex justify-between gap-2">
                      <span className="text-ink-3">Iteration {step.iteration}</span>
                      <span className={step.feasible ? "text-ink" : "text-warn"}>
                        {metricText(system, plotMetric, step.metrics[plotMetric])}
                        {step.feasible ? "" : " ✕"}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] leading-normal text-ink-3">✕ = best design so far still violates a constraint.</p>
              </div>
            </div>
            {task.result && !task.result.best.feasible && (
              <div role="alert" className="border border-warn px-2.5 py-2 text-xs leading-normal text-ink">
                <p className="num mb-0.5 text-[11px] font-semibold tracking-wide text-warn">NO FEASIBLE DESIGN FOUND</p>
                No design inside these bounds satisfied every constraint in {task.result.evaluations} evaluations. The
                design shown as &ldquo;Best&rdquo; is only the one that comes closest; it still violates a constraint.
                Enable more design variables, widen their bounds, or relax the constraints.
              </div>
            )}
            {task.result && (
              <div>
                <CandidateTable candidates={task.result.candidates} baseline={task.result.baseline} variables={task.result.request.variables} />
                <p className="mt-1.5 text-xs leading-normal text-ink-3">
                  The optimiser found these designs according to the selected model. They are candidates to investigate,
                  not validated designs: confirm them with a higher-fidelity mode before relying on them.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
