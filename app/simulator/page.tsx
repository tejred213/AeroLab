import type { Metadata } from "next";
import { SimulatorWorkspace } from "@/components/simulator/SimulatorWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Simulator — AeroLab" };

export default function SimulatorPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading simulator…</div>}>
      <SimulatorWorkspace />
    </ClientOnly>
  );
}
