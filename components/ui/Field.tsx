"use client";

import { type ReactNode, useEffect, useId, useState } from "react";
import { InfoTip } from "@/components/ui/Tooltip";

interface NumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  decimals: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}

/**
 * Numeric text box that commits on Enter / blur, so half-typed values never
 * reach the model. Arrow keys nudge by one step.
 */
export function NumberInput({ value, onCommit, decimals, min, max, step = 1, disabled, ariaLabel, className = "" }: NumberInputProps) {
  const format = (v: number) => (Number.isFinite(v) ? v.toFixed(decimals) : "");
  const [text, setText] = useState(format(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, decimals, editing]);

  const commit = (raw: string) => {
    const parsed = Number(raw.replace(",", "."));
    if (raw.trim() === "" || !Number.isFinite(parsed)) {
      setText(format(value));
      return;
    }
    let next = parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onCommit(next);
    setText(format(next));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      disabled={disabled}
      value={text}
      onFocus={(event) => {
        setEditing(true);
        event.currentTarget.select();
      }}
      onChange={(event) => setText(event.target.value)}
      onBlur={(event) => {
        setEditing(false);
        commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit(event.currentTarget.value);
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setText(format(value));
          event.currentTarget.blur();
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const delta = (event.key === "ArrowUp" ? 1 : -1) * step * (event.shiftKey ? 10 : 1);
          commit(String(value + delta));
        }
        event.stopPropagation();
      }}
      className={`num h-7 w-full min-w-0 border border-line bg-bg px-2 text-right text-[13px] text-ink transition-colors hover:border-line-strong focus:border-data disabled:opacity-40 ${className}`}
    />
  );
}

interface FieldRowProps {
  label: string;
  unit?: string;
  tooltip?: ReactNode;
  children: ReactNode;
}

/** Label + control + unit on one dense row. */
export function FieldRow({ label, unit, tooltip, children }: FieldRowProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-[13px] text-ink-2">{label}</span>
        {tooltip && <InfoTip content={tooltip} label={label} />}
      </div>
      <div className="w-[88px] shrink-0">{children}</div>
      <span className="w-10 shrink-0 text-[11px] text-ink-3">{unit ?? ""}</span>
    </div>
  );
}

interface SelectProps<T extends string> {
  value: T;
  /** Options sharing a `group` are shown together under that heading, in order of first appearance. */
  options: { value: T; label: string; disabled?: boolean; group?: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  /** `md` matches the height of a default button, for toolbars. */
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
}

export function Select<T extends string>({ value, options, onChange, ariaLabel, size = "sm", className = "", disabled }: SelectProps<T>) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      className={`min-w-0 border border-line bg-bg pl-2 text-[13px] text-ink transition-colors hover:border-line-strong focus:border-data disabled:opacity-40 ${size === "md" ? "h-8" : "h-7"} ${className}`}
    >
      {options.some((option) => option.group)
        ? [...new Set(options.map((option) => option.group ?? ""))].map((group) => {
            const members = options
              .filter((option) => (option.group ?? "") === group)
              .map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ));
            return group ? (
              <optgroup key={group} label={group}>
                {members}
              </optgroup>
            ) : (
              members
            );
          })
        : options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
    </select>
  );
}

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  /** Explanation shown under the label. */
  hint?: ReactNode;
}

export function Checkbox({ checked, onChange, label, disabled, hint }: CheckboxProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      // `relative` keeps the visually-hidden input inside this label; otherwise it is positioned against
      // the page, escapes the panel's scroll clip and makes the whole document scrollable.
      className={`relative flex cursor-pointer gap-2 py-1 text-[13px] ${hint ? "items-start" : "items-center"} ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <input
        id={id}
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${hint ? "mt-0.5" : ""} peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-data ${
          checked ? "border-accent bg-accent text-accent-ink" : "border-line-strong bg-bg text-transparent"
        }`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 5.2 4.2 7.4 8 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="min-w-0">
        <span className={checked ? "text-ink" : "text-ink-2"}>{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-normal text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}
