"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { MODE_LABELS } from "@/components/dashboard/ResultsPanel";
import { AppHeader } from "@/components/ui/AppHeader";
import { AppLink } from "@/components/ui/AppLink";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Layout";
import { deleteRun, fetchRun, listRuns, type SavedRun } from "@/lib/simulation/backendApi";
import { useAccountStore } from "@/lib/state/accountStore";
import { leavePage } from "@/lib/state/pageTransition";
import { recordExternalResult } from "@/lib/state/run";
import { useBackendStore } from "@/lib/state/settingsStore";
import { useSimStore } from "@/lib/state/simStore";
import { findVehicle } from "@/lib/vehicle/library";

const FINAL = new Set(["COMPLETE", "FAILED"]);

function vehicleName(id: string): string {
  return findVehicle(id, useSimStore.getState().customVehicles)?.name ?? id;
}

function expiresIn(run: SavedRun, now: number): string {
  const days = (run.expiresAt * 1000 - now) / 86400000;
  if (days >= 1) return `${Math.ceil(days)} d`;
  const hours = Math.max(days * 24, 0);
  return hours >= 1 ? `${Math.floor(hours)} h` : "< 1 h";
}

function duration(seconds: number | null): string {
  if (seconds === null) return "";
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s` : `${seconds.toFixed(0)} s`;
}

/** Opens a saved run in the simulator: its configuration goes into the editor and its result is shown. */
async function openRun(id: string): Promise<void> {
  const run = await fetchRun(id);
  if (!run.result) throw new Error("This run has no result to open.");
  const sim = useSimStore.getState();
  const vehicle = findVehicle(run.config.vehicleId, sim.customVehicles);
  if (vehicle) sim.loadVehicle(vehicle, run.config.geometry);
  else sim.setGeometry(run.config.geometry);
  sim.setEnvironment(run.config.environment);
  sim.setSpeed(run.config.speed);
  sim.setMode(run.config.mode);
  sim.setFidelity(run.config.fidelity);
  await recordExternalResult(run.result);
}

function StateBadge({ run }: { run: SavedRun }) {
  if (run.state === "COMPLETE") return <Badge tone="ok">Complete</Badge>;
  if (run.state === "FAILED") return <Badge tone="err">Failed</Badge>;
  return <Badge tone="data">{run.message || run.state.toLowerCase()}</Badge>;
}

function RunsTable() {
  const router = useRouter();
  const retentionDays = useAccountStore((state) => state.retentionDays);
  const [runs, setRuns] = useState<SavedRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setRuns(await listRuns());
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The runs could not be loaded.");
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Runs that are still going are refreshed until they finish.
  const pending = runs?.some((run) => !FINAL.has(run.state)) ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const open = async (id: string) => {
    setBusy(id);
    try {
      await openRun(id);
      leavePage((to) => router.push(to), "/simulator");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The run could not be opened.");
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    try {
      await deleteRun(id);
      setRuns((current) => current?.filter((run) => run.id !== id) ?? null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The run could not be deleted.");
    }
    setBusy(null);
  };

  return (
    <>
      <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed text-ink-2">
        Every simulation that ran on the backend under your account.
        {retentionDays !== null && ` Runs and their CFD case files are deleted ${retentionDays} days after they started.`} Opening a run
        loads its configuration into the simulator and adds its result to your experiment history in this browser.
      </p>
      {error && (
        <p role="alert" className="mt-4 text-[13px] text-err">
          {error}
        </p>
      )}
      {runs === null && !error && <p className="mt-6 text-[13px] text-ink-3">Loading…</p>}
      {runs?.length === 0 && (
        <p className="mt-6 text-[13px] text-ink-3">
          No saved runs yet. Run Mode C or D in the <AppLink href="/simulator" className="text-data hover:underline">simulator</AppLink> and it
          appears here.
        </p>
      )}
      {runs && runs.length > 0 && (
        <div className="mt-5 overflow-x-auto rounded-2xl border border-line bg-panel">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="text-xs text-ink-3">
              <tr className="border-b border-line">
                <th className="px-4 py-2.5 font-medium">Started</th>
                <th className="px-3 py-2.5 font-medium">Vehicle</th>
                <th className="px-3 py-2.5 font-medium">Mode</th>
                <th className="px-3 py-2.5 font-medium">State</th>
                <th className="px-3 py-2.5 text-right font-medium">Cd</th>
                <th className="px-3 py-2.5 text-right font-medium">Cl</th>
                <th className="px-3 py-2.5 font-medium">Mesh · time</th>
                <th className="px-3 py-2.5 font-medium">Deleted in</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">{new Date(run.createdAt * 1000).toLocaleString()}</td>
                  <td className="max-w-48 truncate px-3 py-2.5 text-ink">{vehicleName(run.vehicleId)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">
                    {MODE_LABELS[run.mode].short}
                    {run.mode === "cfd" || run.mode === "reduced-order" ? ` · ${run.fidelity}` : ""}
                  </td>
                  <td className="px-3 py-2.5" title={run.error?.message}>
                    <StateBadge run={run} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">{run.coefficients ? run.coefficients.cd.toFixed(4) : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">{run.coefficients ? run.coefficients.cl.toFixed(4) : "—"}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-ink-3">
                    {run.cached
                      ? "Same configuration as an earlier run; result reused"
                      : [run.cells ? `${run.cells.toLocaleString()} cells` : "", duration(run.wallTimeS)].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-ink-3">{expiresIn(run, now)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" disabled={run.state !== "COMPLETE" || busy !== null} onClick={() => void open(run.id)}>
                        {busy === run.id ? "Opening…" : "Open"}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void remove(run.id)} aria-label="Delete this run">
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function RunsWorkspace() {
  const status = useAccountStore((state) => state.status);
  const backend = useBackendStore((state) => state.status);
  return (
    <div className="grid-backdrop flex min-h-dvh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-8 pt-8 pb-16 max-sm:px-4 max-sm:pt-5">
        <h1 className="text-[clamp(26px,2.6vw,34px)] leading-[1.08] font-semibold tracking-[-0.02em] text-ink font-stretch-expanded">Saved runs</h1>
        {status === "signed-in" ? (
          <RunsTable />
        ) : (
          <p className="mt-3 text-[13px] text-ink-2">
            {backend === "offline"
              ? "The backend is not reachable, so saved runs are unavailable."
              : status === "signed-out"
                ? <>Saved runs belong to an account. <AppLink href="/account" className="text-data hover:underline">Sign in</AppLink> to see yours.</>
                : "Connecting to the backend…"}
          </p>
        )}
      </main>
    </div>
  );
}
