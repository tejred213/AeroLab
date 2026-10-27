import type { Metadata } from "next";
import { ValidationWorkspace } from "@/components/dashboard/ValidationWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Validation — AeroLab" };

export default function ValidationPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading…</div>}>
      <ValidationWorkspace />
    </ClientOnly>
  );
}
