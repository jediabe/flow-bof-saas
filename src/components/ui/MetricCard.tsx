import type { ReactNode } from "react";

type Tone = "default" | "accent" | "ok" | "warn" | "bad" | "muted";

const VALUE_TONE: Record<Tone, string> = {
  default: "text-text",
  accent:  "text-accent",
  ok:      "text-ok",
  warn:    "text-warn",
  bad:     "text-bad",
  muted:   "text-muted",
};

/**
 * Big number tile. Used wherever a label + value sit together — the
 * dashboard pipeline summary, job-result counts, runner overview.
 *
 * `hint` is the small subline below the value (e.g. "1 batch" /
 * "last seen 2 minutes ago"). `icon` is optional emoji/JSX.
 */
export default function MetricCard({
  label,
  value,
  hint,
  tone = "default",
  icon,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panel p-5 ${className}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="label">{label}</div>
        {icon && <div className="text-muted text-lg leading-none">{icon}</div>}
      </div>
      <div className={`mt-2 text-3xl font-semibold tracking-tight ${VALUE_TONE[tone]}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}
