"use client";

import { useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import {
  checkProductIpRisk,
  setProductIpRiskOverride,
} from "../actions";
import type { IpRiskStatus } from "@/lib/ip-risk";

/**
 * Phase 9 — IP / trademark risk row on the product card.
 *
 * Self-contained UI: status chip + reasons display + "Check IP
 * risk" button (with optional "Run with AI" toggle) + override
 * form (only shown for high / needs_manual_review statuses).
 *
 * Hard wording rules (verbatim from the Phase 9 spec):
 *   - System messaging says "Potential IP/trademark risk
 *     detected. Review manually before generating content."
 *   - NEVER "this product is illegal."
 *   - Override requires a written reason for high or
 *     needs_manual_review products.
 *
 * Persistence:
 *   - "Check" calls checkProductIpRisk → writes ipRiskStatus +
 *     ipRiskReasons + ipRiskCheckedAt.
 *   - "Set override" / "Clear override" call
 *     setProductIpRiskOverride → writes ipRiskOverride +
 *     ipRiskOverrideReason + ipRiskOverrideAt.
 *   Both server actions revalidate the batch page; this component
 *   updates its local result state immediately for snappier UX,
 *   the page revalidate brings the props in sync afterwards.
 */

export interface IpRiskRowProduct {
  id: string;
  batchId: string;
  ipRiskStatus: IpRiskStatus;
  ipRiskReasons: string[];
  ipRiskCheckedAt: string | null;
  ipRiskOverride: boolean;
  ipRiskOverrideReason: string | null;
  ipRiskOverrideAt: string | null;
}

const STATUS_LABEL: Record<IpRiskStatus, string> = {
  unchecked:           "IP risk: unchecked",
  low:                 "IP risk: low",
  medium:              "IP risk: medium",
  high:                "IP risk: HIGH",
  needs_manual_review: "IP risk: needs review",
};

const STATUS_VARIANT: Record<IpRiskStatus, "ok" | "warn" | "bad" | "muted"> = {
  unchecked:           "muted",
  low:                 "ok",
  medium:              "warn",
  high:                "bad",
  needs_manual_review: "warn",
};

const RISKY_STATUSES = new Set<IpRiskStatus>(["high", "needs_manual_review"]);

export default function IpRiskRow({
  product,
}: {
  product: IpRiskRowProduct;
}) {
  const [checking, startCheckTransition] = useTransition();
  const [overrideSaving, startOverrideTransition] = useTransition();
  const [useAi, setUseAi] = useState(false);
  const [useVision, setUseVision] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overrideReason, setOverrideReason] = useState(
    product.ipRiskOverrideReason ?? "",
  );

  function runCheck() {
    setError(null);
    startCheckTransition(async () => {
      const r = await checkProductIpRisk({
        batchId:   product.batchId,
        productId: product.id,
        useAi,
        // Vision implies AI — guard against the UI letting the user
        // tick vision without AI (the server action also enforces).
        useVision: useAi && useVision,
      });
      if (!r.ok) setError(r.message);
    });
  }

  function applyOverride(enable: boolean) {
    setError(null);
    const fd = new FormData();
    fd.set("batchId", product.batchId);
    fd.set("productId", product.id);
    fd.set("override", enable ? "true" : "false");
    if (enable) fd.set("reason", overrideReason);
    startOverrideTransition(async () => {
      const r = await setProductIpRiskOverride(fd);
      if (!r.ok) setError(r.message);
      else if (enable) setShowOverrideForm(false);
    });
  }

  const isRisky = RISKY_STATUSES.has(product.ipRiskStatus);
  const showOverrideArea = isRisky || product.ipRiskOverride;

  return (
    <section className="rounded-xl border border-border bg-bg/40 p-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          label={STATUS_LABEL[product.ipRiskStatus]}
          variant={STATUS_VARIANT[product.ipRiskStatus]}
        />
        {product.ipRiskOverride && (
          <StatusChip label="override approved" variant="accent" />
        )}
        {product.ipRiskCheckedAt && (
          <span className="text-[10px] text-muted">
            checked {new Date(product.ipRiskCheckedAt).toLocaleString()}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label className="inline-flex items-center gap-1 text-[11px] text-muted select-none">
            <input
              type="checkbox"
              checked={useAi}
              onChange={(e) => setUseAi(e.target.checked)}
              disabled={checking}
              className="accent-accent"
            />
            with AI
          </label>
          <label
            className={`inline-flex items-center gap-1 text-[11px] select-none ${
              useAi ? "text-muted" : "text-muted2 cursor-not-allowed"
            }`}
            title={
              !useAi
                ? "Vision check requires 'with AI' to be enabled."
                : "Vision-assisted check — sends the reference image to the AI provider so it can verify logo authenticity, spot misspelled brand text on packaging, and identify counterfeit-looking products. Uses a vision-capable model (gpt-4o, claude-3.5-sonnet, etc.)."
            }
          >
            <input
              type="checkbox"
              checked={useVision}
              onChange={(e) => setUseVision(e.target.checked)}
              disabled={checking || !useAi}
              className="accent-accent"
            />
            + vision
          </label>
          <button
            type="button"
            className="btn btn-ghost text-[11px] px-2 py-1"
            onClick={runCheck}
            disabled={checking}
            title={
              useAi && useVision
                ? "Run heuristic + AI + vision check on the reference image."
                : useAi
                  ? "Run the deterministic heuristic plus an AI-assisted second opinion. AI provider must be configured in Settings."
                  : "Run the deterministic heuristic only. No AI cost, no API key required."
            }
          >
            {checking ? "Checking…" : "Check IP risk"}
          </button>
        </div>
      </div>

      {isRisky && (
        <div className="rounded-lg border border-warn/40 bg-warn/[0.06] px-2 py-1.5 text-[11px] text-warn leading-snug">
          Potential IP/trademark risk detected. Review manually before
          generating content.
        </div>
      )}

      {product.ipRiskReasons.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted hover:text-text select-none">
            Reasons ({product.ipRiskReasons.length})
          </summary>
          <ul className="mt-1.5 space-y-0.5 list-disc pl-4 text-muted">
            {product.ipRiskReasons.map((r, i) => (
              <li key={i} className="leading-snug">{r}</li>
            ))}
          </ul>
        </details>
      )}

      {showOverrideArea && (
        <div className="pt-1.5 border-t border-border/40 space-y-1.5">
          {product.ipRiskOverride ? (
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-ok">
                ✓ Override approved
                {product.ipRiskOverrideAt && (
                  <span className="text-muted text-[10px]">
                    {" "}— {new Date(product.ipRiskOverrideAt).toLocaleString()}
                  </span>
                )}
              </span>
              {product.ipRiskOverrideReason && (
                <span className="text-[10px] text-muted italic max-w-[24rem] truncate">
                  &ldquo;{product.ipRiskOverrideReason}&rdquo;
                </span>
              )}
              <button
                type="button"
                className="ml-auto text-[10px] text-bad hover:underline"
                onClick={() => applyOverride(false)}
                disabled={overrideSaving}
              >
                {overrideSaving ? "Clearing…" : "Clear override"}
              </button>
            </div>
          ) : showOverrideForm ? (
            <div className="space-y-1.5">
              <label className="block">
                <span className="text-[10px] text-muted">
                  Reason (required for high / needs-review products)
                </span>
                <input
                  type="text"
                  className="field mt-0.5 text-[12px]"
                  placeholder="e.g. verified official seller; generic compatibility product; client confirmed"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  disabled={overrideSaving}
                />
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary text-[11px] px-2 py-1"
                  onClick={() => applyOverride(true)}
                  disabled={overrideSaving || !overrideReason.trim()}
                >
                  {overrideSaving ? "Saving…" : "Save override"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost text-[11px] px-2 py-1"
                  onClick={() => {
                    setShowOverrideForm(false);
                    setError(null);
                  }}
                  disabled={overrideSaving}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-[11px] text-accent hover:underline"
              onClick={() => setShowOverrideForm(true)}
            >
              I reviewed this product and want to allow generation →
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="text-[10px] text-bad leading-tight">⚠ {error}</div>
      )}
    </section>
  );
}
