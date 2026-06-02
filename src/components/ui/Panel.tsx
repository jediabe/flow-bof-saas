import type { ReactNode } from "react";

type Variant = "default" | "accent" | "ghost";

const VARIANT_CLASS: Record<Variant, string> = {
  default: "panel",
  accent:  "panel-accent",
  ghost:   "rounded-2xl border border-transparent bg-transparent",
};

/**
 * Surface primitive. Wraps a card with consistent rounding + hairline.
 *
 * - `default` — the standard panel.
 * - `accent`  — same but with the cyan glow ring (use sparingly: hero
 *   metric, current step).
 * - `ghost`   — invisible border, used when we want the layout of a
 *   panel without the visual frame.
 *
 * `title` + `action` give every panel a consistent header rail.
 */
export default function Panel({
  title,
  action,
  variant = "default",
  className = "",
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  variant?: Variant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${VARIANT_CLASS[variant]} ${className}`}>
      {(title || action) && (
        <header className="flex items-baseline justify-between px-5 pt-4 pb-2">
          {title && <h3 className="section-title">{title}</h3>}
          {action && <div className="text-xs">{action}</div>}
        </header>
      )}
      <div className="px-5 pb-5 pt-2">{children}</div>
    </section>
  );
}
