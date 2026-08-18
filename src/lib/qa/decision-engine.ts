/**
 * Deterministic QA decision engine.
 *
 * Milestone 1 architectural rule: the LLM proposes; the
 * application decides. This module is the sole place that
 * turns a VisualQaResult into APPROVE / REGENERATE /
 * HUMAN_REVIEW. The engine is pure — no I/O, no clock, no DB.
 * Tests in ./__tests__/decision-engine.test.ts pin the exact
 * boundaries.
 *
 * Behaviour summary (see the rules block in `decide()` for the
 * canonical ordering):
 *
 *   1. Malformed / missing result           → HUMAN_REVIEW
 *   2. Any hard failure                     → REGENERATE  ⟨*⟩
 *   3. Score >= APPROVE_SCORE_THRESHOLD
 *      AND no major/critical issues         → APPROVE
 *   4. Score <  REGEN_SCORE_THRESHOLD       → REGENERATE  ⟨*⟩
 *   5. Everything else                      → HUMAN_REVIEW
 *
 *   ⟨*⟩ REGENERATE is downgraded to HUMAN_REVIEW when the
 *   asset has already used up MAX_REPAIR_ATTEMPTS attempts —
 *   see the max-attempts guard at the bottom of decide().
 *
 * Threshold boundary policy — exact values matter and are
 * pinned in tests:
 *   - Score = APPROVE_SCORE_THRESHOLD (80 by default) → APPROVE
 *     (>= is the boundary)
 *   - Score = REGEN_SCORE_THRESHOLD (60 by default)   → HUMAN_REVIEW
 *     (strict < for regen, so borderline routes to human)
 *
 * The asymmetry is deliberate: we'd rather show the operator
 * a borderline video than spend credits regenerating it.
 */

import { computeHasHardFailure } from "./rubric";
import type { QaIssue, VisualQaResult } from "./schema";
import { resolveQaConfig, type QaConfig } from "./config";
import type { Decision } from "./types";

export interface DecideInput {
  /**
   * The QA result under evaluation. Pass `null` when the model
   * failed to produce parseable output — the engine routes to
   * HUMAN_REVIEW with a specific `reason`.
   */
  result: VisualQaResult | null;
  /**
   * 1-indexed attempt count for the asset being evaluated.
   * `1` means original generation; `2+` means this is a
   * regeneration. Used by the max-attempts guard.
   */
  attemptNumber: number;
  /** Optional threshold overrides — mainly for tests. */
  config?: Partial<QaConfig>;
}

export interface DecideOutput {
  decision: Decision;
  /** One-line human-readable justification, used in structured
   *  logs and stamped onto QaAttempt rows as (part of the)
   *  audit trail. */
  reason: string;
  /** The specific issues that drove the decision. Empty on
   *  APPROVE. Present on REGENERATE / HUMAN_REVIEW so downstream
   *  services (repair-prompt in Phase D, drawer UI) can render
   *  them without re-deriving. */
  triggeringIssues: readonly QaIssue[];
  /** True when the max-attempts guard forced a REGENERATE
   *  verdict to HUMAN_REVIEW. Lets callers log the escalation
   *  explicitly rather than inferring it. */
  attemptsExhausted: boolean;
}

/**
 * Pure decision function. Never throws; always returns a
 * DecideOutput. See module docstring for the rule ordering.
 */
export function decide(input: DecideInput): DecideOutput {
  const config = resolveQaConfig(input.config);

  // Rule 1 — malformed / missing result. Never auto-approve on
  // uncertain input.
  if (!input.result) {
    return {
      decision: "HUMAN_REVIEW",
      reason: "QA produced no parseable result — routing to human review.",
      triggeringIssues: [],
      attemptsExhausted: false,
    };
  }

  const { overallScore, checks, issues, hasHardFailure: modelSaysHard } =
    input.result;

  // Cross-check the model's hasHardFailure flag against a
  // locally-computed value. If either says "yes" we treat it as
  // a hard failure — a disagreement means one of them is
  // stricter than the other and we trust the stricter signal.
  const localHardFailure = computeHasHardFailure(checks);
  const hasHardFailure = modelSaysHard || localHardFailure;

  const criticalIssues = issues.filter((i) => i.severity === "critical");
  const majorIssues = issues.filter((i) => i.severity === "major");
  const failedChecks = checks.filter((c) => !c.passed);

  // Rule 2 — any hard failure. Applies both when the rubric
  // classifies a failed check as hard AND when the issues list
  // itself carries a critical entry.
  if (hasHardFailure || criticalIssues.length > 0) {
    return applyMaxAttemptsGuard({
      preferredDecision: "REGENERATE",
      reason: hasHardFailure
        ? `Hard failure detected in ${failedChecks.length} check(s); regenerate.`
        : `${criticalIssues.length} critical issue(s) reported; regenerate.`,
      // Prefer issues if we have them; otherwise synthesize
      // from failed checks so the caller always has something
      // concrete to show the operator.
      triggeringIssues:
        criticalIssues.length > 0
          ? criticalIssues
          : synthesizeIssuesFromChecks(failedChecks),
      attemptNumber: input.attemptNumber,
      maxAttempts: config.MAX_REPAIR_ATTEMPTS,
    });
  }

  // Rule 3 — clean approve. High score AND zero major/critical
  // issues. Soft issues (informational) don't block approval.
  if (
    overallScore >= config.APPROVE_SCORE_THRESHOLD &&
    majorIssues.length === 0
  ) {
    return {
      decision: "APPROVE",
      reason: `Score ${overallScore} >= ${config.APPROVE_SCORE_THRESHOLD} and no major/critical issues; approve.`,
      triggeringIssues: [],
      attemptsExhausted: false,
    };
  }

  // Rule 4 — score below the regen floor. Strict less-than so
  // the boundary is HUMAN_REVIEW, not REGENERATE (see module
  // docstring).
  if (overallScore < config.REGEN_SCORE_THRESHOLD) {
    return applyMaxAttemptsGuard({
      preferredDecision: "REGENERATE",
      reason: `Score ${overallScore} < ${config.REGEN_SCORE_THRESHOLD}; regenerate.`,
      triggeringIssues:
        majorIssues.length > 0
          ? majorIssues
          : synthesizeIssuesFromChecks(failedChecks),
      attemptNumber: input.attemptNumber,
      maxAttempts: config.MAX_REPAIR_ATTEMPTS,
    });
  }

  // Rule 5 — everything else falls to human review. This is the
  // middle band (60..80 with the defaults) OR the case where
  // score is high but there's a lingering major issue.
  return {
    decision: "HUMAN_REVIEW",
    reason:
      majorIssues.length > 0
        ? `Score ${overallScore} with ${majorIssues.length} major issue(s); needs human review.`
        : `Score ${overallScore} in the ambiguous band [${config.REGEN_SCORE_THRESHOLD}..${config.APPROVE_SCORE_THRESHOLD}); needs human review.`,
    triggeringIssues: majorIssues.length > 0 ? majorIssues : [],
    attemptsExhausted: false,
  };
}

/**
 * Downgrade REGENERATE to HUMAN_REVIEW when the asset has
 * already burned MAX_REPAIR_ATTEMPTS attempts. Prevents
 * infinite loops — the Milestone 1 spec's explicit guard.
 *
 * `attemptNumber >= maxAttempts` is the trigger: attempt 3 with
 * MAX=3 means we've had 3 attempts already, so any REGENERATE
 * verdict would be attempt 4 and is capped.
 */
function applyMaxAttemptsGuard(input: {
  preferredDecision: "REGENERATE";
  reason: string;
  triggeringIssues: readonly QaIssue[];
  attemptNumber: number;
  maxAttempts: number;
}): DecideOutput {
  if (input.attemptNumber >= input.maxAttempts) {
    return {
      decision: "HUMAN_REVIEW",
      reason: `${input.reason} Attempts exhausted (attempt ${input.attemptNumber} / max ${input.maxAttempts}); escalating to human review.`,
      triggeringIssues: input.triggeringIssues,
      attemptsExhausted: true,
    };
  }
  return {
    decision: input.preferredDecision,
    reason: input.reason,
    triggeringIssues: input.triggeringIssues,
    attemptsExhausted: false,
  };
}

/**
 * Fallback: build a minimal QaIssue list from failed checks
 * when the model didn't emit any issues[] entries but did fail
 * some checks. Lets the audit trail always have something
 * concrete to show even when the model returns terse output.
 */
function synthesizeIssuesFromChecks(
  failedChecks: ReadonlyArray<VisualQaResult["checks"][number]>,
): readonly QaIssue[] {
  return failedChecks.map((c) => ({
    type: c.name,
    severity: c.severity ?? "major",
    description: c.reason ?? `Check ${c.name} failed (score ${c.score}).`,
    ...(c.frameTimestampMs !== undefined
      ? { frameTimestampMs: c.frameTimestampMs }
      : {}),
  }));
}
