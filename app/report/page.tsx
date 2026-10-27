import type { Metadata } from "next";
import { ReportView } from "@/components/dashboard/ReportView";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Simulation report — AeroLab" };

export default function ReportPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading report…</div>}>
      <ReportView />
    </ClientOnly>
  );
}
