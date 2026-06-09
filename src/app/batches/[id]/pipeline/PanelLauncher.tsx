"use client";

import { type DrawerPanel, type DrawerTabConfig } from "./BatchDrawer";

/**
 * Phase 10 — discoverable entry points for the right-side drawer.
 *
 * Replaces the single, vague "≡ Panels" button with a row of
 * labeled buttons (icon + name + optional badge). Each button
 * opens the drawer to its specific tab. The badges scream "look
 * at me!" — they're the main discoverability mechanism for
 * unread work (e.g. "3 products need review on the mobile QR").
 *
 * Lives at the top of the pipeline section, immediately to the
 * right of the lane-action hint. It's the first thing the user
 * sees after the batch header, so the four workflow surfaces
 * inside the drawer are no longer hidden behind a meta-toggle.
 */

interface PanelLauncherButton {
  key: DrawerPanel;
  /** Short user-facing label. Keep to 1-2 words. */
  label: string;
  /** Emoji / unicode icon. */
  icon: string;
  /** Optional badge — typically a count of pending work. */
  badge?: string;
  /** Visual tone for the badge background. */
  badgeTone?: NonNullable<DrawerTabConfig["badgeTone"]>;
  /** Short tooltip explaining what this surface is for. */
  hint: string;
}

const TONE_CLASS: Record<NonNullable<DrawerTabConfig["badgeTone"]>, string> = {
  muted:  "bg-bg/40 text-muted",
  warn:   "bg-warn/15 text-warn",
  bad:    "bg-bad/15 text-bad",
  ok:     "bg-ok/15 text-ok",
  accent: "bg-accent/15 text-accent",
};

export default function PanelLauncher({
  badges,
  onOpen,
}: {
  /** Same shape the drawer takes — per-panel badge override. */
  badges?: Partial<
    Record<
      DrawerPanel,
      { text: string; tone?: DrawerTabConfig["badgeTone"] }
    >
  >;
  onOpen: (panel: DrawerPanel) => void;
}) {
  const buttons: PanelLauncherButton[] = [
    {
      key: "mobile",
      label: "Mobile QR",
      icon: "📱",
      hint: "Share a phone-friendly URL for reviewing approvals or copying posting copy.",
      badge: badges?.mobile?.text,
      badgeTone: badges?.mobile?.tone,
    },
    {
      key: "flow",
      label: "Flow items",
      icon: "🔗",
      hint: "Reconcile Flow's generated tiles with this batch's products. Bind / ignore / promote.",
      badge: badges?.flow?.text,
      badgeTone: badges?.flow?.tone,
    },
    {
      key: "activity",
      label: "Activity",
      icon: "⚡",
      hint: "Live job log for this batch. See what the runner is doing right now.",
      badge: badges?.activity?.text,
      badgeTone: badges?.activity?.tone,
    },
    {
      key: "settings",
      label: "Settings",
      icon: "⚙",
      hint: "AI provider, runner connection, market — read-only quick view.",
      badge: badges?.settings?.text,
      badgeTone: badges?.settings?.tone,
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={() => onOpen(b.key)}
          title={b.hint}
          className="btn text-xs gap-1.5 px-2.5 py-1.5 relative"
        >
          <span aria-hidden="true">{b.icon}</span>
          <span>{b.label}</span>
          {b.badge && (
            <span
              className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                TONE_CLASS[b.badgeTone ?? "muted"]
              }`}
            >
              {b.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
