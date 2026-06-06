"use client";

import { useState, type ReactNode } from "react";

/**
 * Phase 3 — top-level tab strip for the batch detail page.
 *
 * The batch page grew to 11 vertical sections over Phases 1-5. This
 * component buckets them into three top-level tabs:
 *
 *   - Products: the everyday workflow (metrics, Kalodata import, AI
 *     prompts, the product grid, image/video generation).
 *   - Mobile share: both QR cards (review + posting) on one tab so
 *     the user doesn't have to scroll past them to find products.
 *   - Activity: jobs list + latest task result panel.
 *
 * Why client-side (vs ?tab= URL param):
 *
 *   - All data is already server-rendered into the page; tabs just
 *     toggle visibility. No need to re-fetch on every click.
 *   - Latest task result panel is keyed on ?job=<id> — using
 *     ?tab= would collide with the existing query param contract.
 *
 * Trade-off accepted: tab state is lost on refresh. If that becomes
 * annoying we can persist to localStorage; ship the simpler version
 * first.
 */

export type TabKey = "products" | "mobile" | "flow" | "activity";

interface TabDef {
  key: TabKey;
  label: string;
  /** Badge text rendered next to the tab label — typically a count
   *  ("12 products", "2 unread"), or null to omit the badge. */
  badge?: string | null;
  /** Tone of the badge background. Defaults to "muted". */
  badgeTone?: "muted" | "ok" | "warn" | "bad" | "accent";
  content: ReactNode;
}

const TONE_CLASSES: Record<NonNullable<TabDef["badgeTone"]>, string> = {
  muted: "bg-bg/40 text-muted",
  ok:    "bg-ok/15 text-ok",
  warn:  "bg-warn/15 text-warn",
  bad:   "bg-bad/15 text-bad",
  accent:"bg-accent/15 text-accent",
};

export default function BatchTabs({
  tabs,
  initialTab = "products",
}: {
  tabs: TabDef[];
  initialTab?: TabKey;
}) {
  const [active, setActive] = useState<TabKey>(initialTab);

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="Batch sections"
        className="flex items-center gap-1 border-b border-border"
      >
        {tabs.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tab-${t.key}-panel`}
              type="button"
              onClick={() => setActive(t.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-2 ${
                isActive
                  ? "border-accent text-text"
                  : "border-transparent text-muted hover:text-text"
              }`}
            >
              <span>{t.label}</span>
              {t.badge && (
                <span
                  className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                    TONE_CLASSES[t.badgeTone ?? "muted"]
                  }`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          id={`tab-${t.key}-panel`}
          role="tabpanel"
          // Render all tabs to the DOM but hide inactive ones. Why
          // not unmount: AI prompt generation state lives inside
          // AiPromptsPanel; switching tabs while a run is in flight
          // would otherwise abort the live progress. Hidden tabs
          // keep their React tree intact.
          hidden={t.key !== active}
          className="space-y-6"
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}
