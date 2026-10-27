"use client";

import { useState } from "react";
import {
  type AnalysisEngine,
  EngineSelect,
  initialEngine,
  metricDecimals,
  metricDisplay,
  metricUnit,
  studyConfig,
  TaskStatus,
} from "@/components/simulator/AnalysisControls";
import { Button } from "@/components/ui/Button";
import { clampParam, PARAM_BY_ID } from "@/lib/geometry/parameters";
import { explainSweep } from "@/lib/simulation/explain";
import type { SweepMetric } from "@/lib/simulation/sweep";
import { executeSweep, useAnalysisStore } from "@/lib/state/analysisStore";
import { useSettingsStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import { useViewStore } from "@/lib/state/viewStore";
import type { GeometryParams, ParamId } from "@/lib/types";
import { formatParam } from "@/lib/utils/describe";

interface Question {
  id: string;
  /** Design-explorer label. */
  topic: string;
  question: string;
  param: ParamId;
  /** Changes from the current value, SI. The baseline (0) is always included. */
  deltas: number[];
  /** Adjusts the base geometry so the parameter has something to act on. */
  prepare?: (geometry: GeometryParams) => { geometry: GeometryParams; note: string } | null;
}

const ensureSpoiler: Question["prepare"] = (geometry) =>
  geometry.spoilerHeight >= 0.02
    ? null
    : {
        geometry: { ...geometry, spoilerHeight: 0.05 },
        note: "This vehicle has no lip spoiler, so a 50 mm blade is fitted for every step of this study, including its baseline.",
      };

const ensureDiffuser: Question["prepare"] = (geometry) =>
  geometry.diffuserLength >= 0.3
    ? null
    : {
        geometry: { ...geometry, diffuserLength: 0.6 },
        note: "The diffuser is very short on this vehicle, so a 0.6 m diffuser is used for every step of this study, including its baseline.",
      };

const QUESTIONS: Question[] = [
  { id: "ride", topic: "Ride height", question: "What happens if I reduce ride height?", param: "rideHeight", deltas: [-0.01, -0.02, -0.03] },
  { id: "roof", topic: "Roof angle", question: "What happens if I make the windshield more upright?", param: "windshieldAngle", deltas: [5, 10, 15] },
  { id: "rear", topic: "Rear slope", question: "What happens if I steepen the rear window?", param: "rearWindowAngle", deltas: [5, 10, 15] },
  { id: "spoiler", topic: "Spoiler angle", question: "What happens if I increase the spoiler angle?", param: "spoilerAngle", deltas: [6, 12, 18], prepare: ensureSpoiler },
  { id: "diffuser", topic: "Diffuser angle", question: "What happens if I increase the diffuser angle?", param: "diffuserAngle", deltas: [2, 4, 6], prepare: ensureDiffuser },
  { id: "splitter", topic: "Front splitter", question: "What happens if I extend the front splitter?", param: "splitterExtension", deltas: [0.025, 0.05, 0.075] },
  { id: "wheels", topic: "Wheel exposure", question: "What happens if the wheels are more exposed?", param: "wheelExposure", deltas: [0.15, 0.3, 0.45] },
];

const TABLE_METRICS: { metric: SweepMetric; label: string }[] = [
  { metric: "cd", label: "Cd" },
  { metric: "cl", label: "Cl" },
  { metric: "drag", label: "Drag" },
  { metric: "downforce", label: "Downforce" },
  { metric: "topSpeed", label: "Top speed" },
];

/**
 * Experiment mode / design explorer: pick a question, and the app builds the
 * baseline-plus-steps study, runs it and reports the comparison in neutral terms.
 */
export function ExplorerPanel() {
  const mode = useSimStore((state) => state.mode);
  const system = useSettingsStore((state) => state.unitSystem);
  const task = useAnalysisStore((state) => state.explorer);
  const setDockTab = useViewStore((state) => state.setDockTab);
  const [questionId, setQuestionId] = useState(QUESTIONS[0].id);
  const [engine, setEngine] = useState<AnalysisEngine>(() => initialEngine(mode));
  const [note, setNote] = useState<string | null>(null);
  const [ranQuestion, setRanQuestion] = useState<Question | null>(null);

  const question = QUESTIONS.find((entry) => entry.id === questionId) ?? QUESTIONS[0];

  const run = async () => {
    const sim = useSimStore.getState();
    const config = studyConfig(engine);
    const prepared = question.prepare?.(config.geometry) ?? null;
    const geometry = prepared?.geometry ?? config.geometry;
    const base = geometry[question.param];
    // Baseline first, then each step, dropping steps that fall outside the parameter's range.
    const values = [0, ...question.deltas]
      .map((delta) => clampParam(question.param, base + delta))
      .filter((value, index, all) => all.findIndex((other) => Math.abs(other - value) < 1e-9) === index);
    setNote(prepared?.note ?? null);
    setRanQuestion(question);
    await executeSweep("explorer", {
      config: { ...config, geometry },
      spec: sim.spec,
      powertrain: sim.powertrain,
      paramX: question.param,
      valuesX: values,
      paramY: null,
      valuesY: [],
    });
  };

  const result = task.result;
  const baseRow = result?.rows[0];
  return (
    <div className="flex h-full min-h-0">
      <div className="scroll-thin w-[300px] shrink-0 overflow-y-auto border-r border-line p-2.5">
        <div className="label mb-1">Which parameter do you want to investigate?</div>
        <div role="radiogroup" aria-label="Question to investigate">
          {QUESTIONS.map((entry) => {
            const selected = entry.id === questionId;
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setQuestionId(entry.id)}
                className={`flex w-full items-start gap-2 border-l-2 px-2 py-1 text-left ${
                  selected ? "border-accent bg-raise" : "border-transparent hover:bg-panel-2"
                }`}
              >
                <span aria-hidden className={`num mt-px text-xs ${selected ? "text-accent" : "text-ink-3"}`}>
                  {selected ? "●" : "○"}
                </span>
                <span>
                  <span className={`block text-[13px] ${selected ? "text-ink" : "text-ink-2"}`}>{entry.topic}</span>
                  <span className="block text-xs leading-normal text-ink-3">“{entry.question}”</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="label mt-2.5 mb-1">Engine</div>
        <EngineSelect value={engine} onChange={setEngine} />
        <div className="mt-2.5">
          <Button variant="primary" onClick={run} disabled={task.running}>
            {task.running ? "Running…" : "Run experiment"}
          </Button>
        </div>
        <TaskStatus task={task} label="Experiment progress" />
      </div>

      <div className="scroll-thin min-w-0 flex-1 overflow-auto p-3">
        {!result || !ranQuestion ? (
          <p className="text-[13px] text-ink-3">
            Pick a question. The study starts from the geometry currently in the editor and steps one parameter while
            everything else is held fixed.
          </p>
        ) : (
          <div className="flex flex-wrap gap-5">
            <div className="min-w-[380px] flex-1">
              <div className="mb-1 text-[13px] font-medium text-ink">“{ranQuestion.question}”</div>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-line-strong">
                    <th scope="col" className="label px-2 py-1 text-left font-normal">
                      {PARAM_BY_ID[ranQuestion.param].label}
                    </th>
                    {result.rows.map((row, index) => (
                      <th key={row.x} scope="col" className="num px-2 py-1 text-right text-[13px] font-medium text-ink">
                        <span className="label block">{index === 0 ? "Baseline" : `Step ${index}`}</span>
                        {formatParam(system, ranQuestion.param, row.x)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TABLE_METRICS.map(({ metric, label }) => (
                    <tr key={metric} className="border-b border-line">
                      <th scope="row" className="px-2 py-[5px] text-left text-[13px] font-normal text-ink-2">
                        {label} <span className="text-ink-3">({metricUnit(system, metric)})</span>
                      </th>
                      {result.rows.map((row, index) => {
                        const value = metricDisplay(system, row, metric);
                        const base = baseRow ? metricDisplay(system, baseRow, metric) : null;
                        const decimals = Math.min(metricDecimals(system, metric), 3);
                        return (
                          <td key={row.x} className="num px-2 py-[5px] text-right text-[13px] text-ink">
                            {value === null ? "n/a" : value.toFixed(decimals)}
                            {index > 0 && value !== null && base !== null && (
                              <span className="block text-[11px] text-ink-3">
                                {value - base >= 0 ? "+" : "−"}
                                {Math.abs(value - base).toFixed(decimals)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-ink-3">{result.provenance}. Small figures are changes from the baseline.</p>
              <Button
                size="sm"
                className="mt-2"
                onClick={() => {
                  useAnalysisStore.getState().patch("sweep", { result, error: null, progress: 1, running: false });
                  setDockTab("sweep");
                }}
              >
                Open as parameter sweep (charts)
              </Button>
            </div>
            <div className="w-[340px] shrink-0 space-y-2">
              <div className="label">Technical summary</div>
              {note && <p className="border-l-2 border-warn pl-2 text-xs leading-normal text-ink-2">{note}</p>}
              {explainSweep(result, system).map((paragraph) => (
                <p key={paragraph.slice(0, 40)} className="text-[13px] leading-normal text-ink-2">
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
