"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import {
  generateAiPromptForProduct,
  generateUkStorePrompts,
  type AiSingleResult,
  type BulkPromptReport,
} from "../actions";
import type { AiProviderKey } from "@/lib/ai/types";

/**
 * Batch-level "AI Prompt Generation" surface — Phase 3 redesign.
 *
 * The big change vs. the previous version: instead of one bulk
 * action that returns a single report at the end, the panel now
 * fires N parallel per-product server actions with a small
 * concurrency cap and updates a live progress list as each lands.
 * The user sees individual product names tick over from queued →
 * running → done / failed, and can see WHICH product blew up at
 * the moment it does — not at the end of a 90-second wait.
 *
 * The "Use deterministic UK prompts" button stays as-is: it's a
 * single bulk call with no AI cost, and the response is fast
 * enough that streaming per-product isn't worth the complexity.
 */

export type AiPromptProductRow = {
  id: string;
  productName: string;
  hasPrompt: boolean;
};

/** Per-row state in the live progress list. */
type RowState =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

const MAX_CONCURRENCY = 3;

export default function AiPromptsPanel({
  batchId,
  provider,
  providerLabel,
  providerHasKey,
  products,
}: {
  batchId: string;
  provider: AiProviderKey;
  providerLabel: string;
  providerHasKey: boolean;
  /** All non-deleted products in the batch. The panel filters down
   *  to the eligible set based on the mode selector. */
  products: AiPromptProductRow[];
}) {
  const [pendingManual, startManualTransition] = useTransition();
  const [mode, setMode] = useState<"missing" | "all">("missing");
  const [manualReport, setManualReport] = useState<BulkPromptReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // AI run state: a Map<productId, RowState> + a counter for the
  // summary line. Distinct from "pending" because per-product
  // failures shouldn't unmount the whole panel.
  const [aiRunning, setAiRunning] = useState(false);
  const [rowStates, setRowStates] = useState<Map<string, RowState>>(new Map());
  // Opt-in vision-enabled generation. When on, each AI call sends
  // the product's reference image alongside the text so the model
  // can describe specific visible details (exact colors, branding
  // placement, hardware) instead of guessing from the product
  // name. Requires a vision-capable model in Settings. Off by
  // default — vision tokens are more expensive than text.
  const [useVision, setUseVision] = useState(false);

  const disabledAi =
    aiRunning || pendingManual || (provider !== "manual" && !providerHasKey);

  function setRowState(productId: string, state: RowState) {
    setRowStates((prev) => {
      const next = new Map(prev);
      next.set(productId, state);
      return next;
    });
  }

  async function runAi() {
    setError(null);
    setManualReport(null);

    // Build the eligible list — in "missing" mode skip products
    // that already have a prompt; "all" mode hits everyone.
    const eligible = products.filter((p) => mode === "all" || !p.hasPrompt);
    if (eligible.length === 0) {
      setError(
        mode === "missing"
          ? "All products already have a prompt. Switch to 'All products' to regenerate."
          : "No products to generate for.",
      );
      return;
    }

    // Reset state and mark everyone queued.
    const init = new Map<string, RowState>();
    for (const p of eligible) init.set(p.id, { kind: "queued" });
    setRowStates(init);
    setAiRunning(true);

    // Concurrency-capped worker pool. Each worker pulls the next
    // queued product off a shared index and dispatches the server
    // action; updates state inline.
    let cursor = 0;
    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= eligible.length) return;
        const p = eligible[idx];
        setRowState(p.id, { kind: "running" });
        try {
          const r: AiSingleResult = await generateAiPromptForProduct({
            batchId,
            productId: p.id,
            force: mode === "all",
            useVision,
          });
          if (r.ok) {
            setRowState(p.id, { kind: "done", message: r.message });
          } else {
            setRowState(p.id, { kind: "failed", message: r.message });
          }
        } catch (err) {
          const e = err as Error;
          setRowState(p.id, {
            kind: "failed",
            message: e.message || "unknown error",
          });
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENCY, eligible.length) }, () =>
        worker(),
      ),
    );
    setAiRunning(false);
  }

  async function retryProduct(productId: string) {
    // Single-product retry from the "failed" row. Force=true so a
    // partial regenerate works even when the original mode was
    // "missing only".
    setRowState(productId, { kind: "running" });
    try {
      const r = await generateAiPromptForProduct({
        batchId,
        productId,
        force: true,
        useVision,
      });
      if (r.ok) {
        setRowState(productId, { kind: "done", message: r.message });
      } else {
        setRowState(productId, { kind: "failed", message: r.message });
      }
    } catch (err) {
      const e = err as Error;
      setRowState(productId, {
        kind: "failed",
        message: e.message || "unknown error",
      });
    }
  }

  function runManual() {
    setError(null);
    setManualReport(null);
    setRowStates(new Map());
    startManualTransition(async () => {
      const r = await generateUkStorePrompts({
        batchId,
        overwrite: mode === "all",
      });
      setManualReport(r);
      if (!r.ok) setError(r.message);
    });
  }

  // Derived counters for the summary line.
  const states = Array.from(rowStates.values());
  const counts = {
    queued: states.filter((s) => s.kind === "queued").length,
    running: states.filter((s) => s.kind === "running").length,
    done: states.filter((s) => s.kind === "done").length,
    failed: states.filter((s) => s.kind === "failed").length,
    total: states.length,
  };

  return (
    <section className="panel p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="section-title">AI Prompt Generation</div>
          <p className="text-xs text-muted mt-1">
            Per-product image prompts, retailer placement, hook, caption,
            and hashtags. Runs in parallel ({MAX_CONCURRENCY} at a time).
            The deterministic UK prompt fallback below works without an
            API key.
          </p>
        </div>
        <Link
          href="/settings"
          className="text-[11px] text-accent hover:underline"
        >
          Provider settings →
        </Link>
      </div>

      {/* Workflow reminder — call out that the Mobile QR review
          pass should happen FIRST so the user only spends AI
          tokens on products that are actually sellable + in
          stock on their TikTok Shop. */}
      <div className="rounded-2xl border border-accent/40 bg-accent/[0.06] text-xs text-accent px-4 py-3 leading-relaxed">
        <span className="font-semibold">Before generating image prompts:</span>{" "}
        use the <span className="font-semibold">Mobile QR</span> in the panel
        above to walk this batch on your phone — add each product to your
        TikTok Shop first to confirm it&apos;s actually sellable and in
        stock. Skipping that pass burns AI tokens on products you
        can&apos;t list anyway.
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
            disabled={aiRunning || pendingManual}
          >
            <option value="missing">Products missing imagePrompt</option>
            <option value="all">All products (overwrite)</option>
          </select>
        </label>
        <label
          className={`inline-flex items-center gap-1.5 text-[11px] select-none pb-2 ${
            provider === "manual" ? "text-muted2 cursor-not-allowed" : "text-muted"
          }`}
          title={
            provider === "manual"
              ? "Vision requires a non-manual AI provider (OpenAI / Anthropic / OpenRouter) configured in Settings."
              : "When on, the AI sees each product's reference image during prompt generation and describes specific visible details (exact colors, branding placement, hardware). Costs more per call but produces much more faithful prompts. Requires a vision-capable model (gpt-4o, claude-3.5-sonnet, etc.)."
          }
        >
          <input
            type="checkbox"
            checked={useVision}
            onChange={(e) => setUseVision(e.target.checked)}
            disabled={aiRunning || pendingManual || provider === "manual"}
            className="accent-accent"
          />
          analyse reference image (vision)
        </label>
        <div className="flex flex-wrap items-end gap-2 ml-auto">
          <button
            type="button"
            className="btn btn-primary"
            disabled={disabledAi}
            onClick={runAi}
          >
            {aiRunning
              ? `Generating… ${counts.done + counts.failed}/${counts.total}`
              : "Generate AI Prompts"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={pendingManual || aiRunning}
            onClick={runManual}
          >
            {pendingManual ? "…" : "Use deterministic UK prompts"}
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

      {/* Live AI progress list. Shows while a run is in flight AND
          after it completes so the user can review what happened
          without scrolling away. Cleared when the user starts the
          next run or switches to the manual button. */}
      {rowStates.size > 0 && (
        <div className="rounded-2xl border border-border bg-panel2 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip
              label={
                aiRunning
                  ? `running ${counts.done + counts.failed}/${counts.total}`
                  : counts.failed > 0
                    ? "completed with errors"
                    : "completed"
              }
              variant={
                aiRunning ? "warn" : counts.failed > 0 ? "warn" : "ok"
              }
            />
            <Stat label="Done" value={counts.done} tone="ok" />
            <Stat label="Failed" value={counts.failed} tone={counts.failed ? "bad" : "muted"} />
            <Stat label="Running" value={counts.running} tone={counts.running ? "accent" : "muted"} />
            <Stat label="Queued" value={counts.queued} tone="muted" />
          </div>
          <ul className="divide-y divide-border max-h-72 overflow-y-auto">
            {products
              .filter((p) => rowStates.has(p.id))
              .map((p) => {
                const state = rowStates.get(p.id)!;
                return (
                  <ProgressRow
                    key={p.id}
                    productName={p.productName}
                    state={state}
                    onRetry={
                      state.kind === "failed"
                        ? () => retryProduct(p.id)
                        : undefined
                    }
                  />
                );
              })}
          </ul>
        </div>
      )}

      {manualReport && (
        <div className="rounded-2xl border border-border bg-panel2 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip label="completed" variant="ok" />
            <span className="text-xs text-text">{manualReport.message}</span>
            <span className="text-[11px] text-muted ml-auto">
              provider: manual
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Stat label="Generated" value={manualReport.generated} tone="ok" />
            <Stat label="Skipped" value={manualReport.skipped} tone="muted" />
          </div>
        </div>
      )}
    </section>
  );
}

function ProgressRow({
  productName,
  state,
  onRetry,
}: {
  productName: string;
  state: RowState;
  onRetry?: () => void;
}) {
  const label =
    state.kind === "queued"
      ? "queued"
      : state.kind === "running"
        ? "running…"
        : state.kind === "done"
          ? state.message
          : state.message;
  const dot =
    state.kind === "queued"
      ? "○"
      : state.kind === "running"
        ? "◐"
        : state.kind === "done"
          ? "✓"
          : "✗";
  const tone =
    state.kind === "queued"
      ? "text-muted2"
      : state.kind === "running"
        ? "text-accent"
        : state.kind === "done"
          ? "text-ok"
          : "text-bad";
  return (
    <li className="py-1.5 flex items-center gap-3 text-xs">
      <span className={`shrink-0 w-4 text-center ${tone}`}>{dot}</span>
      <span className="flex-1 min-w-0 truncate text-text">{productName}</span>
      <span className={`text-[11px] ${tone} text-right truncate max-w-[60%]`}>
        {label}
      </span>
      {onRetry && (
        <button
          type="button"
          className="text-[10px] text-accent hover:underline"
          onClick={onRetry}
        >
          retry
        </button>
      )}
    </li>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "ok" | "bad" | "muted" | "accent";
}) {
  const cls =
    tone === "ok"
      ? "text-ok"
      : tone === "bad"
        ? "text-bad"
        : tone === "accent"
          ? "text-accent"
          : tone === "muted"
            ? "text-muted"
            : "text-text";
  return (
    <span className="inline-flex items-baseline gap-1 text-[11px]">
      <span className="text-muted">{label}:</span>
      <span className={`font-semibold ${cls}`}>{value}</span>
    </span>
  );
}
