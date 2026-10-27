import type { Metadata } from "next";
import { RunsWorkspace } from "@/components/dashboard/RunsWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Saved runs — AeroLab" };

export default function RunsPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading…</div>}>
      <RunsWorkspace />
    </ClientOnly>
  );
}
