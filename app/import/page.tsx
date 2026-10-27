import type { Metadata } from "next";
import { ImportWorkspace } from "@/components/import/ImportWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Import a 3D model — AeroLab" };

export default function ImportPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading…</div>}>
      <ImportWorkspace />
    </ClientOnly>
  );
}
