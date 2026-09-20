/**
 * SkillFuse 的基础 UI 组件。
 * 各步骤页面共用这一套按钮 / 卡片 / 徽标，避免同一种控件在四个页面里长出四种样子。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, ChevronDown, Copy, Info, X, XCircle } from "lucide-react";
import { ToastCtx, type ToastInput } from "./toast-context";
import type { Tone } from "./severity";
import { cn } from "@/lib/utils";

/* ---------------- button ---------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "subtle" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/95",
  secondary: "border bg-card text-foreground hover:bg-muted",
  subtle: "border border-primary/35 bg-primary/5 text-primary hover:bg-primary/10",
  ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
  danger: "border border-destructive/40 bg-destructive/5 text-destructive hover:bg-destructive/10",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-md px-2.5 text-[12px]",
  md: "h-10 gap-2 rounded-lg px-4 text-[13.5px]",
  lg: "h-12 gap-2 rounded-lg px-6 text-[14px]",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/* ---------------- surfaces ---------------- */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border bg-card", className)}>{children}</div>;
}

export function SectionLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cn(
        "font-code text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function EmptyState({ icon: Icon, title, sub }: { icon: typeof Info; title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card px-6 py-12 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.5} />
      <p className="mt-3 text-[13.5px] font-medium text-foreground">{title}</p>
      {sub && <p className="mt-1 max-w-sm text-[12.5px] leading-relaxed text-muted-foreground">{sub}</p>}
    </div>
  );
}

/* ---------------- badge ---------------- */

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  primary: "border-primary/25 bg-primary/10 text-primary",
  success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  danger: "border-red-500/25 bg-red-500/10 text-red-600 dark:text-red-400",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------- segmented control ---------------- */

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex flex-wrap items-center gap-1 rounded-lg border bg-muted/60 p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
            value === o.value
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined && (
            <span className="font-code text-[10.5px] text-muted-foreground">{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ---------------- toggle ---------------- */

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted-foreground/30",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

/* ---------------- score ring ---------------- */

export function ScoreRing({
  value,
  max = 100,
  size = 104,
  caption,
  tone,
}: {
  value: number;
  max?: number;
  size?: number;
  caption?: string;
  tone: Tone;
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const stroke = 9;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color =
    tone === "success" ? "hsl(var(--success))" : tone === "warning" ? "hsl(var(--warning))" : "hsl(var(--destructive))";

  return (
    <div className="flex shrink-0 flex-col items-center" style={{ width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct)}
            style={{ transition: "stroke-dashoffset 600ms cubic-bezier(0.22,1,0.36,1)" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[26px] font-extrabold leading-none tracking-tight">{Math.round(value)}</span>
          <span className="font-code text-[10px] text-muted-foreground">/ {max}</span>
        </div>
      </div>
      {caption && <p className="mt-2 text-center text-[11.5px] font-medium text-muted-foreground">{caption}</p>}
    </div>
  );
}

/* ---------------- collapsible ---------------- */

export function Collapsible({
  title,
  subtitle,
  defaultOpen = false,
  right,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")}
          />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-semibold">{title}</span>
            {subtitle && <span className="block truncate text-[12px] text-muted-foreground">{subtitle}</span>}
          </span>
        </button>
        {right}
      </div>
      {open && <div className="border-t px-4 py-3.5">{children}</div>}
    </Card>
  );
}

/* ---------------- copy button ---------------- */

export function CopyIconButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? "已复制" : label}
    </Button>
  );
}

/* ---------------- toasts ---------------- */

interface Toast extends ToastInput {
  id: number;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setToasts((list) => [...list, { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.kind === "error" ? 7000 : 3600);
  }, []);

  const icon = { success: Check, error: XCircle, info: Info } as const;

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(380px,calc(100vw-40px))] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = icon[t.kind];
          return (
            <div
              key={t.id}
              role="status"
              className={cn(
                "animate-in-up pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-card p-3 shadow-lg",
                t.kind === "error" && "border-destructive/30",
                t.kind === "success" && "border-emerald-500/30",
              )}
            >
              <Icon
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  t.kind === "error" ? "text-destructive" : t.kind === "success" ? "text-emerald-500" : "text-primary",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium leading-snug">{t.message}</p>
                {t.detail && <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{t.detail}</p>}
              </div>
              <button
                onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                aria-label="关闭提示"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- modal shell ---------------- */

export function Modal({
  open,
  onClose,
  title,
  sub,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={cn("animate-in-up w-full rounded-xl border bg-card shadow-2xl", width)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <h2 className="text-[16px] font-bold tracking-tight">{title}</h2>
            {sub && <div className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{sub}</div>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-between gap-3 border-t px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}
