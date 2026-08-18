/**
 * Milestone 1 Phase C — QA orchestrator.
 *
 * The one entry point external callers use. Phase E's "Run QA"
 * button, Phase D's auto-post-repair hook, and any future
 * automated trigger all funnel through here — same code path,
 * same audit trail, same guarantees.
 *
 * PIPELINE:
 *
 *   assetId + kind
 *      ↓ loadAssetForQa()        [throws LegacyAssetError if no contentRunId]
 *   asset + ContentRun + Product + workspace
 *      ↓ acquireQaLock()         [throws ConcurrencyError if already QA_RUNNING]
 *   asset transitions to QA_RUNNING
 *      ↓ mcpGetAssetUrl()        [throws MediaFetchError on failure]
 *   signed URL for the asset bytes
 *      ↓ extractFrames() OR fetchImageAsBase64()   [throws Extraction/MediaFetchError]
 *   base64 asset + optional reference image
 *      ↓ provider.evaluate()     [throws Provider* on failure]
 *   VisualQaResult (Zod-validated inside the provider)
 *      ↓ decide()
 *   Decision + reason + triggering issues
 *      ↓ writeQaResult()         [throws PersistenceError on DB error]
 *   QaAttempt row + asset lifecycle updated
 *      ↓
 *   RunQaOutput returned to caller
 *
 * ERROR HANDLING:
 *   - LegacyAssetError + ConcurrencyError are thrown BEFORE any
 *     state changes. Asset lifecycle is untouched.
 *   - Any error AFTER lock acquisition is caught, converted to a
 *     writeQaFailure() call (records QaAttempt row + transitions
 *     asset to FAILED), then re-thrown so callers can render
 *     class-specific UI treatment. The DB is never left with a
 *     stuck QA_RUNNING as long as this function returns / throws.
 *   - Uncaught process crash mid-QA IS a known limitation — the
 *     asset stays at QA_RUNNING. Phase E gets a "Reset QA state"
 *     escape hatch.
 *
 * NO REPAIR: This module records a REGENERATE decision but does
 * NOT initiate any regeneration. Repair prompt, MCP re-call,
 * new asset creation are Phase D. On REGENERATE the asset ends
 * at qaStatus=REGEN_NEEDED and stays there for Phase D to pick
 * up.
 */

import { db } from "@/lib/db";
import { mcpGetAssetUrl } from "@/lib/apex-mcp";
import { fetchImageAsBase64 } from "@/lib/media/fetch-image";
import { decide } from "./decision-engine";
import { resolveQaConfig, DEFAULT_QA_CONFIG } from "./config";
import { RUBRIC, computeHasHardFailure } from "./rubric";
import {
  ConcurrencyError,
  FrameExtractionError,
  LegacyAssetError,
  MediaFetchError,
  ProviderError,
  ProviderValidationError,
  QaError,
} from "./errors";
import {
  acquireQaLock,
  loadAssetForQa,
  writeQaFailure,
  writeQaResult,
  type AssetForQa,
  type AssetKind,
} from "./persistence";
import { extractFrames, type FrameSamplingOptions } from "./frame-extraction";
import { createAnthropicVisualQaProvider } from "./providers/anthropic-visual-qa";
import type {
  AssetInput,
  VisualQaEvaluation,
  VisualQaInput,
  VisualQaProvider,
} from "./visual-qa-provider";
import type { AssetType, Decision, QaStatus } from "./types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunQaInput {
  assetId: string;
  assetKind: AssetKind;
  /** Audit — Phase C only ever passes "manual"; Phase D can pass
   *  "auto" once auto-QA on new assets is wired up. Currently
   *  informational only; kept in signature to lock the contract. */
  triggeredBy: "manual" | "auto";
  /** userId of the operator who clicked Run QA. Null for auto
   *  triggers or system-invoked calls. */
  triggeredByUserId?: string | null;
  /**
   * Optional provider override — mainly for tests that want to
   * inject a fake VisualQaProvider without going through the
   * default Anthropic factory. Production callers omit this and
   * let the orchestrator pick a provider from workspace settings.
   */
  providerOverride?: VisualQaProvider;
  /** Optional threshold overrides. Passed straight through to
   *  the decision engine. */
  configOverride?: Partial<typeof DEFAULT_QA_CONFIG>;
  /** Optional frame sampling override for videos. */
  samplingOverride?: Partial<FrameSamplingOptions>;
}

export interface RunQaOutput {
  attemptId: string;
  assetId: string;
  assetKind: AssetKind;
  decision: Decision;
  qaStatus: QaStatus;
  overallScore: number;
  attemptNumber: number;
  reason: string;
  elapsedMs: number;
  providerModel: string;
}

/**
 * Run one full QA cycle for one asset. See module doc for the
 * pipeline + error contract.
 */
export async function runQaForAsset(input: RunQaInput): Promise<RunQaOutput> {
  const startMs = Date.now();
  const config = resolveQaConfig(input.configOverride);

  // 1. Load asset context. Throws LegacyAssetError BEFORE any
  //    state changes when contentRunId is null.
  const asset = await loadAssetForQa({
    assetId: input.assetId,
    assetKind: input.assetKind,
  });

  // 2. Acquire the atomic lock. Throws ConcurrencyError if
  //    another QA/regen is in flight.
  await acquireQaLock({
    assetId: input.assetId,
    assetKind: input.assetKind,
  });

  // From here on, any error MUST end with writeQaFailure() so
  // the asset doesn't get stuck at QA_RUNNING.
  const assetType = resolveAssetType(asset);
  let providerModel = "n/a";
  let framesJson: string | null = null;

  try {
    // 3. Obtain a signed URL for the asset via MCP.
    const workspaceFlowEmail = asset.workspaceFlowEmail;
    if (!workspaceFlowEmail) {
      throw new MediaFetchError(
        `Workspace ${asset.workspaceId} has no flowEmail configured; cannot fetch asset URL from MCP.`,
      );
    }
    const signedUrl = await mcpGetAssetUrl({
      sub: asset.workspaceId,
      flowEmail: workspaceFlowEmail,
      mediaGenerationId: asset.mediaGenerationId,
    });
    if (!signedUrl) {
      throw new MediaFetchError(
        `MCP returned no URL for mediaGenerationId ${asset.mediaGenerationId} (asset ${asset.assetId}).`,
      );
    }

    // 4. Prepare the payload — extract frames for videos, base64
    //    the image for images. Fetch the reference image in
    //    parallel with extraction.
    let referenceImagePromise: Promise<
      Awaited<ReturnType<typeof fetchImageAsBase64>> | null
    > = Promise.resolve(null);
    if (asset.product.referenceImageUrl) {
      // Fetch the reference; MediaFetchError-wrap on failure so
      // the classification stays clean.
      referenceImagePromise = fetchImageAsBase64(
        asset.product.referenceImageUrl,
      ).catch((err) => {
        throw new MediaFetchError(
          `Reference image fetch failed for product ${asset.product.id}: ${(err as Error).message?.slice(0, 200)}`,
          { cause: err },
        );
      });
    }

    let assetInput: AssetInput;
    if (asset.kind === "video") {
      const extraction = await extractFrames({
        videoUrl: signedUrl,
        sampling: input.samplingOverride,
      });
      framesJson = JSON.stringify({
        durationSec: extraction.durationSec,
        requestedTimestampsMs: extraction.requestedTimestampsMs,
        frameCount: extraction.frames.length,
      });
      assetInput = { kind: "video", frames: extraction.frames };
    } else {
      const imageBytes = await fetchImageAsBase64(signedUrl).catch((err) => {
        throw new MediaFetchError(
          `Generated image fetch failed for asset ${asset.assetId}: ${(err as Error).message?.slice(0, 200)}`,
          { cause: err },
        );
      });
      assetInput = { kind: "image", image: imageBytes };
    }

    const referenceImage = await referenceImagePromise;

    // 5. Provider — evaluate.
    const provider =
      input.providerOverride ?? (await resolveDefaultProvider(asset.workspaceId));
    providerModel = provider.identifier;

    const evalInput: VisualQaInput = {
      assetType,
      sceneLabel: asset.sceneLabel,
      productName: asset.product.productName,
      ...(asset.product.category ? { productCategory: asset.product.category } : {}),
      market: asset.contentRun.market,
      ...(asset.originalPrompt ? { generationPrompt: asset.originalPrompt } : {}),
      referenceImage,
      asset: assetInput,
      rubric: RUBRIC,
    };
    let evaluation: VisualQaEvaluation;
    try {
      evaluation = await provider.evaluate(evalInput);
    } catch (err) {
      // ProviderError / ProviderValidationError already typed —
      // rethrow. Anything else, wrap.
      if (err instanceof QaError) throw err;
      throw new ProviderError(
        `Provider ${provider.identifier} threw an untyped error: ${(err as Error).message?.slice(0, 200)}`,
        { cause: err },
      );
    }
    providerModel = evaluation.providerModel;

    // 6. Decision engine.
    const decision = decide({
      result: evaluation.result,
      attemptNumber: asset.attemptNumber,
      config: input.configOverride,
    });
    const finalStatus: QaStatus = mapDecisionToStatus(
      decision.decision,
      decision.attemptsExhausted,
    );

    // 7. Persist.
    // Cross-check hasHardFailure locally in case the model got
    // it wrong; store the stricter value on the attempt row so
    // audit queries reflect reality.
    const localHardFailure = computeHasHardFailure(evaluation.result.checks);
    const hasHardFailureCombined =
      evaluation.result.hasHardFailure || localHardFailure;

    const attempt = await writeQaResult({
      asset,
      assetType,
      decision: decision.decision,
      finalStatus,
      overallScore: evaluation.result.overallScore,
      hasHardFailure: hasHardFailureCombined,
      resultJson: JSON.stringify(evaluation.result),
      framesJson,
      rubricVersion: config.RUBRIC_VERSION,
      providerModel: evaluation.providerModel,
    });

    return {
      attemptId: attempt.id,
      assetId: asset.assetId,
      assetKind: asset.kind,
      decision: decision.decision,
      qaStatus: finalStatus,
      overallScore: evaluation.result.overallScore,
      attemptNumber: asset.attemptNumber,
      reason: decision.reason,
      elapsedMs: Date.now() - startMs,
      providerModel: evaluation.providerModel,
    };
  } catch (err) {
    // Any error after lock acquisition: record + re-throw so
    // the asset doesn't stay stuck at QA_RUNNING.
    const qaErr =
      err instanceof QaError
        ? err
        : new ProviderError(
            `Unexpected orchestrator error: ${(err as Error).message?.slice(0, 200)}`,
            { cause: err },
          );
    await writeQaFailure({
      asset,
      assetType,
      rubricVersion: config.RUBRIC_VERSION,
      providerModel,
      errorCode: qaErr.code,
      errorStage: qaErr.stage,
      errorMessage: qaErr.message,
      framesJson,
    }).catch((persistErr) => {
      // Swallow persistence-of-failure errors — the primary
      // error is what the caller needs to see. We log it so it
      // shows in docker logs when it happens.
      console.error(
        `[qa-orchestrator] Failed to write failure record for ${asset.assetId}:`,
        persistErr,
      );
    });
    throw qaErr;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map (assetKind, sceneLabel) → the AssetType enum used by the
 *  rubric / QaAttempt.assetType column. */
function resolveAssetType(asset: AssetForQa): AssetType {
  const isStore = asset.sceneLabel.includes("scene_1_store");
  const isHome = asset.sceneLabel.includes("scene_2_home");
  if (asset.kind === "video") {
    if (isStore) return "STORE_VIDEO";
    if (isHome) return "HOME_VIDEO";
    // Combined / other video — default to STORE_VIDEO for
    // rubric purposes; the sceneLabel itself is passed through
    // to the prompt so the model sees the actual value.
    return "STORE_VIDEO";
  }
  if (isStore) return "STORE_IMAGE";
  if (isHome) return "HOME_IMAGE";
  return "STORE_IMAGE";
}

/** decision → qaStatus mapping. Kept as data so a future rule
 *  change (e.g. adding a distinct "APPROVED_WITH_NOTES" status)
 *  is a one-place edit. */
function mapDecisionToStatus(
  decision: Decision,
  attemptsExhausted: boolean,
): QaStatus {
  if (decision === "APPROVE") return "APPROVED";
  if (decision === "HUMAN_REVIEW") return "HUMAN_REVIEW";
  // REGENERATE — the max-attempts guard already downgrades to
  // HUMAN_REVIEW in the decision engine, but we double-check
  // here to be defensive.
  if (attemptsExhausted) return "HUMAN_REVIEW";
  return "REGEN_NEEDED";
}

/**
 * Default provider factory — resolves the workspace's
 * anthropic settings and constructs an AnthropicVisualQaProvider.
 * Isolated so tests never touch it (they pass providerOverride).
 */
async function resolveDefaultProvider(
  workspaceId: string,
): Promise<VisualQaProvider> {
  const settings = await db.workspaceSettings.findUnique({
    where: { workspaceId },
    select: { anthropicApiKey: true, anthropicModel: true },
  });
  const apiKey = (settings?.anthropicApiKey ?? "").trim();
  if (!apiKey) {
    throw new ProviderError(
      `Workspace ${workspaceId} has no Anthropic API key configured. Visual QA requires one — set it in workspace settings.`,
    );
  }
  const model = (settings?.anthropicModel ?? "").trim() || undefined;
  return createAnthropicVisualQaProvider({ apiKey, ...(model ? { model } : {}) });
}
