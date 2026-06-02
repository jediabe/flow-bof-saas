type Variant = "ok" | "warn" | "bad" | "accent" | "muted";

const CLASSES: Record<Variant, string> = {
  ok:     "chip chip-ok",
  warn:   "chip chip-warn",
  bad:    "chip chip-bad",
  accent: "chip chip-accent",
  muted:  "chip",
};

/**
 * Small status/badge chip. Colour by `variant` — see globals.css for
 * the .chip-* utility classes that back this.
 */
export default function StatusChip({
  label,
  variant = "muted",
  className = "",
}: {
  label: string;
  variant?: Variant;
  className?: string;
}) {
  return <span className={`${CLASSES[variant]} ${className}`}>{label}</span>;
}
