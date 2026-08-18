/**
 * Typed error hierarchy for the Milestone 1 QA orchestrator.
 *
 * Every non-success outcome of runQaForAsset() throws one of
 * these. The orchestrator ALSO writes a QaAttempt row with the
 * error captured before throwing (except for LegacyAssetError
 * and ConcurrencyError, which happen before lock acquisition)
 * so the audit trail always exists.
 *
 * Phase E's Run-QA UI uses `instanceof` to render distinct
 * treatments per class. The messages are operator-facing —
 * short, actionable, no stack traces.
 */

/** Base class. Never thrown directly — subclass instead. */
export class QaError extends Error {
  /** Machine-readable identifier for the failure category.
   *  Stamped into QaAttempt.resultJson so audit queries can
   *  filter without inspecting the message text. */
  readonly code: string;
  /** The pipeline stage where the failure occurred. Useful for
   *  drilling into which of media-fetch / extraction / provider
   *  / validation / persistence is misbehaving. */
  readonly stage: QaFailureStage;

  constructor(code: string, stage: QaFailureStage, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.stage = stage;
  }
}

export type QaFailureStage =
  | "precheck"       // asset lookup, legacy-asset check
  | "lock"           // concurrency guard
  | "media_fetch"    // signed URL / bytes download
  | "extraction"     // ffmpeg frame extraction
  | "provider"       // Anthropic call
  | "validation"     // Zod parse of model output
  | "persistence";   // final QaAttempt write / asset update

/**
 * The asset has no contentRunId. Milestone 1 orchestrator paths
 * require ContentRun membership; pre-M1 rows grandfather as
 * "legacy" and refuse QA rather than silently inventing run
 * context. Phase E can offer a "adopt this legacy asset into a
 * new ContentRun" affordance if we ever need to backfill.
 *
 * Thrown BEFORE lock acquisition — no state changes.
 */
export class LegacyAssetError extends QaError {
  readonly assetId: string;
  readonly assetKind: "video" | "image";
  constructor(assetId: string, assetKind: "video" | "image") {
    super(
      "legacy_asset_no_content_run",
      "precheck",
      `Asset ${assetId} (${assetKind}) has no ContentRun. QA is not supported for pre-Milestone-1 assets.`,
    );
    this.assetId = assetId;
    this.assetKind = assetKind;
  }
}

/**
 * Another QA is already in flight for this asset (qaStatus is
 * QA_RUNNING) OR the asset is currently being regenerated
 * (qaStatus is REGEN_IN_FLIGHT, Phase D). Thrown by the atomic
 * lock-acquisition query in persistence.ts — never a partial
 * write.
 */
export class ConcurrencyError extends QaError {
  readonly assetId: string;
  constructor(assetId: string, currentStatus?: string) {
    super(
      "qa_already_in_flight",
      "lock",
      currentStatus
        ? `Asset ${assetId} has QA in flight (status=${currentStatus}). Try again once it finishes, or reset the QA state.`
        : `Asset ${assetId} has QA in flight. Try again once it finishes, or reset the QA state.`,
    );
    this.assetId = assetId;
  }
}

/** Couldn't obtain the asset's playable/viewable bytes — either
 *  the MCP get_asset call failed or the signed URL fetch did.
 *  Original error is preserved in cause. */
export class MediaFetchError extends QaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("media_fetch_failed", "media_fetch", message);
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** ffmpeg / ffprobe failure — binary not found, exit non-zero,
 *  no frames produced, corrupt input, etc. */
export class FrameExtractionError extends QaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("frame_extraction_failed", "extraction", message);
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** The visual-QA provider itself errored — Anthropic HTTP error,
 *  timeout, empty response, rate limit, etc. Distinct from
 *  ProviderValidationError which means the call succeeded but
 *  the output didn't parse. */
export class ProviderError extends QaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("provider_call_failed", "provider", message);
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** The provider returned SOMETHING but it didn't validate against
 *  the Zod schema. Distinct from ProviderError so Phase E can
 *  render "model output was malformed" versus "call failed."
 *  Carries the raw response for debugging. */
export class ProviderValidationError extends QaError {
  readonly rawSample: string;
  constructor(message: string, rawSample: string) {
    super("provider_output_invalid", "validation", message);
    // Cap the sample so we don't blow up log lines.
    this.rawSample = rawSample.length > 2000 ? rawSample.slice(0, 2000) + "…" : rawSample;
  }
}

/** DB write failed during final persistence. Rare — should mean
 *  the DB is unhealthy. */
export class PersistenceError extends QaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("persistence_failed", "persistence", message);
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
