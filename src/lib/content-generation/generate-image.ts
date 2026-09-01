import type { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";

import { db } from "@/lib/db";
import { SLOT_DEFINITIONS } from "@/lib/content-runs/constants";
import { projectContentRun } from "@/lib/content-runs/project-run";
import type {
  ImageSlot,
  ManagedManifestSlot,
  ServiceActorContext,
} from "@/lib/content-runs/types";
import {
  createObjectStorageFromEnv,
  type ObjectStorage,
} from "@/lib/storage";
import {
  createApexFlowAdapter,
  type ApexFlowAdapter,
  type ApexFlowBoundContext,
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
import {
  ContentGenerationError,
  type ContentOperationRecord,
} from "./types";

export const MANAGED_IMAGE_LOCK_TTL_MS = 5 * 60 * 1_000;

export interface GenerateManagedImageCommand {
  contentRunId: string;
  slot: ImageSlot | ManagedManifestSlot;
  idempotencyKey: string;
}

export interface ManagedGeneratedImageAsset {
  id: string;
  contentRunId: string | null;
  sceneLabel: string;
  mediaGenerationId: string;
  prompt: string | null;
  attemptNumber: number;
  qaStatus: string;
  storageBucket: string | null;
  storageKey: string | null;
  storageContentType: string | null;
  storageBytes: number | null;
  storageSha256: string | null;
}

export interface GenerateManagedImageResult {
  operationId: string;
  contentRunId: string;
  slot: ImageSlot | ManagedManifestSlot;
  asset: ManagedGeneratedImageAsset;
  requiredNextAction: {
    type: "RUN_QA";
    slot: ImageSlot | ManagedManifestSlot;
    assetId: string;
  };
}

type PersistMedia = typeof persistGeneratedMedia;

export interface GenerateManagedImageDependencies {
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

export type GenerateManagedStyle1ImageCommand = Omit<
  GenerateManagedImageCommand,
  "slot"
> & { slot: ImageSlot };
export type GenerateManagedStyle1ImageResult = GenerateManagedImageResult;
export type GenerateManagedStyle1ImageDependencies = GenerateManagedImageDependencies;

export type ManagedImageGenerationErrorCode =
  | "INVALID_IMAGE_GENERATION_REQUEST"
  | "CONTENT_RUN_NOT_FOUND"
  | "INVALID_CONTENT_RUN_STATE"
  | "IMAGE_SLOT_NOT_READY"
  | "INVALID_FROZEN_SNAPSHOT"
  | "FLOW_ACCOUNT_REQUIRED"
  | "COMPLETED_OPERATION_ASSET_MISSING";

export class ManagedImageGenerationError extends Error {
  readonly name = "ManagedImageGenerationError";

  constructor(
    readonly code: ManagedImageGenerationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface FrozenImageSlot {
  prompt: string;
  model: string;
  aspectRatio: string;
  productReferenceImageIds: string[];
  characterReferenceIds: string[];
  references: FrozenProductReference[];
}

interface FrozenProductReference {
  id: string;
  url: string | null;
  pathLocal: string | null;
  bytes: number | null;
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
    throw new ManagedImageGenerationError(
      "INVALID_IMAGE_GENERATION_REQUEST",
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

function readFrozenImageSlot(
  snapshotJson: string | null,
  slot: ImageSlot | ManagedManifestSlot,
  expectedProductId: string,
  persistedStyle: string,
): FrozenImageSlot {
  let snapshot: Record<string, unknown>;
  try {
    const parsed = snapshotJson ? JSON.parse(snapshotJson) : null;
    const record = asRecord(parsed);
    if (!record) throw new Error("snapshot must be an object");
    snapshot = record;
  } catch (cause) {
    throw new ManagedImageGenerationError(
      "INVALID_FROZEN_SNAPSHOT",
      "Content run has no valid frozen generation snapshot",
      {},
      { cause },
    );
  }

  const snapshotProduct = asRecord(snapshot.product);
  const expectedObjective = `create_${persistedStyle}_piece`;
  const expectedVersion =
    persistedStyle === "style1" ? "managed-style1-v1" : "managed-style2-v1";
  if (
    (persistedStyle !== "style1" && persistedStyle !== "style2") ||
    snapshot.style !== persistedStyle ||
    snapshot.objective !== expectedObjective ||
    snapshot.specVersion !== expectedVersion ||
    snapshotProduct?.id !== expectedProductId
  ) {
    throw new ManagedImageGenerationError(
      "INVALID_FROZEN_SNAPSHOT",
      "Content run is not an approved managed style objective",
      { slot },
    );
  }

  const models = asRecord(snapshot.modelSnapshot);
  const model = nonEmptyString(models?.imageModel);
  const slots = Array.isArray(snapshot.slots) ? snapshot.slots : [];
  const slotRecord = slots
    .map(asRecord)
    .find((candidate) => candidate?.slot === slot);
  const generation = asRecord(slotRecord?.generation);
  const prompt = nonEmptyString(slotRecord?.prompt);
  const aspectRatio = nonEmptyString(generation?.aspectRatio);
  const rawReferenceIds = Array.isArray(generation?.referenceAttachmentIds)
    ? generation.referenceAttachmentIds
    : Array.isArray(generation?.productReferenceImageIds)
      ? generation.productReferenceImageIds
      : [];
  const references = rawReferenceIds.map(nonEmptyString);
  const characterReferences = Array.isArray(generation?.characterReferenceIds)
    ? generation.characterReferenceIds.map(nonEmptyString)
    : [];
  const product = asRecord(snapshot.product);
  const productReferences = Array.isArray(product?.references)
    ? product.references.map(asRecord)
    : [];

  if (
    slotRecord?.mediaType !== "image" ||
    !model ||
    !prompt ||
    !aspectRatio ||
    references.some((reference) => !reference) ||
    characterReferences.some((reference) => !reference) ||
    (persistedStyle === "style1" && references.length === 0)
  ) {
    throw new ManagedImageGenerationError(
      "INVALID_FROZEN_SNAPSHOT",
      "Frozen snapshot is missing the requested image slot inputs",
      { slot },
    );
  }

  return {
    prompt,
    model,
    aspectRatio,
    productReferenceImageIds: references as string[],
    characterReferenceIds: characterReferences as string[],
    references: (references as string[]).map((id) => {
      const reference = productReferences.find((candidate) => candidate?.id === id);
      return {
        id,
        url: nonEmptyString(reference?.url),
        pathLocal: nonEmptyString(reference?.pathLocal),
        bytes: typeof reference?.bytes === "number" ? reference.bytes : null,
      };
    }),
  };
}

function sniffImageMimeType(bytes: Uint8Array, hintPath?: string | null): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  const ext = hintPath ? extname(hintPath).toLowerCase() : "";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function resolveLocalReferencePath(pathValue: string): string {
  if (isAbsolute(pathValue)) return pathValue;
  return resolve(process.cwd(), pathValue.replace(/^\/+/, ""));
}

async function readFrozenReferenceBytes(
  reference: FrozenProductReference,
  fetchMedia?: PersistGeneratedMediaDependencies["fetchMedia"],
): Promise<{ bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
  if (reference.pathLocal) {
    const bytes = await readFile(resolveLocalReferencePath(reference.pathLocal));
    return { bytes, mimeType: sniffImageMimeType(bytes, reference.pathLocal) };
  }
  if (reference.url) {
    if (/^https?:\/\//i.test(reference.url)) {
      const response = await (fetchMedia ?? fetch)(reference.url);
      if (!response.ok) {
        throw new ManagedImageGenerationError(
          "INVALID_FROZEN_SNAPSHOT",
          "Frozen product reference image URL could not be fetched",
          { referenceId: reference.id },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headerMime = response.headers.get("content-type")?.split(";")[0]?.trim();
      const mimeType =
        headerMime === "image/png" ||
        headerMime === "image/jpeg" ||
        headerMime === "image/webp"
          ? headerMime
          : sniffImageMimeType(bytes, reference.url);
      return { bytes, mimeType };
    }
    const localPath = resolve(process.cwd(), "public", reference.url.replace(/^\/+/, ""));
    const bytes = await readFile(localPath);
    return { bytes, mimeType: sniffImageMimeType(bytes, reference.url) };
  }
  throw new ManagedImageGenerationError(
    "INVALID_FROZEN_SNAPSHOT",
    "Frozen product reference image is missing SaaS source bytes location",
    { referenceId: reference.id },
  );
}

async function uploadFrozenProductReferences(
  adapter: ApexFlowAdapter,
  references: FrozenProductReference[],
  fetchMedia?: PersistGeneratedMediaDependencies["fetchMedia"],
): Promise<string[]> {
  const uploaded: string[] = [];
  for (const reference of references) {
    const { bytes, mimeType } = await readFrozenReferenceBytes(reference, fetchMedia);
    if (reference.bytes !== null && reference.bytes !== bytes.byteLength) {
      throw new ManagedImageGenerationError(
        "INVALID_FROZEN_SNAPSHOT",
        "Frozen product reference image byte length changed before Flow upload",
        { referenceId: reference.id },
      );
    }
    const result = await adapter.uploadAsset({
      base64Data: Buffer.from(bytes).toString("base64"),
      mimeType,
      expectedKind: "image",
      expectedSizeBytes: bytes.byteLength,
    });
    uploaded.push(result.mediaGenerationId);
  }
  return uploaded;
}

async function loadScopedRun(
  prisma: PrismaClient,
  workspaceId: string,
  contentRunId: string,
): Promise<LoadedRun> {
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
    throw new ManagedImageGenerationError(
      "CONTENT_RUN_NOT_FOUND",
      "Content run was not found in the authenticated workspace",
      { contentRunId },
    );
  }
  return run;
}

function assertSlotReady(
  run: LoadedRun,
  slot: ImageSlot | ManagedManifestSlot,
): void {
  if (run.status !== "created" && run.status !== "generating") {
    throw new ManagedImageGenerationError(
      "INVALID_CONTENT_RUN_STATE",
      "Content run is not eligible for image generation",
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
  if (action.type !== "GENERATE_IMAGE" || action.slot !== slot) {
    throw new ManagedImageGenerationError(
      "IMAGE_SLOT_NOT_READY",
      "Requested image slot is not the SaaS-derived next action",
      { contentRunId: run.id, slot, requiredNextAction: action.type },
    );
  }
}

function safeOperationError(error: unknown): Record<string, unknown> {
  if (error instanceof ManagedImageGenerationError || error instanceof ContentGenerationError) {
    return { code: error.code, details: error.details };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      code: nonEmptyString(record.code) ?? "IMAGE_GENERATION_FAILED",
      ...(nonEmptyString(record.stage) ? { stage: record.stage } : {}),
      ...(typeof record.classification === "string"
        ? { classification: record.classification }
        : {}),
      ...(typeof record.acceptedProviderIdentity === "boolean"
        ? { acceptedProviderIdentity: record.acceptedProviderIdentity }
        : {}),
    };
  }
  return { code: "IMAGE_GENERATION_FAILED" };
}

function parseSucceededAssetId(operation: ContentOperationRecord): string {
  try {
    const result = operation.resultJson ? JSON.parse(operation.resultJson) : null;
    const assetId = nonEmptyString(asRecord(result)?.assetId);
    if (assetId) return assetId;
  } catch {
    // Fall through to the typed terminal consistency error.
  }
  throw new ManagedImageGenerationError(
    "COMPLETED_OPERATION_ASSET_MISSING",
    "Completed image operation has no persisted asset identity",
    { operationId: operation.id },
  );
}

async function returnSucceededResult(
  prisma: PrismaClient,
  actor: ServiceActorContext,
  command: GenerateManagedImageCommand,
  operation: ContentOperationRecord,
): Promise<GenerateManagedImageResult> {
  const assetId = parseSucceededAssetId(operation);
  const asset = await prisma.flowGeneratedImage.findFirst({
    where: {
      id: assetId,
      contentRunId: command.contentRunId,
      product: { batch: { workspaceId: actor.workspaceId } },
    },
  });
  if (!asset) {
    throw new ManagedImageGenerationError(
      "COMPLETED_OPERATION_ASSET_MISSING",
      "Completed image operation does not resolve to a workspace-owned asset",
      { operationId: operation.id },
    );
  }
  return {
    operationId: operation.id,
    contentRunId: command.contentRunId,
    slot: command.slot,
    asset,
    requiredNextAction: {
      type: "RUN_QA",
      slot: command.slot,
      assetId: asset.id,
    },
  };
}

async function markRunFailed(prisma: PrismaClient, runId: string): Promise<void> {
  await prisma.contentRun.updateMany({
    where: { id: runId, status: { in: ["generating", "qa_running"] } },
    data: { status: "failed" },
  });
}

/**
 * Execute one managed manifest image slot. The caller supplies only objective
 * identity; prompt, model, references and Flow account binding are loaded from
 * persisted SaaS state.
 */
export async function generateManagedImage(
  actor: ServiceActorContext,
  rawCommand: GenerateManagedImageCommand,
  dependencies: GenerateManagedImageDependencies = {},
): Promise<GenerateManagedImageResult> {
  const workspaceId = requireNonEmpty(actor.workspaceId, "workspaceId");
  const command: GenerateManagedImageCommand = {
    contentRunId: requireNonEmpty(rawCommand.contentRunId, "contentRunId"),
    slot: rawCommand.slot,
    idempotencyKey: requireNonEmpty(rawCommand.idempotencyKey, "idempotencyKey"),
  };
  const legacyDefinition = SLOT_DEFINITIONS[command.slot as ImageSlot];
  if (legacyDefinition?.mediaType !== "image" && !/^N[1-7]$/.test(command.slot)) {
    throw new ManagedImageGenerationError(
      "INVALID_IMAGE_GENERATION_REQUEST",
      "slot must identify a managed manifest image slot",
      { slot: String(command.slot) },
    );
  }

  const prisma = dependencies.prisma ?? db;
  const operations =
    dependencies.operationRepository ?? createOperationRepository(prisma);
  const locks =
    dependencies.providerLockRepository ?? createProviderLockRepository(prisma);

  const existing = await prisma.contentOperation.findUnique({
    where: {
      workspaceId_idempotencyKey: {
        workspaceId,
        idempotencyKey: command.idempotencyKey,
      },
    },
  });
  if (existing) {
    const resumed = await operations.createOrResume({
      workspaceId,
      contentRunId: command.contentRunId,
      kind: "image_generation",
      sceneLabel: command.slot,
      idempotencyKey: command.idempotencyKey,
    });
    if (resumed.status === "succeeded") {
      return returnSucceededResult(prisma, actor, command, resumed);
    }
    if (resumed.status === "failed") {
      throw new ContentGenerationError(
        "OPERATION_TERMINAL",
        "The image generation operation has already failed",
        { operationId: resumed.id, status: resumed.status },
      );
    }
  } else {
    // Preserve the one-attempt domain error even after successful persistence has
    // advanced the run to QA. The repository repeats this check transactionally
    // to fence a concurrent reservation race.
    const reserved = await prisma.contentOperation.findFirst({
      where: {
        workspaceId,
        contentRunId: command.contentRunId,
        kind: "image_generation",
        sceneLabel: command.slot,
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
  assertSlotReady(run, command.slot);
  const frozen = readFrozenImageSlot(
    run.promptSnapshotJson,
    command.slot,
    run.productId,
    run.style,
  );

  const operation = await operations.createOrResume({
    workspaceId,
    contentRunId: command.contentRunId,
    kind: "image_generation",
    sceneLabel: command.slot,
    idempotencyKey: command.idempotencyKey,
  });
  if (operation.status === "succeeded") {
    return returnSucceededResult(prisma, actor, command, operation);
  }
  if (operation.status === "failed") {
    throw new ContentGenerationError(
      "OPERATION_TERMINAL",
      "The image generation operation has already failed",
      { operationId: operation.id, status: operation.status },
    );
  }

  const scope = { workspaceId, operationId: operation.id };
  try {
    await locks.acquire({
      ...scope,
      ttlMs: dependencies.lockTtlMs ?? MANAGED_IMAGE_LOCK_TTL_MS,
    });
  } catch (error) {
    // A command blocked by a *different* active operation never reached the
    // provider. Remove its untouched reservation so it can retry later. When
    // the active lock belongs to this same operation, another same-key caller
    // won the race; never delete the shared operation out from under it.
    const blockedByDifferentOperation =
      error instanceof ContentGenerationError &&
      error.code === "WORKSPACE_PROVIDER_BUSY" &&
      typeof error.details.operationId === "string" &&
      error.details.operationId !== operation.id;
    if (blockedByDifferentOperation) {
      const blockingOperationId = error.details.operationId as string;
      await prisma.$transaction(async (tx) => {
        // Re-check ownership in the same transaction as deletion. If the blocker
        // released or the lock handed off, preserve our shared reservation.
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
    let persistedForCompensation: PersistedGeneratedMedia | null = null;
    let storageForCompensation: ObjectStorage | null = null;
    try {
      let running = await operations.markRunning(scope);
        if (run.status === "created") {
          const transitioned = await prisma.contentRun.updateMany({
            where: { id: run.id, status: "created" },
            data: { status: "generating" },
          });
          if (transitioned.count !== 1) {
            throw new ManagedImageGenerationError(
              "INVALID_CONTENT_RUN_STATE",
              "Content run state changed before image generation started",
              { contentRunId: run.id },
            );
          }
        }

        const settings = await prisma.workspaceSettings.findUnique({
          where: { workspaceId },
          select: { flowEmail: true },
        });
        const flowEmail = settings?.flowEmail?.trim();
        if (!flowEmail) {
          throw new ManagedImageGenerationError(
            "FLOW_ACCOUNT_REQUIRED",
            "Workspace requires a connected Flow account",
          );
        }
        const adapter = (dependencies.createAdapter ?? createApexFlowAdapter)({
          actor,
          flowEmail,
        });
        const uploadedReferenceMediaIds = await uploadFrozenProductReferences(
          adapter,
          frozen.references,
          dependencies.fetchMedia,
        );
        const generated = await executeWithTechnicalRetries({
          operation: running,
          onAttempt: async (attemptNumber) => {
            running = await operations.recordTechnicalAttempt(scope, attemptNumber);
          },
          execute: () =>
            adapter.generateImage({
              prompt: frozen.prompt,
              model: frozen.model,
              aspectRatio: frozen.aspectRatio,
              referenceMediaIds: uploadedReferenceMediaIds,
              ...(frozen.characterReferenceIds.length
                ? { characterReferenceIds: frozen.characterReferenceIds }
                : {}),
            }),
        });

        const objectStorage =
          dependencies.objectStorage ?? createObjectStorageFromEnv();
        storageForCompensation = objectStorage;
        const persisted: PersistedGeneratedMedia = await (
          dependencies.persistMedia ?? persistGeneratedMedia
        )(
          {
            mediaType: "image",
            workspaceId,
            contentRunId: run.id,
            productId: run.productId,
            sceneLabel: command.slot,
            mediaGenerationId: generated.mediaGenerationId,
            providerUrl: generated.url,
            prompt: frozen.prompt,
            attemptNumber: 1,
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
        const asset = persisted.asset as ManagedGeneratedImageAsset;
        if (!asset?.id || asset.contentRunId !== run.id) {
          throw new ManagedImageGenerationError(
            "COMPLETED_OPERATION_ASSET_MISSING",
            "Image persistence did not return the expected managed asset",
            { operationId: operation.id },
          );
        }

        const transitioned = await prisma.contentRun.updateMany({
          where: { id: run.id, status: "generating" },
          data: { status: "qa_running" },
        });
        if (transitioned.count !== 1) {
          throw new ManagedImageGenerationError(
            "INVALID_CONTENT_RUN_STATE",
            "Content run could not transition to mandatory QA",
            { contentRunId: run.id },
          );
        }
        await operations.succeed(scope, {
          assetId: asset.id,
          mediaGenerationId: generated.mediaGenerationId,
          storageKey: asset.storageKey,
        });

        return {
          operationId: operation.id,
          contentRunId: run.id,
          slot: command.slot,
          asset,
          requiredNextAction: {
            type: "RUN_QA",
            slot: command.slot,
            assetId: asset.id,
          },
        };
    } catch (error) {
      let operationSucceeded = false;
      try {
        const current = await operations.findById(scope);
        operationSucceeded = current?.status === "succeeded";
        if (current && current.status !== "succeeded" && current.status !== "failed") {
          await operations.fail(scope, safeOperationError(error));
        }
        if (!operationSucceeded && persistedForCompensation) {
          const persistedAsset = persistedForCompensation.asset as
            | ManagedGeneratedImageAsset
            | undefined;
          if (persistedAsset?.id) {
            try {
              await prisma.flowGeneratedImage.deleteMany({
                where: { id: persistedAsset.id, contentRunId: run.id },
              });
            } catch {
              // Preserve the original orchestration failure; the failed operation
              // remains the durable audit record for reconciliation.
            }
          }
          if (storageForCompensation) {
            try {
              await storageForCompensation.delete(
                persistedForCompensation.storage.key,
              );
            } catch {
              // Best-effort object compensation mirrors persist-media semantics.
            }
          }
        }
      } finally {
        if (!operationSucceeded) {
          await markRunFailed(prisma, run.id);
        }
      }
      throw error;
    }
  } finally {
    await locks.release(scope);
  }
}

/** Backward-compatible Style 1 wrapper over the shared managed engine. */
export function generateManagedStyle1Image(
  actor: ServiceActorContext,
  command: GenerateManagedStyle1ImageCommand,
  dependencies: GenerateManagedStyle1ImageDependencies = {},
): Promise<GenerateManagedStyle1ImageResult> {
  return generateManagedImage(actor, command, dependencies);
}
