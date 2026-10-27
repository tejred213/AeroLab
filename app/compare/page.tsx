import type { Metadata } from "next";
import { CompareWorkspace } from "@/components/dashboard/CompareWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Compare — AeroLab" };

export default function ComparePage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading…</div>}>
      <CompareWorkspace />
    </ClientOnly>
  );
}
