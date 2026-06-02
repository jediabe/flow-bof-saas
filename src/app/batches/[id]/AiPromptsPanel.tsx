"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import {
  generateAiPrompts,
  generateUkStorePrompts,
  type AiBulkReport,
  type BulkPromptReport,
} from "../actions";
import type { AiProviderKey } from "@/lib/ai/types";

/**
 * Batch-level "AI Prompt Generation" surface.
 *
 * One row of provider status + two action buttons:
 *   - "Generate AI Prompts" calls the configured provider (or the
 *     manual fallback when provider==="manual"). Mode toggle picks
 *     between "missing only" and "overwrite all".
 *   - "Use deterministic UK prompts" is the no-API-key escape hatch
 *     that always works. Same button BulkPromptButton offered before
 *     this refactor; lives here now so all prompt-gen is in one place.
 *
 * The result of either action lands inline in this panel — no
 * navigation, no full-page reload required. (revalidatePath on the
 * server still refreshes the Products grid.)
 */
export default function AiPromptsPanel({
  batchId,
  provider,
  providerLabel,
  providerHasKey,
}: {
  batchId: string;
  provider: AiProviderKey;
  providerLabel: string;
  providerHasKey: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"missing" | "all">("missing");
  const [aiReport, setAiReport] = useState<AiBulkReport | null>(null);
  const [manualReport, setManualReport] = useState<BulkPromptReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabledAi = pending || (provider !== "manual" && !providerHasKey);

  function runAi() {
    setError(null);
    setAiReport(null);
    setManualReport(null);
    startTransition(async () => {
      const r = await generateAiPrompts({ batchId, mode });
      setAiReport(r);
      if (!r.ok) setError(r.message);
    });
  }

  function runManual() {
    setError(null);
    setAiReport(null);
    setManualReport(null);
    startTransition(async () => {
      const r = await generateUkStorePrompts({
        batchId,
        overwrite: mode === "all",
      });
      setManualReport(r);
      if (!r.ok) setError(r.message);
    });
  }

  return (
    <section className="panel p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="section-title">AI Prompt Generation</div>
          <p className="text-xs text-muted mt-1">
            Author per-product image prompts, retailer placement, hook,
            caption, and hashtags. The deterministic UK prompt fallback
            below works without an API key.
          </p>
        </div>
        <Link
          href="/settings"
          className="text-[11px] text-accent hover:underline"
        >
          Provider settings →
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusChip label={`Provider: ${providerLabel}`} variant="muted" />
        {provider === "manual" ? (
          <StatusChip label="no API key required" variant="ok" />
        ) : providerHasKey ? (
          <StatusChip label="key configured" variant="ok" />
        ) : (
          <StatusChip label="missing API key" variant="bad" />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="block">
          <span className="label">Mode</span>
          <select
            className="field mt-1"
            value={mode}
            onChange={(e) => setMode(e.target.value as "missing" | "all")}
            disabled={pending}
          >
            <option value="missing">Products missing imagePrompt</option>
            <option value="all">All products (overwrite)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-end gap-2 ml-auto">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabledAi}
            onClick={runAi}
          >
            {pending ? "Generating…" : "Generate AI Prompts"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={runManual}
          >
            {pending ? "…" : "Use deterministic UK prompts"}
          </button>
        </div>
      </div>

      {provider !== "manual" && !providerHasKey && (
        <div className="rounded-2xl border border-warn/40 bg-warn/[0.06] text-sm text-warn px-4 py-3">
          The active provider has no API key yet. Add one in{" "}
          <Link href="/settings" className="underline">
            Settings → AI Providers
          </Link>{" "}
          — or use the deterministic UK prompts button to run without one.
        </div>
      )}

      {error && <div className="text-xs text-bad">⚠ {error}</div>}

      {aiReport && (
        <ReportPanel
          provider={aiReport.provider}
          message={aiReport.message}
          generated={aiReport.generated}
          skipped={aiReport.skipped}
          failed={aiReport.failed}
          failures={aiReport.failures}
        />
      )}
      {manualReport && (
        <ReportPanel
          provider="manual"
          message={manualReport.message}
          generated={manualReport.generated}
          skipped={manualReport.skipped}
        />
      )}
    </section>
  );
}

function ReportPanel({
  provider,
  message,
  generated,
  skipped,
  failed,
  failures,
}: {
  provider: string;
  message: string;
  generated: number;
  skipped: number;
  failed?: number;
  failures?: Array<{ productName: string; reason: string }>;
}) {
  return (
    <div className="rounded-2xl border border-border bg-panel2 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          label={failed ? "completed with errors" : "completed"}
          variant={failed ? "warn" : "ok"}
        />
        <span className="text-xs text-text">{message}</span>
        <span className="text-[11px] text-muted ml-auto">
          provider: {provider}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <Stat label="Generated" value={generated} tone="ok" />
        <Stat label="Skipped" value={skipped} tone="muted" />
        <Stat
          label="Failed"
          value={failed ?? 0}
          tone={failed ? "bad" : "muted"}
        />
      </div>
      {failures && failures.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted hover:text-text transition-colors">
            Failures ({failures.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {failures.map((f, i) => (
              <li key={i} className="text-muted">
                <span className="text-text">{f.productName}</span> —{" "}
                {f.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "ok" | "bad" | "muted";
}) {
  const cls =
    tone === "ok"
      ? "text-ok"
      : tone === "bad"
        ? "text-bad"
        : tone === "muted"
          ? "text-muted"
          : "text-text";
  return (
    <div>
      <div className="label">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}
