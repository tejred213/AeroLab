"use client";

import { type ReactNode, useEffect, useId, useState } from "react";

/** Renders children only in the browser (persisted stores and WebGL have no server state). */
export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <>{mounted ? children : fallback}</>;
}

/** Disclosure arrow: points right when closed, down when open. */
export function Chevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden
      className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""} ${className}`}
    >
      <path d="M3.5 1.5 7 5 3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface SectionProps {
  title: string;
  children: ReactNode;
  /** Right-aligned content in the header (buttons, readouts). */
  actions?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
}

/** Titled block inside a panel; optionally collapsible. */
export function Section({ title, children, actions, collapsible = false, defaultOpen = true, className = "" }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const visible = !collapsible || open;
  const heading = "text-[13px] font-semibold font-stretch-semi-expanded text-ink";
  return (
    <section className={`border-b border-line ${className}`}>
      <div className="flex min-h-10 items-center justify-between gap-2 px-4">
        {collapsible ? (
          <button
            type="button"
            className={`-ml-1.5 flex flex-1 items-center gap-2 px-1.5 py-2 text-left ${heading}`}
            aria-expanded={open}
            aria-controls={contentId}
            onClick={() => setOpen(!open)}
          >
            <Chevron open={open} className="text-ink-3" />
            {title}
          </button>
        ) : (
          <h3 className={`py-2 ${heading}`}>{title}</h3>
        )}
        {actions}
      </div>
      {visible && (
        <div id={contentId} className="px-4 pb-3.5">
          {children}
        </div>
      )}
    </section>
  );
}

type Tone = "neutral" | "accent" | "data" | "ok" | "warn" | "err";

const TONES: Record<Tone, string> = {
  neutral: "bg-raise text-ink-2",
  accent: "bg-accent/15 text-accent",
  data: "bg-data/15 text-data",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  err: "bg-err/15 text-err",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Thin determinate progress bar with an accessible value. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-full overflow-hidden rounded-full bg-line"
    >
      <div className="h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Text used where a feature is deliberately not available. */
export function Unavailable({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-2xl bg-panel-2 px-5 py-4 text-[13px] leading-relaxed text-ink-2">
      {children}
    </p>
  );
}
