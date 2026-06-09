"use client";

import { useState, useEffect, type ReactNode } from "react";

/**
 * Phase 10 — right-side overlay drawer.
 *
 * Houses everything that USED to live in tabs (Mobile share,
 * Flow items, Activity) plus a new Settings quick-view. The
 * drawer is closed by default — opens via the ≡ button in the
 * app bar OR a deep link (`?drawer=flow`).
 *
 * Open/closed state lives on the document body via the
 * `drawer-open` class so the overlay's pointer-events flip
 * correctly via CSS without React having to render two trees.
 */

export type DrawerPanel = "mobile" | "flow" | "activity" | "settings";

export interface DrawerTabConfig {
  key: DrawerPanel;
  label: string;
  /** Badge text shown next to the label (e.g. "3 new"). Null hides. */
  badge?: string | null;
  /** Tone of the badge background. */
  badgeTone?: "muted" | "warn" | "bad" | "ok" | "accent";
}

const TONE_CLASS: Record<NonNullable<DrawerTabConfig["badgeTone"]>, string> = {
  muted:  "bg-bg/40 text-muted",
  warn:   "bg-warn/15 text-warn",
  bad:    "bg-bad/15 text-bad",
  ok:     "bg-ok/15 text-ok",
  accent: "bg-accent/15 text-accent",
};

export default function BatchDrawer({
  open,
  onOpenChange,
  defaultPanel = "mobile",
  activePanel,
  onPanelChange,
  tabs,
  panels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPanel?: DrawerPanel;
  /** Optional controlled-mode prop: when set, the active tab is
   *  fully driven by the parent. Lets the PanelLauncher open the
   *  drawer pre-selected to a specific tab. */
  activePanel?: DrawerPanel;
  onPanelChange?: (panel: DrawerPanel) => void;
  tabs: DrawerTabConfig[];
  /** Map of panel key → ReactNode. The drawer only renders
   *  one at a time (the selected tab). */
  panels: Partial<Record<DrawerPanel, ReactNode>>;
}) {
  const [internalActive, setInternalActive] = useState<DrawerPanel>(defaultPanel);
  const active = activePanel ?? internalActive;
  const setActive = (p: DrawerPanel) => {
    setInternalActive(p);
    onPanelChange?.(p);
  };

  // Sync the body class so the CSS overlay + transform fire.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) {
      document.body.classList.add("drawer-open");
    } else {
      document.body.classList.remove("drawer-open");
    }
    return () => {
      document.body.classList.remove("drawer-open");
    };
  }, [open]);

  // Esc to close — drawer is dialog-like.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <>
      {/* Overlay — clicking it closes the drawer. CSS handles
          the visibility transition; React just provides the
          element + the onClick. */}
      <div
        className="drawer-overlay"
        onClick={() => onOpenChange(false)}
        aria-hidden={!open}
      />
      <aside
        className="drawer"
        role="dialog"
        aria-label="Side panels"
        aria-hidden={!open}
      >
        <div className="drawer-head">
          <button
            type="button"
            className="drawer-close"
            onClick={() => onOpenChange(false)}
            aria-label="Close drawer"
          >
            ×
          </button>
          <h2>Panels</h2>
          <div className="drawer-tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active === t.key}
                onClick={() => setActive(t.key)}
                className="drawer-tab inline-flex items-center gap-1.5"
              >
                <span>{t.label}</span>
                {t.badge && (
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                      TONE_CLASS[t.badgeTone ?? "muted"]
                    }`}
                  >
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="drawer-body">
          {tabs.map((t) => (
            <section
              key={t.key}
              className={`drawer-panel ${active === t.key ? "active" : ""}`}
              role="tabpanel"
              aria-hidden={active !== t.key}
            >
              {panels[t.key] ?? <DrawerEmpty label={t.label} />}
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}

function DrawerEmpty({ label }: { label: string }) {
  return (
    <div className="text-muted2 text-xs italic px-1 py-4">
      Nothing to show in {label} yet.
    </div>
  );
}
