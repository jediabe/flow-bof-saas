/**
 * Shared types for the Milestone 1 QA subsystem.
 *
 * Kept as narrow string-literal unions rather than TS enums for
 * clean JSON serialisation on both sides of the Prisma boundary
 * (Prisma stores these as plain strings — see the qaStatus /
 * decision columns on FlowGeneratedVideo, FlowGeneratedImage,
 * QaAttempt). Zod schemas in ./schema.ts mirror these unions so
 * inbound LLM output can be validated against them.
 *
 * Phase B ships this file plus rubric.ts, schema.ts, config.ts,
 * and decision-engine.ts — no MCP calls, no ffmpeg, no UI.
 * See docs/ARCHITECTURE.md (once written) for the full flow.
 */

/** The four Style 1 asset slots the QA loop cares about. */
export type AssetType =
  | "STORE_IMAGE"
  | "STORE_VIDEO"
  | "HOME_IMAGE"
  | "HOME_VIDEO";

/**
 * QA lifecycle for a single generated asset row
 * (FlowGeneratedVideo / FlowGeneratedImage). The application is
 * the sole writer — the LLM never mutates state directly.
 *
 *   NOT_QA_CHECKED   - never evaluated (default for existing rows
 *                      + new rows until Run QA is clicked)
 *   QA_RUNNING       - evaluation in flight
 *   APPROVED         - passed; ready for downstream use
 *   REGEN_NEEDED     - QA said regenerate; not yet dispatched
 *   REGEN_IN_FLIGHT  - MCP regeneration call in progress
 *   HUMAN_REVIEW     - either QA verdict was HUMAN_REVIEW or the
 *                      max-attempts guard fired; needs operator
 *   FAILED           - QA itself errored (schema violation, tool
 *                      crash, network death) — treated as a soft
 *                      lock until the operator retries manually
 */
export type QaStatus =
  | "NOT_QA_CHECKED"
  | "QA_RUNNING"
  | "APPROVED"
  | "REGEN_NEEDED"
  | "REGEN_IN_FLIGHT"
  | "HUMAN_REVIEW"
  | "FAILED";

/**
 * Decision engine output — what the application should do with
 * this asset after a QA evaluation returns.
 *
 * The engine is pure (see ./decision-engine.ts) and does not
 * change persisted state itself; callers write the transition
 * (qaStatus + qaScore + qaVerdictJson) based on this value.
 */
export type Decision = "APPROVE" | "REGENERATE" | "HUMAN_REVIEW";

/**
 * Severity of a QA issue. Drives the deterministic decision
 * engine: `critical` is always a hard failure; `major` blocks
 * approval; `soft` is informational only.
 */
export type Severity = "soft" | "major" | "critical";

/** Convenience — the currently-known rubric criterion names.
 *  Rubric.ts is the source of truth; this is just a type re-
 *  export for consumers that want autocomplete when constructing
 *  test fixtures. */
export type RubricCriterionName =
  | "PRODUCT_PRESENT"
  | "PRODUCT_FIDELITY"
  | "PRODUCT_STABILITY"
  | "LABEL_INTEGRITY"
  | "HAND_ANATOMY"
  | "OBJECT_INTEGRITY"
  | "TEXT_INTEGRITY"
  | "SCENE_APPROPRIATENESS"
  | "PHONE_FOOTAGE_REALISM"
  | "MOTION_REALISM";
