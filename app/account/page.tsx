import type { Metadata } from "next";
import { AccountWorkspace } from "@/components/dashboard/AccountWorkspace";
import { ClientOnly } from "@/components/ui/Layout";

export const metadata: Metadata = { title: "Account — AeroLab" };

export default function AccountPage() {
  return (
    <ClientOnly fallback={<div className="flex h-dvh items-center justify-center text-[13px] text-ink-3">Loading…</div>}>
      <AccountWorkspace />
    </ClientOnly>
  );
}
