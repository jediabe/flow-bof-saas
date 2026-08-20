import type { PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import { SLOT_DEFINITIONS } from "@/lib/content-runs/constants";
import { projectContentRun } from "@/lib/content-runs/project-run";
import type { ServiceActorContext, VideoSlot } from "@/lib/content-runs/types";
import {
  createObjectStorageFromEnv,
  type ObjectStorage,
} from "@/lib/storage";
import {
  createApexFlowAdapter,
  type ApexFlowAdapter,
  type ApexFlowBoundContext,
  type VideoPollResult,
} from "./apex-flow-adapter";
import { createOperationRepository, type OperationRepository } from "./operations";
import {
  persistGeneratedMedia,
  type PersistedGeneratedMedia,
  type PersistGeneratedMediaDependencies,
} from "./persist-media";
import {
  createProviderLockRepository,
  type ProviderLockRepository,
} from "./provider-lock";
import { executeWithTechnicalRetries } from "./technical-retry";
import { ContentGenerationError, type ContentOperationRecord } from "./types";

export const MANAGED_VIDEO_LOCK_TTL_MS = 30 * 60 * 1_000;

export interface GenerateManagedStyle1VideoCommand {
  contentRunId: string;
  slot: VideoSlot;
  idempotencyKey: string;
}

export interface ManagedGeneratedVideoAsset {
  id: string;
  contentRunId: string | null;
  sceneLabel: string;
  mediaGenerationId: string;
  imageMediaGenerationId: string | null;
  sourceImageId: string | null;
  prompt: string | null;
  attemptNumber: number;
  qaStatus: string;
  storageBucket: string | null;
  storageKey: string | null;
  storageContentType: string | null;
  storageBytes: number | null;
  storageSha256: string | null;
}

export type GenerateManagedStyle1VideoResult =
  | {
      operationId: string;
      operationStatus: "running";
      contentRunId: string;
      slot: VideoSlot;
      providerJobId?: string;
      requiredNextAction: { type: "WAIT_FOR_OPERATION"; operationId: string };
    }
  | {
      operationId: string;
      operationStatus: "succeeded";
      contentRunId: string;
      slot: VideoSlot;
      providerJobId: string;
      asset: ManagedGeneratedVideoAsset;
      requiredNextAction: { type: "RUN_QA"; slot: VideoSlot; assetId: string };
    };

type PersistMedia = typeof persistGeneratedMedia;

export interface GenerateManagedStyle1VideoDependencies {
  prisma?: PrismaClient;
  objectStorage?: ObjectStorage;
  createAdapter?: (context: ApexFlowBoundContext) => ApexFlowAdapter;
  operationRepository?: OperationRepository;
  providerLockRepository?: ProviderLockRepository;
  persistMedia?: PersistMedia;
  fetchMedia?: PersistGeneratedMediaDependencies["fetchMedia"];
  createAssetId?: PersistGeneratedMediaDependencies["createAssetId"];
  lockTtlMs?: number;
}

export type ManagedVideoGenerationErrorCode =
  | "INVALID_VIDEO_GENERATION_REQUEST"
  | "CONTENT_RUN_NOT_FOUND"
  | "INVALID_CONTENT_RUN_STATE"
  | "VIDEO_SLOT_NOT_READY"
  | "SOURCE_IMAGE_NOT_APPROVED"
  | "INVALID_FROZEN_SNAPSHOT"
  | "FLOW_ACCOUNT_REQUIRED"
  | "PROVIDER_VIDEO_FAILED"
  | "COMPLETED_OPERATION_ASSET_MISSING";

export class ManagedVideoGenerationError extends Error {
  readonly name = "ManagedVideoGenerationError";

  constructor(
    readonly code: ManagedVideoGenerationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface FrozenVideoSlot {
  prompt: string;
  model: string;
  aspectRatio: string;
  durationSeconds: number;
  sourceSlot: string;
}

interface SourceImage {
  id: string;
  contentRunId: string | null;
  sceneLabel: string;
  mediaGenerationId: string;
  qaStatus: string;
}

interface LoadedRun {
  id: string;
  productId: string;
  style: string;
  status: string;
  promptSnapshotJson: string | null;
  images: Array<{
    id: string;
    contentRunId: string | null;
    sceneLabel: string;
    attemptNumber: number;
    qaStatus: string;
    qaScore: number | null;
    qaVerdictJson: string | null;
  }>;
  videos: Array<{
    id: string;
    contentRunId: string | null;
    sceneLabel: string;
    attemptNumber: number;
    qaStatus: string;
    qaScore: number | null;
    qaVerdictJson: string | null;
  }>;
  operations: Array<{
    id: string;
    contentRunId: string;
    kind: string;
    sceneLabel: string;
    status: string;
    providerJobId: string | null;
    errorJson: string | null;
  }>;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ManagedVideoGenerationError(
      "INVALID_VIDEO_GENERATION_REQUEST",
      `${field} is required`,
      { field },
    );
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readFrozenVideoSlot(
  snapshotJson: string | null,
  slot: VideoSlot,
  expectedProductId: string,
  persistedStyle: string,
): FrozenVideoSlot {
  let snapshot: Record<string, unknown>;
  try {
    const parsed = snapshotJson ? JSON.parse(snapshotJson) : null;
    const record = asRecord(parsed);
    if (!record) throw new Error("snapshot must be an object");
    snapshot = record;
  } catch (cause) {
    throw new ManagedVideoGenerationError(
      "INVALID_FROZEN_SNAPSHOT",
      "Content run has no valid frozen generation snapshot",
      {},
      { cause },
    );
  }

  const product = asRecord(snapshot.product);
  if (
    persistedStyle !== "style1" ||
    snapshot.style !== "style1" ||
    snapshot.objective !== "create_style1_piece" ||
    snapshot.specVersion !== "managed-style1-v1" ||
    product?.id !== expectedProductId
  ) {
    throw new ManagedVideoGenerationError(
      "INVALID_FROZEN_SNAPSHOT",
      "Content run is not the managed Style 1 V1 objective",
      { slot },
    );
  }

  const models = asRecord(snapshot.modelSnapshot);
  const model = nonEmptyString(models?.videoModel);
  const slots = Array.isArray(snapshot.slots) ? snapshot.slots : [];
  const slotRecord = slots.map(asRecord).find((candidate) => candidate?.slot === slot);
  const generation = asRecord(slotRecord?.generation);
  const prompt = nonEmptyString(slotRecord?.prompt);
  const aspectRatio = nonEmptyString(generation?.aspectRatio);
  const sourceSlot = nonEmptyString(generation?.startImageSlot);
  const durationSeconds = generation?.durationSeconds;

  if (
    slotRecord?.mediaType !== "video" ||
    !model ||
    !prompt ||
    !aspectRatio ||
    !sourceSlot ||
    !Number.isSafeInteger(durationSeconds) ||
    (durationSeconds as number) <= 0 ||
    sourceSlot !== SLOT_DEFINITIONS[slot].sourceSlot
  ) {
    throw new ManagedVideoGenerationError(
      "INVALID_FROZEN_SNAPSHOT",
      "Frozen snapshot is missing the requested video slot inputs",
      { slot },
    );
  }

  return {
    prompt,
    model,
    aspectRatio,
    durationSeconds: durationSeconds as number,
    sourceSlot,
  };
}

async function loadScopedRun(
  prisma: PrismaClient,
  workspaceId: string,
  contentRunId: string,
): Promise<LoadedRun> {
  const run = await prisma.contentRun.findFirst({
    where: { id: contentRunId, product: { batch: { workspaceId } } },
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
    throw new ManagedVideoGenerationError(
      "CONTENT_RUN_NOT_FOUND",
      "Content run was not found in the authenticated workspace",
      { contentRunId },
    );
  }
  return run;
}

function assertSlotReady(run: LoadedRun, slot: VideoSlot): string {
  if (run.status !== "generating") {
    throw new ManagedVideoGenerationError(
      "INVALID_CONTENT_RUN_STATE",
      "Content run is not eligible for video generation",
      { contentRunId: run.id, status: run.status },
    );
  }
  const projection = projectContentRun({
    run,
    images: run.images,
    videos: run.videos,
    operations: run.operations,
  });
  const action = projection.requiredNextAction;
  if (action.type !== "GENERATE_VIDEO" || action.slot !== slot) {
    throw new ManagedVideoGenerationError(
      "VIDEO_SLOT_NOT_READY",
      "Requested video slot is not the SaaS-derived next action",
      { contentRunId: run.id, slot, requiredNextAction: action.type },
    );
  }
  return action.sourceAssetId;
}

async function loadApprovedSource(
  prisma: PrismaClient,
  workspaceId: string,
  run: LoadedRun,
  slot: VideoSlot,
  expectedSourceId: string,
): Promise<SourceImage> {
  const definition = SLOT_DEFINITIONS[slot];
  const sourceDefinition = SLOT_DEFINITIONS[definition.sourceSlot];
  const source = await prisma.flowGeneratedImage.findFirst({
    where: {
      id: expectedSourceId,
      contentRunId: run.id,
      sceneLabel: sourceDefinition.persistedSceneLabel,
      qaStatus: "APPROVED",
      product: { batch: { workspaceId } },
    },
    select: {
      id: true,
      contentRunId: true,
      sceneLabel: true,
      mediaGenerationId: true,
      qaStatus: true,
    },
  });
  if (!source) {
    throw new ManagedVideoGenerationError(
      "SOURCE_IMAGE_NOT_APPROVED",
      "Video generation requires the approved source still from the same run and scene",
      { contentRunId: run.id, slot },
    );
  }
  return source;
}

function isResumableAcceptedPollError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return (
    record.classification === "technical-retryable" &&
    record.acceptedProviderIdentity === true
  );
}

function safeOperationError(error: unknown): Record<string, unknown> {
  if (error instanceof ManagedVideoGenerationError || error instanceof ContentGenerationError) {
    return { code: error.code, details: error.details };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      code: nonEmptyString(record.code) ?? "VIDEO_GENERATION_FAILED",
      ...(nonEmptyString(record.stage) ? { stage: record.stage } : {}),
      ...(typeof record.classification === "string"
        ? { classification: record.classification }
        : {}),
      ...(typeof record.acceptedProviderIdentity === "boolean"
        ? { acceptedProviderIdentity: record.acceptedProviderIdentity }
        : {}),
    };
  }
  return { code: "VIDEO_GENERATION_FAILED" };
}

function waitResult(
  operation: ContentOperationRecord,
  command: GenerateManagedStyle1VideoCommand,
): GenerateManagedStyle1VideoResult {
  return {
    operationId: operation.id,
    operationStatus: "running",
    contentRunId: command.contentRunId,
    slot: command.slot,
    ...(operation.providerJobId ? { providerJobId: operation.providerJobId } : {}),
    requiredNextAction: { type: "WAIT_FOR_OPERATION", operationId: operation.id },
  };
}

function parseSucceededAssetId(operation: ContentOperationRecord): string {
  try {
    const result = operation.resultJson ? JSON.parse(operation.resultJson) : null;
    const assetId = nonEmptyString(asRecord(result)?.assetId);
    if (assetId) return assetId;
  } catch {
    // Fall through to the typed terminal consistency error.
  }
  throw new ManagedVideoGenerationError(
    "COMPLETED_OPERATION_ASSET_MISSING",
    "Completed video operation has no persisted asset identity",
    { operationId: operation.id },
  );
}

async function returnSucceededResult(
  prisma: PrismaClient,
  actor: ServiceActorContext,
  command: GenerateManagedStyle1VideoCommand,
  operation: ContentOperationRecord,
): Promise<GenerateManagedStyle1VideoResult> {
  const assetId = parseSucceededAssetId(operation);
  const asset = await prisma.flowGeneratedVideo.findFirst({
    where: {
      id: assetId,
      contentRunId: command.contentRunId,
      product: { batch: { workspaceId: actor.workspaceId } },
    },
  });
  if (!asset || !operation.providerJobId) {
    throw new ManagedVideoGenerationError(
      "COMPLETED_OPERATION_ASSET_MISSING",
      "Completed video operation does not resolve to a workspace-owned asset",
      { operationId: operation.id },
    );
  }
  return {
    operationId: operation.id,
    operationStatus: "succeeded",
    contentRunId: command.contentRunId,
    slot: command.slot,
    providerJobId: operation.providerJobId,
    asset,
    requiredNextAction: { type: "RUN_QA", slot: command.slot, assetId: asset.id },
  };
}

async function markRunFailed(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.contentRun.updateMany({
    where: { id: runId, status: { in: ["generating", "qa_running"] } },
    data: { status: "failed" },
  });
}

async function resolveAdapter(
  prisma: PrismaClient,
  workspaceId: string,
  actor: ServiceActorContext,
  createAdapter: (context: ApexFlowBoundContext) => ApexFlowAdapter,
): Promise<ApexFlowAdapter> {
  const settings = await prisma.workspaceSettings.findUnique({
    where: { workspaceId },
    select: { flowEmail: true },
  });
  const flowEmail = settings?.flowEmail?.trim();
  if (!flowEmail) {
    throw new ManagedVideoGenerationError(
      "FLOW_ACCOUNT_REQUIRED",
      "Workspace requires a connected Flow account",
    );
  }
  return createAdapter({ actor, flowEmail });
}

type PreIdentityLockState = "none" | "live" | "accepted" | "recovered";

async function reconcileExpiredPreIdentityLock(
  prisma: PrismaClient,
  workspaceId: string,
  operationId: string,
): Promise<PreIdentityLockState> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const lock = await tx.workspaceProviderLock.findFirst({
      where: { workspaceId, operationId },
      include: {
        operation: {
          select: { status: true, providerJobId: true },
        },
      },
    });
    if (!lock) {
      return "none";
    }
    if (lock.expiresAt.getTime() >= now.getTime()) {
      return "live";
    }
    if (lock.operation.providerJobId) {
      return "accepted";
    }

    const failed = await tx.contentOperation.updateMany({
      where: {
        id: operationId,
        workspaceId,
        status: { in: ["requested", "running"] },
        providerJobId: null,
      },
      data: {
        status: "failed",
        completedAt: now,
        errorJson: JSON.stringify({
          code: "EXPIRED_PROVIDER_LOCK_RECOVERED",
          recoveredAt: now.toISOString(),
          recoveredByOperationId: operationId,
        }),
      },
    });
    if (failed.count !== 1) {
      return "accepted";
    }

    const removed = await tx.workspaceProviderLock.deleteMany({
      where: {
        workspaceId,
        operationId,
        expiresAt: { lt: now },
      },
    });
    if (removed.count !== 1) {
      throw new ContentGenerationError(
        "WORKSPACE_PROVIDER_BUSY",
        "The expired provider lock changed during reconciliation",
        { operationId },
      );
    }
    return "recovered";
  });
}

async function operationOwnsLiveLock(
  prisma: PrismaClient,
  workspaceId: string,
  operationId: string,
): Promise<boolean> {
  const lock = await prisma.workspaceProviderLock.findFirst({
    where: {
      workspaceId,
      operationId,
      expiresAt: { gte: new Date() },
    },
    select: { operationId: true },
  });
  return Boolean(lock);
}

export async function generateManagedStyle1Video(
  actor: ServiceActorContext,
  rawCommand: GenerateManagedStyle1VideoCommand,
  dependencies: GenerateManagedStyle1VideoDependencies = {},
): Promise<GenerateManagedStyle1VideoResult> {
  const workspaceId = requireNonEmpty(actor.workspaceId, "workspaceId");
  const command: GenerateManagedStyle1VideoCommand = {
    contentRunId: requireNonEmpty(rawCommand.contentRunId, "contentRunId"),
    slot: rawCommand.slot,
    idempotencyKey: requireNonEmpty(rawCommand.idempotencyKey, "idempotencyKey"),
  };
  if (
    !(Object.keys(SLOT_DEFINITIONS) as string[]).includes(command.slot) ||
    SLOT_DEFINITIONS[command.slot].mediaType !== "video"
  ) {
    throw new ManagedVideoGenerationError(
      "INVALID_VIDEO_GENERATION_REQUEST",
      "slot must identify a managed Style 1 video slot",
      { slot: String(command.slot) },
    );
  }

  const prisma = dependencies.prisma ?? db;
  const operations =
    dependencies.operationRepository ?? createOperationRepository(prisma);
  const locks =
    dependencies.providerLockRepository ?? createProviderLockRepository(prisma);
  const createAdapter = dependencies.createAdapter ?? createApexFlowAdapter;

  const existing = await prisma.contentOperation.findUnique({
    where: {
      workspaceId_idempotencyKey: {
        workspaceId,
        idempotencyKey: command.idempotencyKey,
      },
    },
  });
  let resumedExisting: ContentOperationRecord | null = null;
  if (existing) {
    const resumed = await operations.createOrResume({
      workspaceId,
      contentRunId: command.contentRunId,
      kind: "video_generation",
      sceneLabel: SLOT_DEFINITIONS[command.slot].persistedSceneLabel,
      idempotencyKey: command.idempotencyKey,
    });
    resumedExisting = resumed;
    if (resumed.status === "succeeded") {
      return returnSucceededResult(prisma, actor, command, resumed);
    }
    if (resumed.status === "failed") {
      throw new ContentGenerationError(
        "OPERATION_TERMINAL",
        "The video generation operation has already failed",
        { operationId: resumed.id, status: resumed.status },
      );
    }
  } else {
    const reserved = await prisma.contentOperation.findFirst({
      where: {
        workspaceId,
        contentRunId: command.contentRunId,
        kind: "video_generation",
        sceneLabel: SLOT_DEFINITIONS[command.slot].persistedSceneLabel,
      },
      select: { id: true },
    });
    if (reserved) {
      throw new ContentGenerationError(
        "CREATIVE_ATTEMPT_EXHAUSTED",
        "This managed content slot already has its one creative attempt",
        { operationId: reserved.id, contentRunId: command.contentRunId },
      );
    }
  }

  const run = await loadScopedRun(prisma, workspaceId, command.contentRunId);
  if (resumedExisting && !resumedExisting.providerJobId) {
    const lockState = await reconcileExpiredPreIdentityLock(
      prisma,
      workspaceId,
      resumedExisting.id,
    );
    if (lockState === "live") {
      return waitResult(resumedExisting, command);
    }
    if (lockState === "recovered") {
      await markRunFailed(prisma, run.id);
      throw new ContentGenerationError(
        "OPERATION_TERMINAL",
        "The expired pre-identity video operation was reconciled without restarting",
        { operationId: resumedExisting.id, status: "failed" },
      );
    }
    if (lockState === "accepted") {
      const refreshed = await operations.findById({
        workspaceId,
        operationId: resumedExisting.id,
      });
      if (!refreshed?.providerJobId) {
        throw new ContentGenerationError(
          "WORKSPACE_PROVIDER_BUSY",
          "The video operation changed during expired-lock reconciliation",
          { operationId: resumedExisting.id },
        );
      }
      resumedExisting = refreshed;
    }
  }

  let sourceAssetId: string;
  if (resumedExisting?.providerJobId) {
    const definition = SLOT_DEFINITIONS[command.slot];
    const sourceLabel = SLOT_DEFINITIONS[definition.sourceSlot].persistedSceneLabel;
    const source = run.images
      .filter(
        (image) =>
          image.contentRunId === run.id &&
          image.sceneLabel === sourceLabel &&
          image.qaStatus === "APPROVED",
      )
      .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
    if (!source) {
      throw new ManagedVideoGenerationError(
        "SOURCE_IMAGE_NOT_APPROVED",
        "Accepted video operation has no approved same-run source image",
        { contentRunId: run.id, slot: command.slot },
      );
    }
    sourceAssetId = source.id;
  } else {
    sourceAssetId = assertSlotReady(run, command.slot);
  }
  const frozen = readFrozenVideoSlot(
    run.promptSnapshotJson,
    command.slot,
    run.productId,
    run.style,
  );
  const source = await loadApprovedSource(
    prisma,
    workspaceId,
    run,
    command.slot,
    sourceAssetId,
  );

  let operation = await operations.createOrResume({
    workspaceId,
    contentRunId: command.contentRunId,
    kind: "video_generation",
    sceneLabel: SLOT_DEFINITIONS[command.slot].persistedSceneLabel,
    idempotencyKey: command.idempotencyKey,
  });
  const scope = { workspaceId, operationId: operation.id };

  if (!operation.providerJobId) {
    if (await operationOwnsLiveLock(prisma, workspaceId, operation.id)) {
      return waitResult(operation, command);
    }
    try {
      await locks.acquire({
        ...scope,
        ttlMs: dependencies.lockTtlMs ?? MANAGED_VIDEO_LOCK_TTL_MS,
      });
    } catch (error) {
      const blockedByDifferentOperation =
        error instanceof ContentGenerationError &&
        error.code === "WORKSPACE_PROVIDER_BUSY" &&
        typeof error.details.operationId === "string" &&
        error.details.operationId !== operation.id;
      if (blockedByDifferentOperation) {
        const blockingOperationId = error.details.operationId as string;
        await prisma.$transaction(async (tx) => {
          const blockerStillOwnsLock = await tx.workspaceProviderLock.findFirst({
            where: { workspaceId, operationId: blockingOperationId },
            select: { operationId: true },
          });
          if (!blockerStillOwnsLock) return;
          await tx.contentOperation.deleteMany({
            where: {
              id: operation.id,
              workspaceId,
              status: "requested",
              providerJobId: null,
              technicalAttemptCount: 0,
              providerLock: null,
            },
          });
        });
      }
      throw error;
    }

    try {
      operation = await operations.markRunning(scope);
      const adapter = await resolveAdapter(
        prisma,
        workspaceId,
        actor,
        createAdapter,
      );
      const started = await executeWithTechnicalRetries({
        operation,
        onAttempt: async (attemptNumber) => {
          operation = await operations.recordTechnicalAttempt(scope, attemptNumber);
        },
        execute: () =>
          adapter.startVideo({
            prompt: frozen.prompt,
            model: frozen.model,
            sourceImageMediaGenerationId: source.mediaGenerationId,
            aspectRatio: frozen.aspectRatio,
            durationSeconds: frozen.durationSeconds,
          }),
      });
      operation = await operations.recordProviderJobId(scope, started.providerJobId);
      return waitResult(operation, command);
    } catch (error) {
      const current = await operations.findById(scope);
      if (current && current.status !== "succeeded" && current.status !== "failed") {
        await operations.fail(scope, safeOperationError(error));
      }
      await markRunFailed(prisma, run.id);
      await locks.release(scope);
      throw error;
    }
  }

  if (!(await operationOwnsLiveLock(prisma, workspaceId, operation.id))) {
    await locks.acquire({
      ...scope,
      ttlMs: dependencies.lockTtlMs ?? MANAGED_VIDEO_LOCK_TTL_MS,
    });
  }

  let terminal = false;
  let persistedForCompensation: PersistedGeneratedMedia | null = null;
  let storageForCompensation: ObjectStorage | null = null;
  try {
    const adapter = await resolveAdapter(prisma, workspaceId, actor, createAdapter);
    const polled: VideoPollResult = await adapter.pollVideo({
      providerJobId: operation.providerJobId,
    });
    if (polled.status === "running") {
      return waitResult(operation, command);
    }
    if (polled.status === "failed") {
      throw new ManagedVideoGenerationError(
        "PROVIDER_VIDEO_FAILED",
        "Provider video generation failed",
        { operationId: operation.id, providerJobId: operation.providerJobId },
      );
    }

    const objectStorage = dependencies.objectStorage ?? createObjectStorageFromEnv();
    storageForCompensation = objectStorage;
    const persisted = await (dependencies.persistMedia ?? persistGeneratedMedia)(
      {
        mediaType: "video",
        workspaceId,
        contentRunId: run.id,
        productId: run.productId,
        sceneLabel: SLOT_DEFINITIONS[command.slot].persistedSceneLabel,
        mediaGenerationId: polled.mediaGenerationId,
        providerUrl: polled.url,
        prompt: frozen.prompt,
        attemptNumber: 1,
        sourceImageId: source.id,
        imageMediaGenerationId: source.mediaGenerationId,
      },
      {
        objectStorage,
        db: prisma,
        ...(dependencies.fetchMedia ? { fetchMedia: dependencies.fetchMedia } : {}),
        ...(dependencies.createAssetId
          ? { createAssetId: dependencies.createAssetId }
          : {}),
      },
    );
    persistedForCompensation = persisted;
    const asset = persisted.asset as ManagedGeneratedVideoAsset;
    if (
      !asset?.id ||
      asset.contentRunId !== run.id ||
      asset.sourceImageId !== source.id ||
      asset.imageMediaGenerationId !== source.mediaGenerationId
    ) {
      throw new ManagedVideoGenerationError(
        "COMPLETED_OPERATION_ASSET_MISSING",
        "Video persistence did not return the expected managed asset lineage",
        { operationId: operation.id },
      );
    }

    const transitioned = await prisma.contentRun.updateMany({
      where: { id: run.id, status: "generating" },
      data: { status: "qa_running" },
    });
    if (transitioned.count !== 1) {
      throw new ManagedVideoGenerationError(
        "INVALID_CONTENT_RUN_STATE",
        "Content run could not transition to mandatory QA",
        { contentRunId: run.id },
      );
    }
    operation = await operations.succeed(scope, {
      assetId: asset.id,
      mediaGenerationId: polled.mediaGenerationId,
      providerJobId: operation.providerJobId,
      storageKey: asset.storageKey,
    });
    terminal = true;
    return {
      operationId: operation.id,
      operationStatus: "succeeded",
      contentRunId: run.id,
      slot: command.slot,
      providerJobId: operation.providerJobId!,
      asset,
      requiredNextAction: { type: "RUN_QA", slot: command.slot, assetId: asset.id },
    };
  } catch (error) {
    if (isResumableAcceptedPollError(error)) {
      throw error;
    }
    let operationSucceeded = false;
    const current = await operations.findById(scope);
    operationSucceeded = current?.status === "succeeded";
    if (current && current.status !== "succeeded" && current.status !== "failed") {
      await operations.fail(scope, safeOperationError(error));
    }
    if (!operationSucceeded && persistedForCompensation) {
      const persistedAsset = persistedForCompensation.asset as
        | ManagedGeneratedVideoAsset
        | undefined;
      if (persistedAsset?.id) {
        try {
          await prisma.flowGeneratedVideo.deleteMany({
            where: { id: persistedAsset.id, contentRunId: run.id },
          });
        } catch {
          // Preserve the orchestration failure for reconciliation.
        }
      }
      if (storageForCompensation) {
        try {
          await storageForCompensation.delete(persistedForCompensation.storage.key);
        } catch {
          // Best-effort object compensation.
        }
      }
    }
    if (!operationSucceeded) await markRunFailed(prisma, run.id);
    terminal = true;
    throw error;
  } finally {
    if (terminal) await locks.release(scope);
  }
}
