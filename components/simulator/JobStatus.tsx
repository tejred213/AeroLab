"use client";

import { useEffect, useState } from "react";
import { Badge, ProgressBar } from "@/components/ui/Layout";
import { useSimStore } from "@/lib/state/simStore";
import type { JobState } from "@/lib/types";

const STAGES: { state: JobState; label: string }[] = [
  { state: "PREPARING", label: "Preparing geometry" },
  { state: "MESHING", label: "Generating mesh" },
  { state: "SOLVING", label: "Running solver" },
  { state: "POST_PROCESSING", label: "Processing results" },
  { state: "COMPLETE", label: "Complete" },
];

const STATE_LABELS: Partial<Record<JobState, string>> = {
  QUEUED: "Queued",
  PREPARING: "Preparing",
  MESHING: "Meshing",
  SOLVING: "Solving",
  POST_PROCESSING: "Post-processing",
  COMPLETE: "Complete",
};

const ORDER: JobState[] = ["QUEUED", "PREPARING", "MESHING", "SOLVING", "POST_PROCESSING", "COMPLETE"];

/** Live status of the simulation job: stage list, progress bar and solver message. */
export function JobStatusCard() {
  const job = useSimStore((state) => state.job);
  const running = useSimStore((state) => state.running);
  const [visible, setVisible] = useState(false);

  // Stay on screen while running, then linger briefly after completion.
  useEffect(() => {
    if (running) {
      setVisible(true);
      return;
    }
    if (job?.state === "COMPLETE") {
      const timer = setTimeout(() => setVisible(false), 1800);
      return () => clearTimeout(timer);
    }
    setVisible(false);
  }, [running, job?.state]);

  if (!job || !visible) return null;
  const position = ORDER.indexOf(job.state);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-auto w-full rounded-2xl border border-line-strong bg-panel/95 p-3.5 shadow-xl shadow-black/50 backdrop-blur-md"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink">Simulation job</span>
        <Badge tone={job.state === "COMPLETE" ? "ok" : "accent"}>{STATE_LABELS[job.state] ?? job.state}</Badge>
      </div>
      <ol className="mb-3 space-y-1">
        {STAGES.map((stage) => {
          const index = ORDER.indexOf(stage.state);
          const done = index < position || job.state === "COMPLETE";
          const active = index === position && job.state !== "COMPLETE";
          return (
            <li key={stage.state} className={`flex items-center gap-2.5 text-xs ${done ? "text-ink-2" : active ? "font-medium text-ink" : "text-ink-3"}`}>
              <span aria-hidden className={`flex w-3 justify-center ${done ? "text-ok" : active ? "text-accent" : "text-line-strong"}`}>
                {done ? (
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <path d="M1.5 5.2 4 7.6 8.5 2.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <span className={`h-1.5 w-1.5 rounded-full bg-current ${active ? "animate-pulse" : ""}`} />
                )}
              </span>
              {stage.label}
            </li>
          );
        })}
      </ol>
      <ProgressBar value={job.progress} label="Simulation progress" />
      <p className="num mt-1.5 truncate text-[11px] text-ink-3">{job.message}</p>
    </div>
  );
}
