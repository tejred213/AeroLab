"use client";

import { type ReactNode, useCallback, useId, useRef, useState } from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** Render the trigger as a focusable info marker instead of wrapping existing content. */
  className?: string;
}

/**
 * Hover / focus tooltip. Positioned with fixed coordinates so it is never
 * clipped by scrolling panels.
 */
export function Tooltip({ content, children, className = "" }: TooltipProps) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);

  const show = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 8), window.innerWidth - width - 8);
    const above = rect.bottom + 120 > window.innerHeight;
    setPosition({ left, top: above ? rect.top - 6 : rect.bottom + 6, above });
  }, []);
  const hide = useCallback(() => setPosition(null), []);

  return (
    <span
      ref={anchor}
      className={`inline-flex ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={position ? id : undefined}
    >
      {children}
      {position && (
        <span
          id={id}
          role="tooltip"
          className="pointer-events-none fixed z-50 w-[280px] rounded-xl border border-line-strong bg-raise px-3 py-2.5 text-left text-xs leading-relaxed font-normal tracking-normal text-ink normal-case shadow-xl shadow-black/50 font-stretch-normal"
          style={{
            left: position.left,
            top: position.top,
            transform: position.above ? "translateY(-100%)" : undefined,
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}

/** Small "i" marker that carries an explanation; keyboard focusable. */
export function InfoTip({ content, label }: { content: ReactNode; label: string }) {
  return (
    <Tooltip content={content}>
      <span
        tabIndex={0}
        role="img"
        aria-label={`About ${label}`}
        className="inline-flex h-[15px] w-[15px] shrink-0 cursor-help items-center justify-center rounded-full border border-line-strong text-[10px] leading-none font-semibold text-ink-3 transition-colors hover:border-data hover:text-data"
      >
        i
      </span>
    </Tooltip>
  );
}
