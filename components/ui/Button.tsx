import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

/** `tool` is the borderless button used inside a ButtonGroup. */
type Variant = "primary" | "default" | "ghost" | "danger" | "tool";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  active?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink border-accent hover:brightness-110 font-semibold",
  default: "bg-transparent text-ink border-line-strong hover:border-ink-3 hover:bg-panel-2",
  ghost: "bg-transparent text-ink-2 border-transparent hover:text-ink hover:bg-raise",
  danger: "bg-transparent text-err border-line-strong hover:border-err",
  tool: "bg-transparent text-ink-2 border-transparent hover:text-ink hover:bg-raise/70",
};

const ACTIVE: Record<Variant, string> = {
  primary: "",
  default: "!border-data/70 !bg-data/10 !text-data",
  ghost: "!bg-raise !text-ink",
  danger: "",
  tool: "!border-line-strong !bg-raise !text-ink",
};

export function Button({ variant = "default", size = "md", active = false, className = "", children, ...rest }: ButtonProps) {
  const sizing = size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3.5 text-[13px]";
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sizing} ${VARIANTS[variant]} ${active ? ACTIVE[variant] : ""} ${className}`}
      aria-pressed={active || undefined}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Floating strip that holds a row of `tool` buttons (viewport toolbars, small toggles). */
export function ButtonGroup({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="group" className={`gap-0.5 rounded-[10px] border border-line bg-panel/85 p-0.5 backdrop-blur-md ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Keyboard shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong bg-bg/60 px-1 font-sans text-[10px] font-medium text-ink-3">
      {children}
    </kbd>
  );
}
