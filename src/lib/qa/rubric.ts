/**
 * The 10 QA criteria for Milestone 1, encoded as data.
 *
 * The visual-QA model (Phase C — Anthropic multimodal) is
 * prompted with this rubric verbatim and expected to return
 * ONE QaCheck per criterion. `hardFailureCategory` classifies
 * which criteria constitute a hard failure when they fail:
 * these force REGENERATE / HUMAN_REVIEW regardless of the
 * overall score.
 *
 * Kept as pure data rather than a class hierarchy — the
 * decision engine and the future QA prompt builder both read
 * from the same source of truth, and rubric evolution is a
 * data change plus a RUBRIC_VERSION bump (see config.ts).
 */

import type { RubricCriterionName, Severity } from "./types";

export interface RubricCriterion {
  /** Stable machine identifier. Also the `name` field on QaCheck. */
  name: RubricCriterionName;
  /** One-line human summary for the QA prompt + audit UI. */
  summary: string;
  /**
   * Whether failing this criterion is a hard failure.
   *
   * - "always"    - any failure of this criterion is a hard failure
   *                 (severity `critical` or `major` from the model)
   * - "if_major"  - only failures at severity >= major count as hard;
   *                 severity=soft is informational
   * - "never"     - this criterion is quality-only; failures never
   *                 hard-fail
   */
  hardFailureCategory: "always" | "if_major" | "never";
}

/**
 * The rubric. Order matches the Milestone 1 spec so audit logs
 * read naturally. Do NOT reorder — QaAttempt rows written under
 * the current RUBRIC_VERSION assume this ordering when rendering
 * the per-check table in the drawer.
 */
export const RUBRIC: readonly RubricCriterion[] = [
  {
    name: "PRODUCT_PRESENT",
    summary: "The promoted product is visible in the asset as expected.",
    hardFailureCategory: "always",
  },
  {
    name: "PRODUCT_FIDELITY",
    summary:
      "Generated product resembles the supplied reference image — shape, packaging, dominant colors, and general physical characteristics remain consistent.",
    hardFailureCategory: "if_major",
  },
  {
    name: "PRODUCT_STABILITY",
    summary:
      "Product does not visibly morph, change shape, duplicate, disappear, or change count across the video.",
    hardFailureCategory: "always",
  },
  {
    name: "LABEL_INTEGRITY",
    summary:
      "Product label/logo/control-panel area does not become obviously malformed or visually corrupted.",
    hardFailureCategory: "if_major",
  },
  {
    name: "HAND_ANATOMY",
    summary:
      "No clearly malformed hand, severe finger defects, impossible anatomy, or obvious hand/object fusion.",
    hardFailureCategory: "if_major",
  },
  {
    name: "OBJECT_INTEGRITY",
    summary:
      "No floating, duplicated, disappearing, or physically impossible objects.",
    hardFailureCategory: "if_major",
  },
  {
    name: "TEXT_INTEGRITY",
    summary:
      "No prominent obviously malformed AI-generated signage, labels, display cards, or background text.",
    hardFailureCategory: "if_major",
  },
  {
    name: "SCENE_APPROPRIATENESS",
    summary:
      "Store scene looks like a plausible retail environment; home scene looks appropriate for the product niche.",
    hardFailureCategory: "never",
  },
  {
    name: "PHONE_FOOTAGE_REALISM",
    summary:
      "Footage resembles casual smartphone footage rather than polished CGI / commercial footage.",
    hardFailureCategory: "never",
  },
  {
    name: "MOTION_REALISM",
    summary:
      "Camera and hand/object movement appear physically plausible and do not contain obvious AI motion artifacts.",
    hardFailureCategory: "never",
  },
] as const;

const RUBRIC_BY_NAME: Record<string, RubricCriterion> = Object.fromEntries(
  RUBRIC.map((c) => [c.name, c]),
);

/**
 * Look up a criterion by name. Returns undefined for unknown
 * names — the Zod schema in ./schema.ts is where we reject
 * unknown criteria coming from the model; this helper is for
 * consumers that already have a validated name.
 */
export function findRubricCriterion(
  name: string,
): RubricCriterion | undefined {
  return RUBRIC_BY_NAME[name];
}

/**
 * Pure predicate: given a single QaCheck-shaped input (we take
 * the minimum needed fields rather than the full Zod-typed
 * value to keep this module import-cycle-free), decide whether
 * this specific check counts as a hard failure.
 *
 * Rules:
 *   - Only failed checks (passed=false) can be hard failures.
 *   - Unknown criterion names never hard-fail here; validation
 *     is upstream in schema.ts.
 *   - hardFailureCategory="always"   → any failure hard-fails
 *   - hardFailureCategory="if_major" → severity major|critical
 *     hard-fails; soft does not
 *   - hardFailureCategory="never"    → never hard-fails
 *   - Missing severity on a failed "if_major" check is treated
 *     as major (conservative — we err on the side of surfacing
 *     the failure rather than silently downgrading it).
 */
export function isHardFailure(check: {
  name: string;
  passed: boolean;
  severity?: Severity;
}): boolean {
  if (check.passed) return false;
  const rubric = RUBRIC_BY_NAME[check.name];
  if (!rubric) return false;
  switch (rubric.hardFailureCategory) {
    case "always":
      return true;
    case "if_major": {
      const sev: Severity = check.severity ?? "major";
      return sev === "major" || sev === "critical";
    }
    case "never":
      return false;
  }
}

/**
 * Compute hasHardFailure across a set of checks. Also treats
 * ANY check with severity=critical as a hard failure regardless
 * of that criterion's hardFailureCategory — a critical-severity
 * report from the model is the model's strongest possible
 * signal and we do not want to overrule it with the rubric.
 *
 * Used by the decision engine as the canonical implementation
 * of "does this result contain a hard failure?" — the boolean
 * the model itself reports on VisualQaResult.hasHardFailure is
 * cross-checked against this locally; the engine treats a
 * disagreement as "trust the stricter of the two."
 */
export function computeHasHardFailure(
  checks: ReadonlyArray<{
    name: string;
    passed: boolean;
    severity?: Severity;
  }>,
): boolean {
  for (const check of checks) {
    if (check.passed) continue;
    if (check.severity === "critical") return true;
    if (isHardFailure(check)) return true;
  }
  return false;
}
