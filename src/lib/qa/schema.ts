/**
 * Zod schemas for QA model output.
 *
 * The visual-QA provider (Phase C) is instructed to return
 * strictly-shaped JSON. This module is the sole gate between
 * "raw model text" and "typed application state." If validation
 * fails, the caller MUST NOT persist anything or transition
 * asset state — the decision engine treats an unparseable
 * result as HUMAN_REVIEW, tested explicitly in
 * ./__tests__/schema.test.ts.
 *
 * All schemas mirror the string-literal unions in ./types.ts.
 * That intentional duplication means Zod owns runtime validation
 * and TypeScript owns compile-time typing without either owning
 * the other — the two agree because they're both spelled from
 * the same source.
 */

import { z } from "zod";
import type {
  AssetType,
  Decision,
  RubricCriterionName,
  Severity,
} from "./types";

export const SeveritySchema: z.ZodType<Severity> = z.enum([
  "soft",
  "major",
  "critical",
]);

export const DecisionSchema: z.ZodType<Decision> = z.enum([
  "APPROVE",
  "REGENERATE",
  "HUMAN_REVIEW",
]);

export const AssetTypeSchema: z.ZodType<AssetType> = z.enum([
  "STORE_IMAGE",
  "STORE_VIDEO",
  "HOME_IMAGE",
  "HOME_VIDEO",
]);

/** Rubric criterion names. Kept as a Zod enum (not a string) so
 *  the model can't invent a check name that isn't in the rubric.
 *  Rubric evolution: extend this list AND bump RUBRIC_VERSION
 *  in ./config.ts in the same change. */
export const RubricCriterionNameSchema: z.ZodType<RubricCriterionName> = z.enum([
  "PRODUCT_PRESENT",
  "PRODUCT_FIDELITY",
  "PRODUCT_STABILITY",
  "LABEL_INTEGRITY",
  "HAND_ANATOMY",
  "OBJECT_INTEGRITY",
  "TEXT_INTEGRITY",
  "SCENE_APPROPRIATENESS",
  "PHONE_FOOTAGE_REALISM",
  "MOTION_REALISM",
]);

/** One row of the QA table — pass/fail + score for a single
 *  rubric criterion. `frameTimestampMs` is optional and only
 *  populated for videos where the model wants to point at a
 *  specific frame. Extra fields the model returns are stripped
 *  by default — we intentionally don't `.strict()` here so a
 *  model that adds fields (e.g. a "confidence" it invented) is
 *  tolerated rather than rejected. */
export const QaCheckSchema = z.object({
  name: RubricCriterionNameSchema,
  passed: z.boolean(),
  score: z.number().int().min(0).max(100),
  severity: SeveritySchema.optional(),
  reason: z.string().optional(),
  frameTimestampMs: z.number().nonnegative().optional(),
});

/** A single defect the model wants to surface — richer than the
 *  per-criterion QaCheck row because it carries the description
 *  the operator sees and (Phase D) the suggestedRepair hint the
 *  repair-prompt builder uses. */
export const QaIssueSchema = z.object({
  type: z.string().min(1),
  severity: SeveritySchema,
  description: z.string().min(1),
  frameTimestampMs: z.number().nonnegative().optional(),
  suggestedRepair: z.string().optional(),
});

/** The full model return shape. `checks` must contain at least
 *  one entry (an empty array means the model produced no
 *  evaluation — treat as failure). `issues` may be empty (no
 *  defects found is a valid outcome). */
export const VisualQaResultSchema = z.object({
  overallScore: z.number().int().min(0).max(100),
  checks: z.array(QaCheckSchema).min(1),
  issues: z.array(QaIssueSchema),
  hasHardFailure: z.boolean(),
});

export type QaCheck = z.infer<typeof QaCheckSchema>;
export type QaIssue = z.infer<typeof QaIssueSchema>;
export type VisualQaResult = z.infer<typeof VisualQaResultSchema>;

/**
 * Parse result — a discriminated union so callers explicitly
 * handle the invalid case. Never throws. `error` is a short
 * human-readable message; `issues` is the raw Zod issues list
 * for structured logging. Typed as `unknown[]` (rather than the
 * version-specific Zod issue type) so this module doesn't leak
 * a Zod-major-version dependency into callers.
 */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; issues?: readonly unknown[] };

/**
 * Parse an unknown value (typically the model's JSON.parse'd
 * output) into a VisualQaResult. Handles:
 *   - null / undefined              → {ok:false, error:...}
 *   - non-object primitives         → {ok:false, error:...}
 *   - schema violations             → {ok:false, error:..., issues:[...]}
 *   - valid input                   → {ok:true, value}
 *
 * Also accepts a JSON string and parses it — convenient for
 * callers that received raw model text without pre-JSON-parsing.
 */
export function parseVisualQaResult(raw: unknown): ParseResult<VisualQaResult> {
  if (raw === null || raw === undefined) {
    return { ok: false, error: "QA result is null or undefined" };
  }
  let candidate: unknown = raw;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch (err) {
      return {
        ok: false,
        error: `QA result is not valid JSON: ${(err as Error).message}`,
      };
    }
  }
  const parsed = VisualQaResultSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: `QA result failed schema validation: ${parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"} — ${i.message}`)
      .join("; ")}`,
    issues: parsed.error.issues,
  };
}
