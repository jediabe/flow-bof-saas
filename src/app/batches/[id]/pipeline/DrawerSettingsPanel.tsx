"use client";

import Link from "next/link";

/**
 * Phase 10 — Settings panel inside the drawer.
 *
 * Read-only quick-view of the most batch-relevant settings:
 *   - AI provider + model + key status
 *   - Connected runner version + status
 *   - Market this batch is set to
 *   - Vision-prompts on/off (workspace default)
 *
 * Edits happen on /settings — this panel just surfaces the
 * current state so the user doesn't have to leave the batch
 * page to know "yes, AI provider is configured" before clicking
 * Generate.
 */

export interface DrawerSettingsInfo {
  aiProviderLabel: string;
  aiProviderHasKey: boolean;
  runnerVersion: string | null;
  runnerConnected: boolean;
  batchMarket: "uk" | "us";
}

export default function DrawerSettingsPanel({
  info,
}: {
  info: DrawerSettingsInfo;
}) {
  return (
    <div className="space-y-3">
      <SettingRow
        label="AI provider"
        value={info.aiProviderLabel}
        good={info.aiProviderHasKey}
        badText={info.aiProviderHasKey ? null : "no API key"}
      />
      <SettingRow
        label="Connected runner"
        value={info.runnerVersion ?? "no runner"}
        good={info.runnerConnected}
        badText={info.runnerConnected ? null : "disconnected"}
      />
      <SettingRow
        label="Market"
        value={info.batchMarket === "us" ? "US TikTok Shop" : "UK TikTok Shop"}
        good
      />

      <div className="pt-3 mt-3 border-t border-border space-y-1.5 text-xs">
        <Link
          href="/settings"
          className="block text-accent hover:underline"
        >
          Open full settings →
        </Link>
        <Link
          href="/agents"
          className="block text-accent hover:underline"
        >
          Manage connected runner →
        </Link>
      </div>
    </div>
  );
}

function SettingRow({
  label,
  value,
  good,
  badText,
}: {
  label: string;
  value: string;
  good: boolean;
  badText?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between text-xs gap-3">
      <span className="text-muted">{label}</span>
      <span className={`text-right font-medium ${good ? "text-text" : "text-bad"}`}>
        {value}
        {badText && (
          <span className="text-bad text-[10px] ml-1">({badText})</span>
        )}
      </span>
    </div>
  );
}
