"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppLink } from "@/components/ui/AppLink";
import { Badge } from "@/components/ui/Layout";
import { Tooltip } from "@/components/ui/Tooltip";
import { describeBackend } from "@/lib/simulation/backendApi";
import { logOut, useAccountStore } from "@/lib/state/accountStore";
import { useArrival } from "@/lib/state/pageTransition";
import { refreshBackendStatus } from "@/lib/state/run";
import { useBackendStore, useSettingsStore } from "@/lib/state/settingsStore";

const NAV = [
  { href: "/simulator", label: "Simulator" },
  { href: "/compare", label: "Compare" },
  { href: "/library", label: "Library" },
  { href: "/validation", label: "Validation" },
  { href: "/settings", label: "Settings" },
];

function StatusDot() {
  return <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />;
}

/** Set by the deployment build (deploy/frontend/Dockerfile): the deployed site shows no backend badge. */
const SHOW_BACKEND_BADGE = process.env.NEXT_PUBLIC_AEROLAB_HIDE_BACKEND_BADGE !== "1";

/**
 * Checks whether the Python backend is reachable (sign-in, CFD and the account menu depend on it) and,
 * except on the deployed site, shows where simulations run.
 */
export function BackendBadge() {
  const status = useBackendStore((state) => state.status);
  const demoMode = useSettingsStore((state) => state.demoMode);
  const backendUrl = useSettingsStore((state) => state.backendUrl);

  useEffect(() => {
    void refreshBackendStatus();
  }, [demoMode, backendUrl]);

  if (!SHOW_BACKEND_BADGE) return null;
  if (demoMode || status === "offline") {
    return (
      <Tooltip
        content={
          demoMode
            ? "Demo mode: everything is computed in the browser with the analytical and reduced-order models. CFD (Mode C), the ML surrogate (Mode D) and Bayesian optimisation are unavailable."
            : "The Python backend is not reachable, so everything is computed in the browser with the analytical and reduced-order models. Start it with `npm run backend` to enable CFD case generation, the ML surrogate and Bayesian optimisation."
        }
      >
        <Badge tone="accent">
          <StatusDot />
          Demo / Analytical mode
        </Badge>
      </Tooltip>
    );
  }
  if (status === "online") {
    return (
      <Tooltip content={`Python backend connected at ${describeBackend(backendUrl)}.`}>
        <Badge tone="ok">
          <StatusDot />
          Backend online
        </Badge>
      </Tooltip>
    );
  }
  return <Badge>Checking backend…</Badge>;
}

/** Sign-in link, or the signed-in account with its saved runs and Mode C allowance. Hidden without a backend. */
export function AccountMenu() {
  const backendOnline = useBackendStore((state) => state.status === "online");
  const demoMode = useSettingsStore((state) => state.demoMode);
  const { status, user, cfdQuota } = useAccountStore();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (demoMode || !backendOnline || status === "unknown") return null;
  if (status === "signed-out" || !user) {
    return (
      <AppLink
        href="/account"
        className="flex h-8 shrink-0 items-center rounded-lg border border-line px-3 text-[13px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-panel-2"
      >
        Sign in
      </AppLink>
    );
  }
  const label = user.name || user.email;
  return (
    <div ref={menu} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 max-w-44 items-center gap-2 rounded-lg border border-line px-2 text-[13px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-panel-2"
        title={user.email}
      >
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-raise text-[11px] font-semibold uppercase text-ink">
          {label.slice(0, 1)}
        </span>
        <span className="truncate max-md:hidden">{label}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1.5 w-64 rounded-xl border border-line-strong bg-panel p-1.5 shadow-2xl shadow-black/60">
          <div className="px-2.5 pt-1.5 pb-2">
            <div className="truncate text-[13px] font-medium text-ink">{user.email}</div>
            {cfdQuota && (
              <div className="mt-0.5 text-xs leading-relaxed text-ink-3">
                CFD runs: {Math.max(cfdQuota.limit - cfdQuota.used, 0)} of {cfdQuota.limit} left in this {cfdQuota.windowMinutes}-minute window
              </div>
            )}
          </div>
          <AppLink role="menuitem" href="/runs" onClick={() => setOpen(false)} className="flex h-8 items-center rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-panel-2 hover:text-ink">
            Saved runs
          </AppLink>
          <AppLink role="menuitem" href="/account" onClick={() => setOpen(false)} className="flex h-8 items-center rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-panel-2 hover:text-ink">
            Account
          </AppLink>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logOut().catch(() => undefined);
            }}
            className="flex h-8 w-full items-center rounded-lg px-2.5 text-left text-[13px] text-ink-2 hover:bg-panel-2 hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

interface AppHeaderProps {
  /** Page-specific controls rendered between the navigation and the status badge. */
  children?: ReactNode;
}

export function AppHeader({ children }: AppHeaderProps) {
  const pathname = usePathname();
  // After a navigation the page under the header eases in; from the landing page the header does too (globals.css).
  const arrival = useArrival("app");
  return (
    // On phones the controls and status wrap onto a second row instead of being pushed off screen.
    <header
      data-app-header
      data-arriving={arrival ?? undefined}
      className="no-print sticky top-0 z-30 flex min-h-14 shrink-0 flex-wrap items-center gap-x-2.5 bg-bg/85 px-4 backdrop-blur-md max-sm:px-3"
    >
      <AppLink href="/" className="flex items-center gap-2.5 rounded-md" aria-label="AeroLab home">
        <svg width="22" height="22" viewBox="0 0 18 18" aria-hidden>
          <path d="M1 13 C5 13 6 5 10 5 C13 5 14 9 17 9" fill="none" stroke="var(--color-accent)" strokeWidth="1.9" strokeLinecap="round" />
          <path d="M1 16 H17" stroke="var(--color-ink)" strokeWidth="1" strokeLinecap="round" opacity="0.45" />
        </svg>
        <span className="text-base font-bold tracking-[-0.01em] text-ink font-stretch-expanded max-sm:hidden">AeroLab</span>
      </AppLink>
      <nav aria-label="Primary" className="scroll-none flex h-14 min-w-0 items-center gap-0.5 overflow-x-auto">
        {NAV.map((item) => {
          const active = pathname === item.href;
          return (
            <AppLink
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex h-8 shrink-0 items-center rounded-lg px-2 text-[13px] font-medium transition-colors ${
                active ? "bg-raise text-ink" : "text-ink-2 hover:bg-panel-2 hover:text-ink"
              }`}
            >
              {item.label}
            </AppLink>
          );
        })}
      </nav>
      {/* The controls keep their size; when they no longer fit beside the navigation they take a second row. */}
      <div className="flex flex-1 items-center justify-end gap-1.5 py-2.5 max-sm:min-w-0 max-sm:basis-full max-sm:pt-0">
        {children}
        <BackendBadge />
        <AccountMenu />
      </div>
    </header>
  );
}
