"use client";

import { type KeyboardEvent, type ReactNode, useRef } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Shown as a small marker after the label (e.g. a count). */
  badge?: ReactNode;
  /** Starts a new group: a divider is drawn before this tab. */
  divider?: boolean;
}

interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  size?: "sm" | "md";
  /** `underline` is a row of tabs over a pane; `segmented` is a compact switch between a few views. */
  variant?: "underline" | "segmented";
  className?: string;
}

/** Accessible tab list with arrow-key navigation. */
export function Tabs({ tabs, active, onChange, label, size = "md", variant = "underline", className = "" }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === active);
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    onChange(next.id);
    list.current?.querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)?.focus();
  };

  const segmented = variant === "segmented";
  const sizing = segmented ? "h-7 flex-1 px-2 text-xs" : size === "sm" ? "h-9 px-3 text-[13px]" : "h-10 px-3.5 text-[13px]";
  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={
        segmented
          ? `flex shrink-0 gap-0.5 rounded-[10px] border border-line bg-bg p-0.5 ${className}`
          : `scroll-thin flex shrink-0 overflow-x-auto overflow-y-hidden border-b border-line ${className}`
      }
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const state = segmented
          ? selected
            ? "border-line-strong bg-raise text-ink"
            : "border-transparent text-ink-3 hover:text-ink"
          : selected
            ? "border-accent text-ink"
            : "border-transparent text-ink-3 hover:text-ink";
        return (
          <span key={tab.id} className={segmented ? "flex flex-1" : "flex shrink-0 items-center"}>
            {tab.divider && !segmented && <span aria-hidden className="mx-1.5 h-4 w-px bg-line-strong" />}
            <button
              type="button"
              role="tab"
              data-tab={tab.id}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              className={`inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors ${
                segmented ? "border" : "-mb-px rounded-none border-b-2"
              } ${sizing} ${state}`}
            >
              {tab.label}
              {tab.badge !== undefined && (
                <span className="num rounded-full bg-raise px-1.5 text-[11px] leading-[18px] font-medium text-ink-2">{tab.badge}</span>
              )}
            </button>
          </span>
        );
      })}
    </div>
  );
}
