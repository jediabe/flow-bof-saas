/**
 * VisualQaProvider — the seam between the orchestrator and any
 * concrete multimodal evaluator.
 *
 * The orchestrator only talks through this interface. That
 * gives us three things:
 *   1. Tests inject fake providers via the orchestrator's
 *      `providerOverride` input — no mocking of Anthropic SDK
 *      internals, no real network in unit tests.
 *   2. Future providers (a smaller/cheaper vision model, a
 *      self-hosted eval, etc.) plug in without any orchestrator
 *      change.
 *   3. The rubric is passed IN, not imported by the provider,
 *      so the provider stays testable in isolation and Phase D
 *      can vary the rubric per attempt if needed.
 *
 * The provider does NOT choose application state — its only
 * output is a validated VisualQaResult. The deterministic
 * decision engine in ./decision-engine.ts turns that into
 * APPROVE / REGENERATE / HUMAN_REVIEW.
 *
 * ERROR CONTRACT:
 *   - Network / API failures → throw ProviderError
 *   - Model returned malformed / unparseable JSON → throw
 *     ProviderValidationError (with raw sample for debugging)
 *   - Never return a "default" result on failure. The
 *     orchestrator relies on exceptions to route to the FAILED
 *     lifecycle state.
 */

import type { FetchedImage } from "@/lib/media/fetch-image";
import type { RubricCriterion } from "./rubric";
import type { VisualQaResult } from "./schema";
import type { AssetType } from "./types";

/** A single extracted frame plus its position in the source
 *  video. Timestamps are milliseconds from the start of the
 *  clip, monotonic across the array. */
export interface ExtractedFrame {
  timestampMs: number;
  data: string;                  // base64
  /** Always image/jpeg in the current pipeline — ffmpeg emits
   *  JPEG. Kept explicit in the type so future formats (e.g.
   *  webp for smaller wire cost) are a type change, not a
   *  silent behaviour change. */
  mediaType: "image/jpeg";
}

/** The video-asset variant of the asset-under-evaluation. */
export interface VideoAssetInput {
  kind: "video";
  frames: readonly ExtractedFrame[];
}

/** The image-asset variant (Style 1 Scene 1 / Scene 2 stills,
 *  and any future image-only asset). */
export interface ImageAssetInput {
  kind: "image";
  image: FetchedImage;
}

export type AssetInput = VideoAssetInput | ImageAssetInput;

/** Everything the provider needs to run one evaluation. */
export interface VisualQaInput {
  assetType: AssetType;
  /** e.g. "scene_1_store" / "scene_2_home". Passed as-is; used
   *  by the prompt builder to steer per-scene expectations. */
  sceneLabel: string;
  productName: string;
  productCategory?: string;
  market: string;                // "uk" | "us"
  /** The generation prompt that produced this asset. Optional
   *  because pre-M1 rows may not have a clean stored prompt. */
  generationPrompt?: string;
  /** Kalodata reference image the operator captured on import.
   *  Null means no reference is on file — the prompt tells the
   *  model to evaluate fidelity looser in that case. */
  referenceImage: FetchedImage | null;
  asset: AssetInput;
  /** The rubric to score against. Passed in for provider
   *  testability + rubric-versioning support. */
  rubric: readonly RubricCriterion[];
}

/** The provider's return shape — the validated result plus
 *  diagnostics the orchestrator persists on QaAttempt. */
export interface VisualQaEvaluation {
  result: VisualQaResult;
  /** Provider-specific model identity — e.g. "claude-sonnet-5-20260601".
   *  Stamped onto QaAttempt.providerModel. */
  providerModel: string;
  /** Wall-clock time spent inside the provider call, ms.
   *  Provider is responsible for measuring this. */
  elapsedMs: number;
}

export interface VisualQaProvider {
  /**
   * Evaluate one asset. See ERROR CONTRACT in the module doc:
   *   - ProviderError for network/API failures
   *   - ProviderValidationError for malformed output
   *   - Any other Error is rewrapped by the orchestrator into
   *     ProviderError, so implementations should throw the
   *     typed classes themselves when they can identify the
   *     class.
   */
  evaluate(input: VisualQaInput): Promise<VisualQaEvaluation>;

  /** Human-readable identifier for logs (e.g. "anthropic:claude-sonnet-5").
   *  Stable across a provider instance's lifetime. */
  readonly identifier: string;
}
