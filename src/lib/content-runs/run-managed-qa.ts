import type { PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import { projectContentRun } from "./project-run";
import type {
  ContentRunState,
  ManifestAwareContentRunProjection,
  ServiceActorContext,
} from "./types";
import {
  isPostLockQaFailure,
  runQaForAsset,
  type RunQaOutput,
} from "@/lib/qa/orchestrator";
import type { AssetKind } from "@/lib/qa/persistence";

export interface RunManagedQaCommand {
  contentRunId: string;
  assetId: string;
  assetKind: AssetKind;
}

export interface RunManagedQaDependencies {
  prisma?: PrismaClient;
  runQa?: typeof runQaForAsset;
}

export interface RunManagedQaResult {
  contentRunId: string;
  assetId: string;
  assetKind: AssetKind;
  decision: RunQaOutput["decision"];
  qaStatus: RunQaOutput["qaStatus"];
  runStatus: ContentRunState;
  requiredNextAction: ManifestAwareContentRunProjection["requiredNextAction"];
}

export type ManagedQaErrorCode =
  | "INVALID_MANAGED_QA_REQUEST"
  | "CONTENT_RUN_NOT_FOUND"
  | "MANAGED_ASSET_NOT_READY"
  | "CONTENT_RUN_STATE_CONFLICT";

export class ManagedQaError extends Error {
  readonly name = "ManagedQaError";

  constructor(
    readonly code: ManagedQaErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type LoadedManagedRun = Awaited<ReturnType<typeof loadScopedRun>>;

const COMMAND_KEYS = new Set(["contentRunId", "assetId", "assetKind"]);

function assertExactCommand(command: RunManagedQaCommand): void {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new ManagedQaError(
      "INVALID_MANAGED_QA_REQUEST",
      "Managed QA command must be an object",
    );
  }
  const unexpected = Object.keys(command).filter((key) => !COMMAND_KEYS.has(key));
  if (
    unexpected.length > 0 ||
    typeof command.contentRunId !== "string" ||
    typeof command.assetId !== "string" ||
    (command.assetKind !== "image" && command.assetKind !== "video")
  ) {
    throw new ManagedQaError(
      "INVALID_MANAGED_QA_REQUEST",
      "Managed QA command contains unsupported fields or values",
      unexpected.length > 0
        ? { field: unexpected[0] }
        : typeof command.contentRunId !== "string"
          ? { field: "contentRunId" }
          : typeof command.assetId !== "string"
            ? { field: "assetId" }
            : { field: "assetKind" },
    );
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ManagedQaError(
      "INVALID_MANAGED_QA_REQUEST",
      `${field} must be a string`,
      { field },
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new ManagedQaError(
      "INVALID_MANAGED_QA_REQUEST",
      `${field} is required`,
      { field },
    );
  }
  return normalized;
}

async function loadScopedRun(
  prisma: PrismaClient,
  workspaceId: string,
  contentRunId: string,
) {
  const run = await prisma.contentRun.findFirst({
    where: {
      id: contentRunId,
      product: { batch: { workspaceId } },
    },
    select: {
      id: true,
      productId: true,
      style: true,
      status: true,
      promptSnapshotJson: true,
      images: {
        select: {
          id: true,
          contentRunId: true,
          sceneLabel: true,
          attemptNumber: true,
          qaStatus: true,
          qaScore: true,
          qaVerdictJson: true,
        },
      },
      videos: {
        select: {
          id: true,
          contentRunId: true,
          sceneLabel: true,
          attemptNumber: true,
          qaStatus: true,
          qaScore: true,
          qaVerdictJson: true,
        },
      },
      operations: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          contentRunId: true,
          kind: true,
          sceneLabel: true,
          status: true,
          providerJobId: true,
          errorJson: true,
        },
      },
    },
  });
  if (!run) {
    throw new ManagedQaError(
      "CONTENT_RUN_NOT_FOUND",
      "Content run was not found in the authenticated workspace",
      { contentRunId },
    );
  }
  return run;
}

function project(run: LoadedManagedRun): ManifestAwareContentRunProjection {
  assertManagedRunIdentity(run);
  return projectContentRun({
    run,
    images: run.images,
    videos: run.videos,
    operations: run.operations,
  });
}

function expectedManagedVersion(style: string): string | null {
  if (style === "style1") return "managed-style1-v1";
  if (style === "style2") return "managed-style2-v1";
  return null;
}

function assertManagedRunIdentity(run: LoadedManagedRun): void {
  try {
    const snapshot = JSON.parse(run.promptSnapshotJson ?? "") as Record<string, unknown>;
    const expectedVersion = expectedManagedVersion(run.style);
    if (
      expectedVersion &&
      snapshot.objective === `create_${run.style}_piece` &&
      snapshot.specVersion === expectedVersion
    ) {
      return;
    }
  } catch {
    // The stable domain error below owns malformed and mismatched snapshots.
  }
  throw new ManagedQaError(
    "MANAGED_ASSET_NOT_READY",
    "Content run is not an approved managed style objective",
    { contentRunId: run.id },
  );
}

function assertManagedProjection(
  run: LoadedManagedRun,
  projection: ManifestAwareContentRunProjection,
): void {
  const expectedVersion = expectedManagedVersion(run.style);
  if (
    !expectedVersion ||
    projection.objective !== `create_${run.style}_piece` ||
    projection.specVersion !== expectedVersion
  ) {
    throw new ManagedQaError(
      "MANAGED_ASSET_NOT_READY",
      "Content run is not an approved managed style objective",
      { contentRunId: run.id },
    );
  }
}

function assertQaAction(
  run: LoadedManagedRun,
  command: RunManagedQaCommand,
  projection = project(run),
): void {
  if (run.status !== "qa_running") {
    throw new ManagedQaError(
      "MANAGED_ASSET_NOT_READY",
      "Content run is not waiting for mandatory QA",
      { contentRunId: run.id, status: run.status },
    );
  }
  assertManagedProjection(run, projection);
  const action = projection.requiredNextAction;
  const expectedAsset =
    command.assetKind === "image"
      ? run.images.find((asset) => asset.id === command.assetId)
      : run.videos.find((asset) => asset.id === command.assetId);
  if (
    action.type !== "RUN_QA" ||
    action.assetId !== command.assetId ||
    !expectedAsset
  ) {
    throw new ManagedQaError(
      "MANAGED_ASSET_NOT_READY",
      "Asset is not the SaaS-derived mandatory QA action for this run",
      {
        contentRunId: run.id,
        assetId: command.assetId,
        requiredNextAction: action.type,
      },
    );
  }
}

function reconciliationDecision(
  run: LoadedManagedRun,
  command: RunManagedQaCommand,
  projection: ManifestAwareContentRunProjection,
): Pick<RunManagedQaResult, "decision" | "qaStatus"> | null {
  const expectedAssetIds = new Set(
    (command.assetKind === "image" ? run.images : run.videos).map((asset) => asset.id),
  );
  const slotIndex = projection.slots.findIndex(
    (slot) =>
      slot.selectedAssetId === command.assetId &&
      expectedAssetIds.has(command.assetId),
  );
  if (slotIndex < 0) return null;

  const slot = projection.slots[slotIndex];
  const attempt = slot.attempts.find((candidate) => candidate.selected);
  if (
    !attempt ||
    attempt.qaStatus === "NOT_QA_CHECKED" ||
    attempt.qaStatus === "QA_RUNNING"
  ) {
    return null;
  }

  const action = projection.requiredNextAction;
  const expectedActionMatches =
    attempt.qaStatus === "APPROVED"
      ? !(
          (action.type === "RUN_QA" && action.assetId === command.assetId) ||
          action.type === "FAILED" ||
          action.type === "HUMAN_REVIEW"
        )
      : attempt.qaStatus === "FAILED"
        ? action.type === "FAILED"
        : action.type === "HUMAN_REVIEW";
  if (!expectedActionMatches || run.status !== "qa_running") return null;

  return {
    decision:
      attempt.qaStatus === "APPROVED"
        ? "APPROVE"
        : attempt.qaStatus === "REGEN_NEEDED" ||
            attempt.qaStatus === "REGEN_IN_FLIGHT"
          ? "REGENERATE"
          : "HUMAN_REVIEW",
    qaStatus: attempt.qaStatus,
  };
}

async function synchronizeRunAfterQa(
  prisma: PrismaClient,
  workspaceId: string,
  contentRunId: string,
  allowQaRunning = false,
): Promise<ManifestAwareContentRunProjection> {
  const run = await loadScopedRun(prisma, workspaceId, contentRunId);
  const projection = project(run);
  const target = projection.status;
  if (target === "qa_running") {
    if (allowQaRunning) return projection;
    throw new ManagedQaError(
      "CONTENT_RUN_STATE_CONFLICT",
      "QA completed without a terminal asset decision",
      { contentRunId },
    );
  }
  // Multiple managed-QA callers can observe the same persisted asset decision.
  // Once one caller has projected that decision, the others must treat the
  // identical target as success rather than turning a valid QA result into a
  // run-state conflict.
  if (run.status === target) return projection;

  const updated = await prisma.contentRun.updateMany({
    where: {
      id: contentRunId,
      status: "qa_running",
      product: { batch: { workspaceId } },
    },
    data: {
      status: target,
      ...(target === "ready" ? { completedAt: new Date() } : {}),
    },
  });
  if (updated.count !== 1) {
    const latestRun = await loadScopedRun(prisma, workspaceId, contentRunId);
    const latestProjection = project(latestRun);
    if (latestRun.status === target && latestProjection.status === target) {
      return latestProjection;
    }
    throw new ManagedQaError(
      "CONTENT_RUN_STATE_CONFLICT",
      "Content run changed while mandatory QA was completing",
      { contentRunId },
    );
  }
  return projection;
}

async function failRunAfterPostLockQaFailure(
  prisma: PrismaClient,
  workspaceId: string,
  contentRunId: string,
): Promise<void> {
  await prisma.contentRun.updateMany({
    where: {
      id: contentRunId,
      status: "qa_running",
      product: { batch: { workspaceId } },
    },
    data: { status: "failed" },
  });
}

export async function runManagedQa(
  actor: ServiceActorContext,
  command: RunManagedQaCommand,
  dependencies: RunManagedQaDependencies = {},
): Promise<RunManagedQaResult> {
  assertExactCommand(command);
  const contentRunId = requireNonEmpty(command.contentRunId, "contentRunId");
  const assetId = requireNonEmpty(command.assetId, "assetId");
  const prisma = dependencies.prisma ?? db;
  const runQa = dependencies.runQa ?? runQaForAsset;

  const run = await loadScopedRun(prisma, actor.workspaceId, contentRunId);
  const normalizedCommand = { ...command, contentRunId, assetId };
  const initialProjection = project(run);
  assertManagedProjection(run, initialProjection);
  const recovered = reconciliationDecision(run, normalizedCommand, initialProjection);
  if (recovered) {
    const projection = await synchronizeRunAfterQa(
      prisma,
      actor.workspaceId,
      contentRunId,
    );
    return {
      contentRunId,
      assetId,
      assetKind: command.assetKind,
      ...recovered,
      runStatus: projection.status,
      requiredNextAction: projection.requiredNextAction,
    };
  }
  assertQaAction(run, normalizedCommand, initialProjection);

  let qaResult: RunQaOutput;
  try {
    qaResult = await runQa({
      assetId,
      assetKind: command.assetKind,
      triggeredBy: "auto",
      triggeredByUserId: null,
      configOverride: { MAX_REPAIR_ATTEMPTS: 1 },
      expectedContext: {
        workspaceId: actor.workspaceId,
        contentRunId,
        qaStatus: "NOT_QA_CHECKED",
        managedStorage: true,
      },
    });
  } catch (error) {
    // The existing QA path deterministically moves a post-lock evaluator or
    // infrastructure failure to asset FAILED before rethrowing. Project that
    // auditable failure onto the managed run before preserving the root error.
    try {
      const projection = await synchronizeRunAfterQa(
        prisma,
        actor.workspaceId,
        contentRunId,
        true,
      );
      if (projection.status === "qa_running" && isPostLockQaFailure(error)) {
        await failRunAfterPostLockQaFailure(
          prisma,
          actor.workspaceId,
          contentRunId,
        );
      }
    } catch {
      // Projection is secondary to the root QA failure. A post-lock failure
      // still gets one scoped best-effort run terminalization attempt, while
      // pre-lock ownership/concurrency errors leave the run retryable.
      if (isPostLockQaFailure(error)) {
        await failRunAfterPostLockQaFailure(
          prisma,
          actor.workspaceId,
          contentRunId,
        ).catch(() => undefined);
      }
    }
    throw error;
  }
  const projection = await synchronizeRunAfterQa(
    prisma,
    actor.workspaceId,
    contentRunId,
  );
  return {
    ...qaResult,
    contentRunId,
    runStatus: projection.status,
    requiredNextAction: projection.requiredNextAction,
  };
}
