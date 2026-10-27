import type { Metadata } from "next";
import { SettingsWorkspace } from "@/components/dashboard/SettingsWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Settings — AeroLab" };

export default function SettingsPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading…</div>}>
      <SettingsWorkspace />
    </ClientOnly>
  );
}
