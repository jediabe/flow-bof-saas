/**
 * QA persistence primitives — the DB-side of the orchestrator.
 *
 * Everything that reads or writes Prisma for the QA loop lives
 * here so the orchestrator stays readable and testable
 * separately. Two orchestrator-facing capabilities:
 *
 *   1. loadAssetForQa — hydrate the asset + ContentRun +
 *      Product + Batch + Workspace context needed by the
 *      provider. Explicit LegacyAssetError when no contentRunId.
 *
 *   2. acquireQaLock — atomic compare-and-swap on qaStatus.
 *      Returns { attemptNumber } on success. Throws
 *      ConcurrencyError on failure. Uses updateMany's where
 *      clause as a SQL-level CAS — two racing calls can't both
 *      succeed.
 *
 *   3. writeQaResult — final transactional write of the
 *      QaAttempt row plus asset lifecycle update. On any error,
 *      the caller uses writeQaFailure instead to record a
 *      FAILED transition + audit row.
 *
 *   4. writeQaFailure — records a QA failure (validation error,
 *      provider crash, extraction failure) as a QaAttempt row
 *      with decision=HUMAN_REVIEW + error captured, transitions
 *      asset to FAILED. Called from the orchestrator's catch
 *      after lock acquisition.
 *
 *   5. releaseQaLockToStatus — narrow helper for the pre-lock
 *      LegacyAssetError path (never used post-lock: writeQaResult
 *      / writeQaFailure own the final transition).
 *
 * DB CONVENTION: reads via `db` from @/lib/db (Prisma singleton).
 * Writes wrapped in $transaction where two rows change atomically.
 */

import { db } from "@/lib/db";
import { ConcurrencyError, LegacyAssetError, PersistenceError } from "./errors";
import type { Decision, QaStatus, AssetType } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssetKind = "video" | "image";

/** Everything the orchestrator needs about an asset before it
 *  starts the QA pipeline. Denormalised at query time so
 *  the provider call gets one flat object. */
export interface AssetForQa {
  kind: AssetKind;
  assetId: string;
  mediaGenerationId: string;
  sceneLabel: string;
  originalPrompt: string | null;
  attemptNumber: number;
  contentRunId: string;
  contentRun: {
    id: string;
    style: string;
    market: string;
  };
  product: {
    id: string;
    productName: string;
    category: string | null;
    referenceImageUrl: string | null;
  };
  workspaceId: string;
  workspaceFlowEmail: string | null;
  /** Workspace OWNER's userId. Used by the orchestrator to walk
   *  resolveLlmCredential() — same credential chain the chat
   *  agent uses (user_oauth → user_key → app_key). */
  workspaceOwnerId: string;
}

// ---------------------------------------------------------------------------
// Load — hydrate the row + full ancestry
// ---------------------------------------------------------------------------

/** Full asset+run+product+workspace lookup. Throws LegacyAssetError
 *  when the asset has no contentRunId; throws PersistenceError when
 *  the asset itself is missing. Never returns null. */
export async function loadAssetForQa(input: {
  assetId: string;
  assetKind: AssetKind;
}): Promise<AssetForQa> {
  if (input.assetKind === "video") {
    const row = await db.flowGeneratedVideo.findUnique({
      where: { id: input.assetId },
      include: {
        contentRun: true,
        product: {
          include: {
            batch: {
              include: {
                workspace: { include: { settings: true, owner: true } },
              },
            },
          },
        },
      },
    });
    if (!row) {
      throw new PersistenceError(
        `FlowGeneratedVideo ${input.assetId} not found.`,
      );
    }
    if (!row.contentRunId || !row.contentRun) {
      throw new LegacyAssetError(input.assetId, "video");
    }
    return {
      kind: "video",
      assetId: row.id,
      mediaGenerationId: row.mediaGenerationId,
      sceneLabel: row.sceneLabel,
      originalPrompt: row.prompt,
      attemptNumber: row.attemptNumber,
      contentRunId: row.contentRunId,
      contentRun: {
        id: row.contentRun.id,
        style: row.contentRun.style,
        market: row.contentRun.market,
      },
      product: {
        id: row.product.id,
        productName: row.product.productName,
        category: row.product.category,
        referenceImageUrl: row.product.referenceImageUrl,
      },
      workspaceId: row.product.batch.workspaceId,
      workspaceFlowEmail: row.product.batch.workspace.settings?.flowEmail ?? null,
      workspaceOwnerId: row.product.batch.workspace.owner.id,
    };
  }
  // image
  const row = await db.flowGeneratedImage.findUnique({
    where: { id: input.assetId },
    include: {
      contentRun: true,
      product: {
        include: {
          batch: {
            include: {
              workspace: { include: { settings: true, owner: true } },
            },
          },
        },
      },
    },
  });
  if (!row) {
    throw new PersistenceError(
      `FlowGeneratedImage ${input.assetId} not found.`,
    );
  }
  if (!row.contentRunId || !row.contentRun) {
    throw new LegacyAssetError(input.assetId, "image");
  }
  return {
    kind: "image",
    assetId: row.id,
    mediaGenerationId: row.mediaGenerationId,
    sceneLabel: row.sceneLabel,
    originalPrompt: row.prompt,
    attemptNumber: row.attemptNumber,
    contentRunId: row.contentRunId,
    contentRun: {
      id: row.contentRun.id,
      style: row.contentRun.style,
      market: row.contentRun.market,
    },
    product: {
      id: row.product.id,
      productName: row.product.productName,
      category: row.product.category,
      referenceImageUrl: row.product.referenceImageUrl,
    },
    workspaceId: row.product.batch.workspaceId,
    workspaceFlowEmail: row.product.batch.workspace.settings?.flowEmail ?? null,
    workspaceOwnerId: row.product.batch.workspace.owner.id,
  };
}

// ---------------------------------------------------------------------------
// Acquire — atomic compare-and-swap on qaStatus
// ---------------------------------------------------------------------------

/**
 * Transition the asset from any-status-except-QA_RUNNING-or-
 * REGEN_IN_FLIGHT into QA_RUNNING. Returns void on success.
 * Throws ConcurrencyError if another QA/regen is already in
 * flight.
 *
 * SQL semantics: updateMany's where-clause is compiled to an
 * atomic UPDATE ... WHERE, so two racing calls cannot both
 * satisfy the predicate. The second one gets count=0.
 *
 * STUCK-LOCK NOTE: this is intentionally strict — an aborted
 * node process leaves the asset stuck at QA_RUNNING. Phase E
 * exposes a "Reset QA state" affordance for that case.
 * Milestone 1 does not build automatic stale-lock recovery.
 */
export async function acquireQaLock(input: {
  assetId: string;
  assetKind: AssetKind;
}): Promise<void> {
  const forbidden = ["QA_RUNNING", "REGEN_IN_FLIGHT"] as const;
  if (input.assetKind === "video") {
    const updated = await db.flowGeneratedVideo.updateMany({
      where: {
        id: input.assetId,
        qaStatus: { notIn: [...forbidden] },
      },
      data: { qaStatus: "QA_RUNNING" satisfies QaStatus },
    });
    if (updated.count !== 1) {
      const current = await db.flowGeneratedVideo.findUnique({
        where: { id: input.assetId },
        select: { qaStatus: true },
      });
      throw new ConcurrencyError(input.assetId, current?.qaStatus);
    }
    return;
  }
  const updated = await db.flowGeneratedImage.updateMany({
    where: {
      id: input.assetId,
      qaStatus: { notIn: [...forbidden] },
    },
    data: { qaStatus: "QA_RUNNING" satisfies QaStatus },
  });
  if (updated.count !== 1) {
    const current = await db.flowGeneratedImage.findUnique({
      where: { id: input.assetId },
      select: { qaStatus: true },
    });
    throw new ConcurrencyError(input.assetId, current?.qaStatus);
  }
}

// ---------------------------------------------------------------------------
// Write — final transactional persistence of a QA attempt
// ---------------------------------------------------------------------------

export interface WriteQaResultInput {
  asset: AssetForQa;
  assetType: AssetType;
  decision: Decision;
  finalStatus: QaStatus;
  overallScore: number;
  hasHardFailure: boolean;
  resultJson: string;             // Zod-validated VisualQaResult, stringified
  framesJson: string | null;      // extractor diagnostics, stringified
  rubricVersion: string;
  providerModel: string;
}

export interface QaAttemptRow {
  id: string;
  decision: Decision;
  finalStatus: QaStatus;
}

/**
 * Transactionally:
 *   1. Insert QaAttempt.
 *   2. Update the asset row's qaStatus / qaScore / qaVerdictJson
 *      / qaCompletedAt.
 * Returns the QaAttempt id.
 */
export async function writeQaResult(
  input: WriteQaResultInput,
): Promise<QaAttemptRow> {
  const now = new Date();
  try {
    return await db.$transaction(async (tx) => {
      const attempt = await tx.qaAttempt.create({
        data: {
          ...(input.asset.kind === "video"
            ? { videoId: input.asset.assetId }
            : { imageId: input.asset.assetId }),
          assetType: input.assetType,
          attemptNumber: input.asset.attemptNumber,
          rubricVersion: input.rubricVersion,
          providerModel: input.providerModel,
          framesJson: input.framesJson,
          resultJson: input.resultJson,
          decision: input.decision,
          overallScore: input.overallScore,
          hasHardFailure: input.hasHardFailure,
        },
        select: { id: true, decision: true },
      });
      if (input.asset.kind === "video") {
        await tx.flowGeneratedVideo.update({
          where: { id: input.asset.assetId },
          data: {
            qaStatus: input.finalStatus,
            qaScore: input.overallScore,
            qaVerdictJson: input.resultJson,
            qaCompletedAt: now,
          },
        });
      } else {
        await tx.flowGeneratedImage.update({
          where: { id: input.asset.assetId },
          data: {
            qaStatus: input.finalStatus,
            qaScore: input.overallScore,
            qaVerdictJson: input.resultJson,
            qaCompletedAt: now,
          },
        });
      }
      return {
        id: attempt.id,
        decision: attempt.decision as Decision,
        finalStatus: input.finalStatus,
      };
    });
  } catch (err) {
    throw new PersistenceError(
      `Failed to write QA result for asset ${input.asset.assetId}: ${(err as Error).message?.slice(0, 200)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Failure path — record the failure + transition asset to FAILED
// ---------------------------------------------------------------------------

export interface WriteQaFailureInput {
  asset: AssetForQa;
  assetType: AssetType;
  rubricVersion: string;
  /** Provider model used, if we got that far. "n/a" when we
   *  failed before calling the provider. */
  providerModel: string;
  /** Error code + stage from the thrown QaError, or a generic
   *  fallback. */
  errorCode: string;
  errorStage: string;
  errorMessage: string;
  /** ExtractedFrame metadata if extraction ran, else null. */
  framesJson: string | null;
}

/**
 * Records the failure as a QaAttempt row (decision=HUMAN_REVIEW,
 * overallScore=0, hasHardFailure=true so audit filters show
 * these as needing attention) and transitions the asset to
 * FAILED. Called from the orchestrator's catch block after lock
 * acquisition — the asset is currently at QA_RUNNING and MUST
 * leave that state.
 */
export async function writeQaFailure(
  input: WriteQaFailureInput,
): Promise<QaAttemptRow> {
  const now = new Date();
  const resultJson = JSON.stringify({
    error: {
      code: input.errorCode,
      stage: input.errorStage,
      message: input.errorMessage,
    },
    // Empty shell to signal "no evaluation happened."
    overallScore: 0,
    checks: [],
    issues: [],
    hasHardFailure: true,
  });
  try {
    return await db.$transaction(async (tx) => {
      const attempt = await tx.qaAttempt.create({
        data: {
          ...(input.asset.kind === "video"
            ? { videoId: input.asset.assetId }
            : { imageId: input.asset.assetId }),
          assetType: input.assetType,
          attemptNumber: input.asset.attemptNumber,
          rubricVersion: input.rubricVersion,
          providerModel: input.providerModel,
          framesJson: input.framesJson,
          resultJson,
          decision: "HUMAN_REVIEW" satisfies Decision,
          overallScore: 0,
          hasHardFailure: true,
        },
        select: { id: true, decision: true },
      });
      if (input.asset.kind === "video") {
        await tx.flowGeneratedVideo.update({
          where: { id: input.asset.assetId },
          data: {
            qaStatus: "FAILED" satisfies QaStatus,
            qaVerdictJson: resultJson,
            qaCompletedAt: now,
          },
        });
      } else {
        await tx.flowGeneratedImage.update({
          where: { id: input.asset.assetId },
          data: {
            qaStatus: "FAILED" satisfies QaStatus,
            qaVerdictJson: resultJson,
            qaCompletedAt: now,
          },
        });
      }
      return {
        id: attempt.id,
        decision: "HUMAN_REVIEW",
        finalStatus: "FAILED",
      };
    });
  } catch (err) {
    // If we can't even record the failure, best-effort: try to
    // move the asset out of QA_RUNNING so it's not stuck. We
    // still throw PersistenceError so the caller knows the
    // audit row is missing.
    if (input.asset.kind === "video") {
      await db.flowGeneratedVideo
        .update({
          where: { id: input.asset.assetId },
          data: { qaStatus: "FAILED" satisfies QaStatus },
        })
        .catch(() => {});
    } else {
      await db.flowGeneratedImage
        .update({
          where: { id: input.asset.assetId },
          data: { qaStatus: "FAILED" satisfies QaStatus },
        })
        .catch(() => {});
    }
    throw new PersistenceError(
      `Failed to write QA failure record for asset ${input.asset.assetId}: ${(err as Error).message?.slice(0, 200)}`,
      { cause: err },
    );
  }
}
