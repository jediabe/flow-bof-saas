"use client";

import { useState } from "react";
import StatusChip from "@/components/StatusChip";
import { checkProductIpRisk } from "../actions";
import type { IpRiskStatus } from "@/lib/ip-risk";

/**
 * Phase 9 — Batch-level IP / trademark risk surface.
 *
 * One panel at the top of the Products tab that shows:
 *   - Summary counts (low / medium / high / needs_review / override)
 *   - "Check IP risk for batch" button (with optional AI toggle)
 *   - Filter dropdown (All / Low / Medium / High / Needs review /
 *     Override approved) — drives the productFilter prop on the
 *     parent, which hides cards that don't match.
 *
 * The check button uses the same per-product server action as the
 * card-level check, fired N times in parallel with a small
 * concurrency cap. Live progress shown inline so the user can see
 * each product transition unchecked → checked.
 */

export type IpRiskFilter =
  | "all"
  | "low"
  | "medium"
  | "high"
  | "needs_manual_review"
  | "override_approved";

export interface IpRiskBatchProduct {
  id: string;
  productName: string;
  ipRiskStatus: IpRiskStatus;
  ipRiskOverride: boolean;
}

const MAX_CONCURRENCY = 3;

type ProductRunState =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "done"; status: IpRiskStatus }
  | { kind: "failed"; message: string };

export default function IpRiskBatchPanel({
  batchId,
  products,
  activeFilter,
  onFilterChange,
}: {
  batchId: string;
  products: IpRiskBatchProduct[];
  activeFilter: IpRiskFilter;
  onFilterChange: (next: IpRiskFilter) => void;
}) {
  const [useAi, setUseAi] = useState(false);
  const [running, setRunning] = useState(false);
  const [runStates, setRunStates] = useState<Map<string, ProductRunState>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);

  const counts = {
    total:    products.length,
    unchecked: products.filter((p) => p.ipRiskStatus === "unchecked").length,
    low:      products.filter((p) => p.ipRiskStatus === "low").length,
    medium:   products.filter((p) => p.ipRiskStatus === "medium").length,
    high:     products.filter((p) => p.ipRiskStatus === "high").length,
    review:   products.filter(
      (p) => p.ipRiskStatus === "needs_manual_review",
    ).length,
    override: products.filter((p) => p.ipRiskOverride).length,
  };

  async function runBatch() {
    setError(null);
    const targets = products;
    if (targets.length === 0) {
      setError("No products in this batch to check.");
      return;
    }

    const init = new Map<string, ProductRunState>();
    for (const p of targets) init.set(p.id, { kind: "queued" });
    setRunStates(init);
    setRunning(true);

    let cursor = 0;
    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= targets.length) return;
        const p = targets[idx];
        setRunStates((prev) => {
          const next = new Map(prev);
          next.set(p.id, { kind: "running" });
          return next;
        });
        try {
          const r = await checkProductIpRisk({
            batchId,
            productId: p.id,
            useAi,
          });
          setRunStates((prev) => {
            const next = new Map(prev);
            if (r.ok) {
              next.set(p.id, { kind: "done", status: r.status });
            } else {
              next.set(p.id, { kind: "failed", message: r.message });
            }
            return next;
          });
        } catch (err) {
          const e = err as Error;
          setRunStates((prev) => {
            const next = new Map(prev);
            next.set(p.id, {
              kind: "failed",
              message: e.message || "unknown error",
            });
            return next;
          });
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENCY, targets.length) },
        () => worker(),
      ),
    );
    setRunning(false);
  }

  // Derived progress counters
  const states = Array.from(runStates.values());
  const progress = {
    done:    states.filter((s) => s.kind === "done").length,
    failed:  states.filter((s) => s.kind === "failed").length,
    running: states.filter((s) => s.kind === "running").length,
    queued:  states.filter((s) => s.kind === "queued").length,
    total:   states.length,
  };

  return (
    <section className="panel p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="section-title">IP / Trademark Risk</div>
          <p className="text-xs text-muted mt-1">
            Conservative screening, not legal advice. High and needs-review
            products are excluded from image generation by default. The
            deterministic heuristic runs without an API key; the AI option
            (when configured) adds a second opinion.
          </p>
        </div>
      </div>

      {/* Summary counts */}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip label={`${counts.total} products`} variant="muted" />
        {counts.unchecked > 0 && (
          <StatusChip
            label={`${counts.unchecked} unchecked`}
            variant="muted"
          />
        )}
        {counts.low > 0 && (
          <StatusChip label={`${counts.low} low`} variant="ok" />
        )}
        {counts.medium > 0 && (
          <StatusChip label={`${counts.medium} medium`} variant="warn" />
        )}
        {counts.review > 0 && (
          <StatusChip label={`${counts.review} needs review`} variant="warn" />
        )}
        {counts.high > 0 && (
          <StatusChip label={`${counts.high} HIGH`} variant="bad" />
        )}
        {counts.override > 0 && (
          <StatusChip
            label={`${counts.override} override approved`}
            variant="accent"
          />
        )}
      </div>

      {/* Controls row: filter + check button */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="label">Filter products</span>
          <select
            className="field mt-1"
            value={activeFilter}
            onChange={(e) => onFilterChange(e.target.value as IpRiskFilter)}
            disabled={running}
          >
            <option value="all">All</option>
            <option value="low">Low risk</option>
            <option value="medium">Medium risk</option>
            <option value="high">High risk</option>
            <option value="needs_manual_review">Needs review</option>
            <option value="override_approved">Override approved</option>
          </select>
        </label>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted select-none pb-2">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => setUseAi(e.target.checked)}
              disabled={running}
              className="accent-accent"
            />
            with AI second opinion
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={running || products.length === 0}
            onClick={runBatch}
            title={
              useAi
                ? "Run the heuristic + AI on every product. Uses your configured AI provider."
                : "Run the deterministic heuristic on every product. No API key required."
            }
          >
            {running
              ? `Checking… ${progress.done + progress.failed}/${progress.total}`
              : "Check IP risk for batch"}
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-bad">⚠ {error}</div>}

      {/* Live progress list during / after a batch run */}
      {runStates.size > 0 && (
        <div className="rounded-2xl border border-border bg-panel2 p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <StatusChip
              label={
                running
                  ? `running ${progress.done + progress.failed}/${progress.total}`
                  : progress.failed > 0
                    ? "completed with errors"
                    : "completed"
              }
              variant={running ? "warn" : progress.failed > 0 ? "warn" : "ok"}
            />
            <span className="text-ok">{progress.done} done</span>
            {progress.failed > 0 && (
              <span className="text-bad">{progress.failed} failed</span>
            )}
            {progress.running > 0 && (
              <span className="text-accent">{progress.running} running</span>
            )}
            {progress.queued > 0 && (
              <span className="text-muted">{progress.queued} queued</span>
            )}
          </div>
          <ul className="divide-y divide-border max-h-72 overflow-y-auto">
            {products
              .filter((p) => runStates.has(p.id))
              .map((p) => {
                const state = runStates.get(p.id)!;
                return (
                  <ProgressRow
                    key={p.id}
                    productName={p.productName}
                    state={state}
                  />
                );
              })}
          </ul>
        </div>
      )}
    </section>
  );
}

function ProgressRow({
  productName,
  state,
}: {
  productName: string;
  state: ProductRunState;
}) {
  const dot =
    state.kind === "queued"
      ? "○"
      : state.kind === "running"
        ? "◐"
        : state.kind === "done"
          ? state.status === "high" || state.status === "needs_manual_review"
            ? "⚠"
            : "✓"
          : "✗";
  const tone =
    state.kind === "queued"
      ? "text-muted2"
      : state.kind === "running"
        ? "text-accent"
        : state.kind === "done"
          ? state.status === "high"
            ? "text-bad"
            : state.status === "needs_manual_review"
              ? "text-warn"
              : state.status === "medium"
                ? "text-warn"
                : "text-ok"
          : "text-bad";
  const label =
    state.kind === "queued"
      ? "queued"
      : state.kind === "running"
        ? "checking…"
        : state.kind === "done"
          ? state.status
          : state.message;
  return (
    <li className="py-1.5 flex items-center gap-3 text-xs">
      <span className={`shrink-0 w-4 text-center ${tone}`}>{dot}</span>
      <span className="flex-1 min-w-0 truncate text-text">{productName}</span>
      <span className={`text-[11px] ${tone} text-right truncate max-w-[40%]`}>
        {label}
      </span>
    </li>
  );
}
