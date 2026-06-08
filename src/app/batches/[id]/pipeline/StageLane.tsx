"use client";

import { useState, type ReactNode } from "react";
import {
  type Stage,
  STAGE_LABEL,
  STAGE_ACCENT,
} from "@/lib/batch-stages";

/**
 * Phase 10 — one swim lane on the new batch page.
 *
 * Vertical-stacked layout: each lane takes full page width and
 * contains a horizontal row of cards. Lanes are collapsible
 * (caret in the header) so power users can hide stages they're
 * not currently using.
 *
 * The lane is also the drop target for cross-stage drag-and-drop.
 * onDrop / onDragOver are wired by the parent BatchPipeline, which
 * has the cross-card state (which product is being dragged) that
 * an individual lane doesn't.
 */

export default function StageLane({
  stage,
  count,
  action,
  emptyMessage,
  children,
  onDrop,
  onDragOver,
  onDragLeave,
  isDropActive = false,
}: {
  stage: Stage;
  count: number;
  /** Lane-level bulk action — typically a primary button. Renders
   *  in the lane header on the right; null/undefined hides it. */
  action?: ReactNode;
  /** Friendly message when the lane is empty. Defaults to a
   *  stage-specific hint. */
  emptyMessage?: string;
  /** The card row contents. Parent owns the bucket-by-stage
   *  logic; this component just renders. */
  children: ReactNode;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Visual highlight while a card is hovering over this lane. */
  isDropActive?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const empty = count === 0;
  const accent = STAGE_ACCENT[stage];

  return (
    <section
      className={`plane plane--${stage} plane--accent-${accent} ${
        collapsed ? "plane--collapsed" : ""
      } ${empty ? "plane--empty" : ""} ${
        isDropActive ? "plane--drop-active" : ""
      }`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header
        className="plane-head"
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="plane-caret" aria-hidden="true">
          ▼
        </span>
        <span className="plane-title">{STAGE_LABEL[stage]}</span>
        <span className="plane-count">({count})</span>
        {action && (
          <div
            className="plane-actions"
            onClick={(e) => e.stopPropagation()}
          >
            {action}
          </div>
        )}
      </header>
      <div className="plane-body">
        {empty ? (
          <div className="plane-empty-hint">
            {emptyMessage ?? defaultEmpty(stage)}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function defaultEmpty(stage: Stage): string {
  switch (stage) {
    case "needs_review":
      return "Nothing waiting for review. Import or add a product to start.";
    case "ready":
      return "No products ready for generation yet. Approve a product + run AI prompts to fill this lane.";
    case "generating":
      return "Nothing currently generating.";
    case "generated":
      return "No images generated yet for this batch.";
    case "posted":
      return "No products posted yet.";
  }
}
