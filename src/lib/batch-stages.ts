/**
 * Phase 10 (UI redesign) — pure helper that maps a product's state
 * onto its pipeline stage. The new batch page renders products as
 * cards in vertical "swim lanes," one lane per stage. Stages are
 * NOT stored on the row; they're derived here on every render so
 * the lanes stay in sync with the product's actual state.
 *
 * Five stages, in canonical pipeline order:
 *
 *   needs_review — reviewStatus is "needs_review" or "maybe", or
 *                  "rejected" (rejected sticks here as a kind of
 *                  "needs another look" bin; users can re-approve
 *                  via the drag-back motion).
 *   ready        — approved + has an imagePrompt + has at least one
 *                  reference image + NOT blocked by IP risk
 *                  (highRisk or needsManualReview without override).
 *                  This is the "good to generate" state.
 *   generating   — a generate_flow_images job is currently active
 *                  for this product (we receive this signal via the
 *                  caller; not derivable from Product alone).
 *   generated    — has at least one bound FlowItem (auto or manual)
 *                  OR appears in a successful generate_flow_images
 *                  job's items list with status="submitted". This
 *                  lane houses the "image exists; ready for video"
 *                  state.
 *   posted       — postingStatus is "posted".
 *
 * Implementation notes:
 *   - Order matters. We test more "advanced" stages first so a
 *     posted product doesn't get reported as also generated/ready.
 *   - Soft-deleted products are filtered upstream (page.tsx already
 *     does .where({deletedAt:null}); this helper assumes the input
 *     is alive).
 *   - "approved" products that are missing prompt / ref / IP gate
 *     do NOT advance to ready — they stay in needs_review with a
 *     reason chip surfaced on the card so the user knows what's
 *     gating them. This is intentional: the user shouldn't see a
 *     "ready" card that isn't actually ready.
 */

export type Stage =
  | "needs_review"
  | "ready"
  | "generating"
  | "generated"
  | "posted";

export const STAGES: readonly Stage[] = [
  "needs_review",
  "ready",
  "generating",
  "generated",
  "posted",
] as const;

export interface StageInput {
  /** Phase 1 review status. */
  reviewStatus: "needs_review" | "approved" | "rejected" | "maybe";
  /** Phase 5 posting status. */
  postingStatus: "needs_posting" | "posted" | "skipped";
  /** AI-generated image prompt — required for "ready". */
  imagePrompt: string | null;
  /** At least one ProductImage row exists (any role). */
  hasReferenceImage: boolean;
  /** Phase 9 IP risk fields. */
  ipRiskStatus: "unchecked" | "low" | "medium" | "high" | "needs_manual_review";
  ipRiskOverride: boolean;
  /** Whether the SaaS sees this product in an active
   *  generate_flow_images job. Provided by the caller (typically
   *  computed once per batch render by reading running jobs). */
  isInActiveGenerationJob: boolean;
  /** Whether any FlowItem row for this product exists with
   *  bindState != "ignored". Indicates "has been generated."
   *  Provided by the caller. */
  hasBoundFlowItem: boolean;
}

export interface StageResult {
  stage: Stage;
  /** Short reasons surfaced on the card explaining WHY the
   *  product is in this stage when it would otherwise advance.
   *  Examples: "no prompt yet", "no reference image", "IP risk
   *  blocked". Empty for products that naturally belong here. */
  gates: string[];
}

/** Hard rule from Phase 9: high or needs_manual_review IP risk
 *  excludes a product from generation unless override is set. */
function isBlockedByIpRisk(input: StageInput): boolean {
  return (
    (input.ipRiskStatus === "high" ||
      input.ipRiskStatus === "needs_manual_review") &&
    !input.ipRiskOverride
  );
}

/**
 * Compute the stage for one product. Pure function — no I/O, no
 * Prisma. The caller passes in already-derived booleans
 * (`isInActiveGenerationJob`, `hasBoundFlowItem`) that the helper
 * itself can't see without a DB query.
 */
export function computeStage(input: StageInput): StageResult {
  // 1. Posted wins — sticky terminal state regardless of how the
  //    user got there (videos generated or not, etc.).
  if (input.postingStatus === "posted") {
    return { stage: "posted", gates: [] };
  }

  // 2. Generated — has a Flow image bound to it. Even if the user
  //    later un-favorites in Flow, we still count it as "this
  //    product has been generated at least once."
  if (input.hasBoundFlowItem) {
    return { stage: "generated", gates: [] };
  }

  // 3. Generating — there's an active job claiming this item.
  //    This signal is computed by the caller; we just respect it.
  if (input.isInActiveGenerationJob) {
    return { stage: "generating", gates: [] };
  }

  // 4. Ready — fully approved, prompt + ref in hand, IP risk
  //    not blocking. This is the "go" state right before
  //    generation.
  if (input.reviewStatus === "approved") {
    const gates: string[] = [];
    if (!input.imagePrompt) gates.push("no AI prompt");
    if (!input.hasReferenceImage) gates.push("no reference image");
    if (isBlockedByIpRisk(input)) gates.push("IP risk blocked");
    if (gates.length === 0) {
      return { stage: "ready", gates: [] };
    }
    // Approved but blocked — stays in needs_review with the gates
    // surfaced so the user sees exactly what's missing.
    return { stage: "needs_review", gates };
  }

  // 5. Default — needs review. Maybe / rejected / needs_review
  //    all live here. Rejected gets a distinguishing gate so the
  //    user can tell it apart from un-triaged ones.
  const gates: string[] = [];
  if (input.reviewStatus === "rejected") gates.push("rejected");
  if (input.reviewStatus === "maybe") gates.push("maybe");
  return { stage: "needs_review", gates };
}

/** Bulk version for the lane renderer. Returns a Map keyed on
 *  product id, plus a count summary per stage. */
export function bucketByStage<T extends { id: string } & StageInput>(
  products: T[],
): { byStage: Record<Stage, T[]>; counts: Record<Stage, number> } {
  const byStage: Record<Stage, T[]> = {
    needs_review: [],
    ready:        [],
    generating:   [],
    generated:    [],
    posted:       [],
  };
  for (const p of products) {
    const { stage } = computeStage(p);
    byStage[stage].push(p);
  }
  const counts: Record<Stage, number> = {
    needs_review: byStage.needs_review.length,
    ready:        byStage.ready.length,
    generating:   byStage.generating.length,
    generated:    byStage.generated.length,
    posted:       byStage.posted.length,
  };
  return { byStage, counts };
}

/** Human-readable label for the stage. Surfaced on lane headers
 *  and on card-state hints. */
export const STAGE_LABEL: Record<Stage, string> = {
  needs_review: "Needs review",
  ready:        "Ready",
  generating:   "Generating",
  generated:    "Generated",
  posted:       "Posted",
};

/** Stage accent colors — match the prototype's left-edge tints on
 *  lane headers. Strings here are the Tailwind color names from
 *  tailwind.config.ts so the component layer can reference them
 *  via `theme(colors.{name})` or use them as `border-{name}` etc. */
export const STAGE_ACCENT: Record<Stage, "warn" | "accent" | "pink" | "ok" | "muted"> = {
  needs_review: "warn",
  ready:        "accent",
  generating:   "pink",
  generated:    "ok",
  posted:       "muted",
};
