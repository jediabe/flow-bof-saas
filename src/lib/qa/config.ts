/**
 * Milestone 1 QA configuration — the single place thresholds
 * and knobs live. The decision engine and rubric never hard-code
 * these values; they read from here.
 *
 * Environment overrides land in QaConfigResolver.resolve() so
 * ops can nudge production without a redeploy (post-M1 concern —
 * for now we ship with the compiled constants and let tests pass
 * their own overrides in).
 *
 * RUBRIC_VERSION is bumped whenever ./rubric.ts changes the
 * criteria set OR the QA prompt semantics. QaAttempt rows carry
 * this string forever so historic evaluations stay interpretable
 * after the rubric evolves.
 */

import type { Decision } from "./types";

export interface QaConfig {
  /** Overall score at-or-above which we APPROVE (no major/critical issues). */
  APPROVE_SCORE_THRESHOLD: number;
  /** Overall score below which we REGENERATE (subject to max-attempts guard). */
  REGEN_SCORE_THRESHOLD: number;
  /** Ceiling on repair attempts before REGENERATE gets forced to HUMAN_REVIEW. */
  MAX_REPAIR_ATTEMPTS: number;
  /** Rubric identity — stamped into every QaAttempt row for historic interpretability. */
  RUBRIC_VERSION: string;
}

/**
 * Defaults, tuned for the initial launch.
 *
 * - APPROVE_SCORE_THRESHOLD = 80. Empirical bar for "ships without operator
 *   review." Chosen conservatively — we'd rather false-negative and route
 *   good work to HUMAN_REVIEW than false-positive and ship a defective asset.
 * - REGEN_SCORE_THRESHOLD = 60. Below this we consider the output beyond
 *   worth-a-human-look and go straight to REGENERATE.
 * - The 60-80 middle band routes to HUMAN_REVIEW — the operator makes the
 *   call. Explicitly asymmetric: exactly at 60 is HUMAN_REVIEW, not
 *   REGENERATE; the engine uses strict-less-than for the regen boundary
 *   so the operator sees borderline results rather than paying to regen
 *   them.
 * - MAX_REPAIR_ATTEMPTS = 3. First attempt + two repairs before the
 *   operator has to look at it. Matches the Milestone 1 spec default.
 */
export const DEFAULT_QA_CONFIG: QaConfig = {
  APPROVE_SCORE_THRESHOLD: 80,
  REGEN_SCORE_THRESHOLD: 60,
  MAX_REPAIR_ATTEMPTS: 3,
  RUBRIC_VERSION: "m1.0",
};

/**
 * Merge a partial override into the defaults. Kept separate so
 * tests can vary one knob at a time without reconstructing the
 * whole object. Never mutates the input.
 */
export function resolveQaConfig(overrides?: Partial<QaConfig>): QaConfig {
  return { ...DEFAULT_QA_CONFIG, ...(overrides ?? {}) };
}

/** Type guard for callers coercing a persisted string back to a
 *  Decision. Handy in Phase C+ when reading QaAttempt.decision
 *  out of the DB into typed code. */
export function isDecision(value: string): value is Decision {
  return value === "APPROVE" || value === "REGENERATE" || value === "HUMAN_REVIEW";
}
