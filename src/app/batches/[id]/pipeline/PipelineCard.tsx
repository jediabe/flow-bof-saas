"use client";

import { useState } from "react";
import { type Stage } from "@/lib/batch-stages";

/**
 * Phase 10 (UI redesign) — compact pipeline card.
 *
 * The default visual unit on the new batch page. Renders ~80px
 * tall with a 44px thumbnail + name + 1-2 status chips. Clicking
 * it expands the card in place (handled by the parent
 * StageLane — this component just bubbles the click up).
 *
 * Status chips are derived from the product's state + the lane
 * it sits in, NOT statically computed. A card in the
 * needs_review lane shows different chips than the same product
 * would in generated. The chip rendering logic lives here so
 * cards are visually self-consistent regardless of which lane
 * the parent passed in.
 */

export interface PipelineCardProduct {
  id: string;
  productName: string;
  category: string | null;
  referenceImageUrl: string | null;
  imagePrompt: string | null;
  hookVariantsCount: number;
  reviewStatus: "needs_review" | "approved" | "rejected" | "maybe";
  postingStatus: "needs_posting" | "posted" | "skipped";
  ipRiskStatus: "unchecked" | "low" | "medium" | "high" | "needs_manual_review";
  ipRiskOverride: boolean;
  referenceImagesCount: number;
  hasBoundFlowItem: boolean;
  /** Whether the SaaS sees this product in an active
   *  generate_flow_images job. Computed once per batch render
   *  on the server side by querying running jobs; passed
   *  through here so the stage helper can use it without
   *  another DB lookup. */
  isInActiveGenerationJob: boolean;
  /** Gating reasons computed upstream when stage logic stalls
   *  (e.g. approved but no prompt → "no AI prompt"). Shown as
   *  yellow chips. */
  gates: string[];
}

export default function PipelineCard({
  product,
  stage,
  onClick,
  draggable = true,
  isExpanded = false,
}: {
  product: PipelineCardProduct;
  stage: Stage;
  onClick: () => void;
  draggable?: boolean;
  isExpanded?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  // Chip vocabulary, by stage. Keep this LIGHT — max 2 visible
  // chips per card. Detail belongs in the expanded view.
  const chips: { label: string; tone: "ok" | "warn" | "bad" | "accent" | "muted" | "pink" }[] = [];

  if (stage === "needs_review") {
    if (product.gates.includes("rejected")) {
      chips.push({ label: "rejected", tone: "bad" });
    } else if (product.gates.includes("maybe")) {
      chips.push({ label: "maybe", tone: "muted" });
    } else {
      chips.push({ label: "needs review", tone: "warn" });
    }
    // Show ONE additional reason if there's a gate beyond
    // review-status. Keep it short.
    const otherGate = product.gates.find(
      (g) => g !== "rejected" && g !== "maybe",
    );
    if (otherGate) chips.push({ label: otherGate, tone: "warn" });
  } else if (stage === "ready") {
    chips.push({ label: "approved", tone: "ok" });
    if (product.hookVariantsCount > 0) {
      chips.push({ label: `★ ${product.hookVariantsCount} hooks`, tone: "accent" });
    } else {
      chips.push({ label: "★ AI ready", tone: "accent" });
    }
  } else if (stage === "generating") {
    chips.push({ label: "submitting…", tone: "pink" });
  } else if (stage === "generated") {
    chips.push({ label: "image ready", tone: "ok" });
  } else if (stage === "posted") {
    chips.push({ label: "posted ✓", tone: "ok" });
  }

  // IP risk + override get their own chip if relevant — surfaces
  // the override badge prominently so the user remembers why a
  // high-risk product made it past the gate.
  if (
    (product.ipRiskStatus === "high" ||
      product.ipRiskStatus === "needs_manual_review") &&
    product.ipRiskOverride
  ) {
    chips.push({ label: "IP override", tone: "accent" });
  }

  return (
    <article
      draggable={draggable}
      onClick={onClick}
      data-product-id={product.id}
      data-stage={stage}
      className={`pcard ${isExpanded ? "pcard--expanded" : ""}`}
    >
      <div className="pcard-head">
        <div className="pcard-thumb">
          {product.referenceImageUrl && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.referenceImageUrl}
              alt=""
              loading="lazy"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <span className="pcard-thumb-placeholder">—</span>
          )}
        </div>
        <div className="pcard-body">
          <div className="pcard-name" title={product.productName}>
            {product.productName}
          </div>
          {product.category && (
            <div className="pcard-sub">{product.category}</div>
          )}
        </div>
        {stage === "generating" && <span className="pcard-spinner" />}
      </div>
      {chips.length > 0 && (
        <div className="pcard-chips">
          {chips.slice(0, 3).map((c, i) => (
            <span key={i} className={`chip chip-${c.tone}`}>
              {c.label}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
