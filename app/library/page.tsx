import type { Metadata } from "next";
import { LibraryWorkspace } from "@/components/dashboard/LibraryWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Library — AeroLab" };

export default function LibraryPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading…</div>}>
      <LibraryWorkspace />
    </ClientOnly>
  );
}
