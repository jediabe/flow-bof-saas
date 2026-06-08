"use client";

import { useState, type ReactNode } from "react";
import {
  computeStage,
  STAGES,
  type Stage,
} from "@/lib/batch-stages";
import StageLane from "./StageLane";
import PipelineCard, {
  type PipelineCardProduct,
} from "./PipelineCard";

/**
 * Phase 10 — top-level batch pipeline.
 *
 * Owns the cross-cutting state that individual StageLanes can't
 * see on their own:
 *   - Which product is currently expanded (only one at a time)
 *   - Which product is being dragged (cross-lane state)
 *   - Which lane is the active drop target (for visual highlight)
 *
 * Renders five StageLanes in canonical order. Each lane gets
 * its share of the bucketed products, an optional lane action
 * (e.g. "Generate all (3)"), and drop handlers wired up. Card
 * click → expand inline (the expanded view is rendered by this
 * component as a sibling row below the card row of that lane,
 * via a callback into laneActionFor — placeholder for now).
 *
 * The drag-and-drop wiring is here in skeleton form; the actual
 * server actions (move to needs_review / approved / etc.) are
 * passed in as callback props so we can keep this component
 * testable + provider-agnostic.
 */

export type PipelineProduct = PipelineCardProduct & {
  /** Re-derived per-render. Surfaced so the parent can also use
   *  it for things like "show the IP risk override banner". */
  stage: Stage;
};

export interface LaneActionConfig {
  /** Optional ReactNode to render on the lane header's right
   *  side (e.g. a Generate-all button). Stage-specific. */
  needs_review?: ReactNode;
  ready?: ReactNode;
  generating?: ReactNode;
  generated?: ReactNode;
  posted?: ReactNode;
}

export default function BatchPipeline({
  products,
  laneActions,
  renderExpanded,
  onDropToStage,
}: {
  products: PipelineProduct[];
  laneActions?: LaneActionConfig;
  /** Render-callback for the expanded card body. The expanded
   *  view typically reuses ProductEditor-like edit surfaces; we
   *  delegate to the parent rather than coupling this file to
   *  any specific edit UI. */
  renderExpanded?: (product: PipelineProduct, onClose: () => void) => ReactNode;
  /** Called when a card is dropped onto a lane. The parent
   *  decides what server action to fire (e.g. setReviewStatus
   *  for Needs review, postingStatus for Posted, etc.). */
  onDropToStage?: (productId: string, targetStage: Stage) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [hoverStage, setHoverStage] = useState<Stage | null>(null);

  // Bucket inline. The PipelineCardProduct shape carries
  // referenceImagesCount; the stage helper wants the boolean
  // hasReferenceImage. Adapt here rather than mutating the
  // PipelineCardProduct shape (which the card itself needs in
  // count form for chip rendering).
  const byStage: Record<Stage, PipelineProduct[]> = {
    needs_review: [],
    ready:        [],
    generating:   [],
    generated:    [],
    posted:       [],
  };
  for (const p of products) {
    const { stage } = computeStage({
      reviewStatus:            p.reviewStatus,
      postingStatus:           p.postingStatus,
      imagePrompt:             p.imagePrompt,
      hasReferenceImage:       p.referenceImagesCount > 0,
      ipRiskStatus:            p.ipRiskStatus,
      ipRiskOverride:          p.ipRiskOverride,
      isInActiveGenerationJob: p.isInActiveGenerationJob,
      hasBoundFlowItem:        p.hasBoundFlowItem,
    });
    byStage[stage].push(p);
  }

  function handleDragStart(e: React.DragEvent<HTMLDivElement>) {
    const productId =
      (e.target as HTMLElement).closest("[data-product-id]")?.getAttribute(
        "data-product-id",
      ) || null;
    if (productId) {
      setDraggedId(productId);
      // Browsers refuse to start a drag without dataTransfer
      // payload on some platforms; set a sentinel string.
      e.dataTransfer.setData("text/plain", productId);
      e.dataTransfer.effectAllowed = "move";
    }
  }
  function handleDragEnd() {
    setDraggedId(null);
    setHoverStage(null);
  }

  return (
    <div
      className="pipeline"
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {STAGES.map((stage) => {
        const stageProducts = byStage[stage];
        return (
          <StageLane
            key={stage}
            stage={stage}
            count={stageProducts.length}
            action={laneActions?.[stage]}
            isDropActive={hoverStage === stage && draggedId !== null}
            onDragOver={(e) => {
              if (!draggedId) return;
              e.preventDefault();
              setHoverStage(stage);
            }}
            onDragLeave={() => {
              if (hoverStage === stage) setHoverStage(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedId && onDropToStage) {
                onDropToStage(draggedId, stage);
              }
              setDraggedId(null);
              setHoverStage(null);
            }}
          >
            <div className="plane-cards">
              {stageProducts.map((p) => {
                const isExpanded = expandedId === p.id;
                return (
                  <div key={p.id} className="pcard-wrap">
                    <PipelineCard
                      product={p}
                      stage={stage}
                      isExpanded={isExpanded}
                      draggable={!isExpanded}
                      onClick={() =>
                        setExpandedId(isExpanded ? null : p.id)
                      }
                    />
                    {isExpanded && renderExpanded && (
                      <div className="pcard-expansion">
                        {renderExpanded(p, () => setExpandedId(null))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </StageLane>
        );
      })}
    </div>
  );
}

/** Convenience: compute the StageInput-shaped subset of a Prisma
 *  Product row for the stage helper. Doesn't touch jobs / flow
 *  items — those signals are passed in separately by the page. */
export function toStageInput(p: {
  reviewStatus: string;
  postingStatus: string;
  imagePrompt: string | null;
  ipRiskStatus: string;
  ipRiskOverride: boolean;
  referenceImagesCount: number;
  hasBoundFlowItem: boolean;
  isInActiveGenerationJob: boolean;
}): Parameters<typeof computeStage>[0] {
  return {
    reviewStatus: p.reviewStatus as
      | "needs_review"
      | "approved"
      | "rejected"
      | "maybe",
    postingStatus: p.postingStatus as
      | "needs_posting"
      | "posted"
      | "skipped",
    imagePrompt: p.imagePrompt,
    hasReferenceImage: p.referenceImagesCount > 0,
    ipRiskStatus: p.ipRiskStatus as
      | "unchecked"
      | "low"
      | "medium"
      | "high"
      | "needs_manual_review",
    ipRiskOverride: p.ipRiskOverride,
    isInActiveGenerationJob: p.isInActiveGenerationJob,
    hasBoundFlowItem: p.hasBoundFlowItem,
  };
}
