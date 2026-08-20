import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStorage, PutManagedObjectInput } from "@/lib/storage";
import type { ApexFlowAdapter } from "../apex-flow-adapter";
import { generateManagedStyle1Video } from "../generate-video";

const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
const databasePath = resolve(tmpdir(), `generate-video-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

let workspaceId: string;
let contentRunId: string;
let productId: string;
let sourceImageId: string;

function frozenSnapshot() {
  return {
    objective: "create_style1_piece",
    style: "style1",
    specVersion: "managed-style1-v1",
    product: { id: productId },
    modelSnapshot: {
      imageModel: "nano-banana-pro",
      videoModel: "veo-3.1-lite",
    },
    slots: [
      {
        slot: "scene_1_store_image",
        mediaType: "image",
        prompt: "frozen store image prompt",
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: ["primary"],
          startImageSlot: null,
        },
      },
      {
        slot: "scene_1_store_video",
        mediaType: "video",
        prompt: "frozen store video prompt",
        generation: {
          aspectRatio: "portrait",
          durationSeconds: 8,
          productReferenceImageIds: [],
          startImageSlot: "scene_1_store_image",
        },
      },
      {
        slot: "scene_2_home_image",
        mediaType: "image",
        prompt: "frozen home image prompt",
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: ["primary"],
          startImageSlot: null,
        },
      },
      {
        slot: "scene_2_home_video",
        mediaType: "video",
        prompt: "frozen home video prompt",
        generation: {
          aspectRatio: "portrait",
          durationSeconds: 8,
          productReferenceImageIds: [],
          startImageSlot: "scene_2_home_image",
        },
      },
    ],
  };
}

function createAdapter() {
  return {
    generateImage: vi.fn(),
    startVideo: vi.fn(async () => ({ providerJobId: "provider-job-1" })),
    pollVideo: vi.fn(async () => ({
      status: "running" as const,
      providerJobId: "provider-job-1",
    })),
    resolveAssetUrl: vi.fn(),
  } as unknown as ApexFlowAdapter;
}

function createStorage() {
  return {
    bucket: "managed",
    put: vi.fn(async (input: PutManagedObjectInput) => ({
      bucket: "managed",
      key: `managed-content/${input.workspaceId}/${input.contentRunId}/videos/${input.assetId}.mp4`,
      contentType: input.contentType,
      bytes: input.body.byteLength,
      sha256: createHash("sha256").update(input.body).digest("hex"),
    })),
    get: vi.fn(),
    delete: vi.fn(),
    createSignedReadUrl: vi.fn(),
  } as unknown as ObjectStorage;
}

beforeAll(() => {
  const prismaCli = fileURLToPath(import.meta.resolve("prisma/build/index.js"));
  execFileSync(
    process.execPath,
    [prismaCli, "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    },
  );
});

beforeEach(async () => {
  await prisma.workspaceProviderLock.deleteMany();
  await prisma.contentOperation.deleteMany();
  await prisma.flowGeneratedVideo.deleteMany();
  await prisma.flowGeneratedImage.deleteMany();
  await prisma.contentRun.deleteMany();
  await prisma.productImage.deleteMany();
  await prisma.product.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.workspaceSettings.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test` },
  });
  const workspace = await prisma.workspace.create({
    data: { name: "workspace", ownerId: user.id },
  });
  const batch = await prisma.batch.create({
    data: { workspaceId: workspace.id, name: "batch", market: "uk" },
  });
  const product = await prisma.product.create({
    data: {
      batchId: batch.id,
      productName: "product",
      category: "tech",
      reviewStatus: "approved",
    },
  });
  await prisma.workspaceSettings.create({
    data: { workspaceId: workspace.id, flowEmail: "bound@example.test" },
  });
  productId = product.id;
  workspaceId = workspace.id;
  const run = await prisma.contentRun.create({
    data: {
      productId,
      style: "style1",
      market: "uk",
      status: "generating",
      idempotencyKey: randomUUID(),
      promptSnapshotJson: JSON.stringify(frozenSnapshot()),
    },
  });
  contentRunId = run.id;
  const source = await prisma.flowGeneratedImage.create({
    data: {
      productId,
      contentRunId,
      sceneLabel: "scene_1_store_image",
      mediaGenerationId: "flow-source-image-1",
      qaStatus: "APPROVED",
      attemptNumber: 1,
    },
  });
  sourceImageId = source.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

describe("generateManagedStyle1Video", () => {
  it("starts one async provider job from the approved same-run source and returns WAIT_FOR_OPERATION", async () => {
    const adapter = createAdapter();

    const result = await generateManagedStyle1Video(
      { workspaceId, actorType: "service", actorId: "hermes" },
      {
        contentRunId,
        slot: "scene_1_store_video",
        idempotencyKey: "scene-1-video",
      },
      {
        prisma,
        objectStorage: createStorage(),
        createAdapter: () => adapter,
        fetchMedia: vi.fn(async () =>
          new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
        ),
      },
    );

    expect(adapter.startVideo).toHaveBeenCalledExactlyOnceWith({
      prompt: "frozen store video prompt",
      model: "veo-3.1-lite",
      sourceImageMediaGenerationId: "flow-source-image-1",
      aspectRatio: "portrait",
      durationSeconds: 8,
    });
    expect(adapter.pollVideo).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      contentRunId,
      slot: "scene_1_store_video",
      operationStatus: "running",
      providerJobId: "provider-job-1",
      requiredNextAction: {
        type: "WAIT_FOR_OPERATION",
      },
    });
    await expect(
      prisma.contentOperation.findFirstOrThrow({ where: { contentRunId } }),
    ).resolves.toMatchObject({
      status: "running",
      providerJobId: "provider-job-1",
      technicalAttemptCount: 1,
    });
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(1);
    await expect(
      prisma.flowGeneratedImage.findUniqueOrThrow({ where: { id: sourceImageId } }),
    ).resolves.toMatchObject({ qaStatus: "APPROVED" });
  });

  it("returns WAIT for a live self-owned pre-identity lock without calling the provider", async () => {
    const operation = await prisma.contentOperation.create({
      data: {
        workspaceId,
        contentRunId,
        kind: "video_generation",
        sceneLabel: "scene_1_store",
        idempotencyKey: "live-pre-identity-lock",
      },
    });
    await prisma.workspaceProviderLock.create({
      data: {
        workspaceId,
        operationId: operation.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const adapter = createAdapter();

    const result = await generateManagedStyle1Video(
      { workspaceId, actorType: "service", actorId: "hermes" },
      {
        contentRunId,
        slot: "scene_1_store_video",
        idempotencyKey: "live-pre-identity-lock",
      },
      { prisma, objectStorage: createStorage(), createAdapter: () => adapter },
    );

    expect(result).toMatchObject({
      operationId: operation.id,
      operationStatus: "running",
      requiredNextAction: { type: "WAIT_FOR_OPERATION", operationId: operation.id },
    });
    expect(adapter.startVideo).not.toHaveBeenCalled();
    expect(adapter.pollVideo).not.toHaveBeenCalled();
  });

  it("reconciles an expired self-owned pre-identity lock without starting another job", async () => {
    const operation = await prisma.contentOperation.create({
      data: {
        workspaceId,
        contentRunId,
        kind: "video_generation",
        sceneLabel: "scene_1_store",
        idempotencyKey: "expired-pre-identity-lock",
      },
    });
    await prisma.workspaceProviderLock.create({
      data: {
        workspaceId,
        operationId: operation.id,
        acquiredAt: new Date(Date.now() - 2_000),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const adapter = createAdapter();

    await expect(
      generateManagedStyle1Video(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_video",
          idempotencyKey: "expired-pre-identity-lock",
        },
        { prisma, objectStorage: createStorage(), createAdapter: () => adapter },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_TERMINAL" });

    expect(adapter.startVideo).not.toHaveBeenCalled();
    expect(adapter.pollVideo).not.toHaveBeenCalled();
    await expect(
      prisma.contentOperation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).resolves.toMatchObject({
      status: "failed",
      providerJobId: null,
      errorJson: expect.stringContaining("EXPIRED_PROVIDER_LOCK_RECOVERED"),
    });
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
    await expect(
      prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } }),
    ).resolves.toMatchObject({ status: "failed" });
  });

  it("polls the accepted job on repeated same-key calls, persists completion, and replays the asset", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.pollVideo)
      .mockResolvedValueOnce({ status: "running", providerJobId: "provider-job-1" })
      .mockResolvedValueOnce({
        status: "completed",
        providerJobId: "provider-job-1",
        mediaGenerationId: "flow-video-1",
        url: "https://provider.example/video.mp4",
      });
    const storage = createStorage();
    const command = {
      contentRunId,
      slot: "scene_1_store_video" as const,
      idempotencyKey: "resume-video",
    };
    const dependencies = {
      prisma,
      objectStorage: storage,
      createAdapter: () => adapter,
      fetchMedia: vi.fn(async () =>
        new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
      ),
    };
    const actor = { workspaceId, actorType: "service" as const, actorId: "hermes" };

    const started = await generateManagedStyle1Video(actor, command, dependencies);
    const stillRunning = await generateManagedStyle1Video(actor, command, dependencies);
    const completed = await generateManagedStyle1Video(actor, command, dependencies);
    const replayed = await generateManagedStyle1Video(actor, command, dependencies);

    expect(started.operationStatus).toBe("running");
    expect(stillRunning.operationStatus).toBe("running");
    expect(adapter.startVideo).toHaveBeenCalledTimes(1);
    expect(adapter.pollVideo).toHaveBeenCalledTimes(2);
    expect(completed).toMatchObject({
      operationStatus: "succeeded",
      contentRunId,
      providerJobId: "provider-job-1",
      asset: {
        contentRunId,
        sceneLabel: "scene_1_store",
        mediaGenerationId: "flow-video-1",
        sourceImageId,
        imageMediaGenerationId: "flow-source-image-1",
        qaStatus: "NOT_QA_CHECKED",
        storageBucket: "managed",
        storageContentType: "video/mp4",
        storageBytes: MP4_BYTES.byteLength,
      },
      requiredNextAction: {
        type: "RUN_QA",
        slot: "scene_1_store_video",
      },
    });
    expect(replayed.operationId).toBe(completed.operationId);
    expect(replayed.operationStatus).toBe("succeeded");
    expect(adapter.startVideo).toHaveBeenCalledTimes(1);
    expect(adapter.pollVideo).toHaveBeenCalledTimes(2);
    await expect(prisma.flowGeneratedVideo.count({ where: { contentRunId } })).resolves.toBe(1);
    await expect(prisma.contentOperation.count({ where: { contentRunId } })).resolves.toBe(1);
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
    await expect(
      prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } }),
    ).resolves.toMatchObject({ status: "qa_running" });
  });

  it("preserves an accepted job after a transient poll error and resumes it to completion", async () => {
    const adapter = createAdapter();
    const transientPollError = Object.assign(new Error("poll transport timeout"), {
      classification: "technical-retryable",
      acceptedProviderIdentity: true,
      code: "transport_failure",
    });
    vi.mocked(adapter.pollVideo)
      .mockRejectedValueOnce(transientPollError)
      .mockResolvedValueOnce({
        status: "completed",
        providerJobId: "provider-job-1",
        mediaGenerationId: "flow-video-after-timeout",
        url: "https://provider.example/video-after-timeout.mp4",
      });
    const command = {
      contentRunId,
      slot: "scene_1_store_video" as const,
      idempotencyKey: "resume-after-transient-poll-error",
    };
    const dependencies = {
      prisma,
      objectStorage: createStorage(),
      createAdapter: () => adapter,
      fetchMedia: vi.fn(async () =>
        new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
      ),
    };
    const actor = { workspaceId, actorType: "service" as const, actorId: "hermes" };

    await generateManagedStyle1Video(actor, command, dependencies);
    await expect(generateManagedStyle1Video(actor, command, dependencies)).rejects.toBe(
      transientPollError,
    );
    await expect(
      prisma.contentOperation.findFirstOrThrow({ where: { contentRunId } }),
    ).resolves.toMatchObject({
      status: "running",
      providerJobId: "provider-job-1",
    });
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(1);

    const completed = await generateManagedStyle1Video(actor, command, dependencies);

    expect(completed).toMatchObject({
      operationStatus: "succeeded",
      providerJobId: "provider-job-1",
      asset: {
        contentRunId,
        mediaGenerationId: "flow-video-after-timeout",
        sourceImageId,
      },
      requiredNextAction: { type: "RUN_QA", slot: "scene_1_store_video" },
    });
    expect(adapter.startVideo).toHaveBeenCalledTimes(1);
    expect(adapter.pollVideo).toHaveBeenCalledTimes(2);
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
  });

  it("persists accepted source lineage at start and reuses it on resume", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.pollVideo).mockResolvedValue({
      status: "completed",
      providerJobId: "provider-job-1",
      mediaGenerationId: "flow-video-from-original-source",
      url: "https://provider.example/video-from-original.mp4",
    });
    const command = {
      contentRunId,
      slot: "scene_1_store_video" as const,
      idempotencyKey: "immutable-start-lineage",
    };
    const dependencies = {
      prisma,
      objectStorage: createStorage(),
      createAdapter: () => adapter,
      fetchMedia: vi.fn(async () =>
        new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
      ),
    };
    const actor = { workspaceId, actorType: "service" as const, actorId: "hermes" };

    await generateManagedStyle1Video(actor, command, dependencies);
    await prisma.flowGeneratedImage.update({
      where: { id: sourceImageId },
      data: { mediaGenerationId: "mutated-latest-source-media" },
    });

    const completed = await generateManagedStyle1Video(actor, command, dependencies);

    expect(completed).toMatchObject({
      operationStatus: "succeeded",
      asset: {
        sourceImageId,
        imageMediaGenerationId: "flow-source-image-1",
      },
    });
    expect(adapter.startVideo).toHaveBeenCalledExactlyOnceWith({
      prompt: "frozen store video prompt",
      model: "veo-3.1-lite",
      sourceImageMediaGenerationId: "flow-source-image-1",
      aspectRatio: "portrait",
      durationSeconds: 8,
    });
  });

  it.each([
    ["nonapproved", async () => {
      await prisma.flowGeneratedImage.update({
        where: { id: sourceImageId },
        data: { qaStatus: "NOT_QA_CHECKED" },
      });
    }],
    ["wrong-scene", async () => {
      await prisma.flowGeneratedImage.update({
        where: { id: sourceImageId },
        data: { sceneLabel: "scene_2_home_image" },
      });
    }],
    ["missing", async () => {
      await prisma.flowGeneratedImage.delete({ where: { id: sourceImageId } });
    }],
    ["cross-run", async () => {
      const other = await prisma.contentRun.create({
        data: {
          productId,
          style: "style1",
          market: "uk",
          status: "generating",
          idempotencyKey: randomUUID(),
          promptSnapshotJson: JSON.stringify(frozenSnapshot()),
        },
      });
      await prisma.flowGeneratedImage.update({
        where: { id: sourceImageId },
        data: { contentRunId: other.id },
      });
    }],
  ])("rejects a %s source image before any provider call", async (_case, mutate) => {
    await mutate();
    const adapter = createAdapter();

    await expect(
      generateManagedStyle1Video(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_video",
          idempotencyKey: `invalid-${_case}`,
        },
        { prisma, objectStorage: createStorage(), createAdapter: () => adapter },
      ),
    ).rejects.toMatchObject({ code: "VIDEO_SLOT_NOT_READY" });
    expect(adapter.startVideo).not.toHaveBeenCalled();
    expect(adapter.pollVideo).not.toHaveBeenCalled();
    await expect(prisma.contentOperation.count()).resolves.toBe(0);
  });

  it("records a failed provider job terminally and releases the lock", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.pollVideo).mockResolvedValue({
      status: "failed",
      providerJobId: "provider-job-1",
      reason: "content rejected",
    });
    const command = {
      contentRunId,
      slot: "scene_1_store_video" as const,
      idempotencyKey: "failed-video",
    };
    const dependencies = {
      prisma,
      objectStorage: createStorage(),
      createAdapter: () => adapter,
    };
    const actor = { workspaceId, actorType: "service" as const, actorId: "hermes" };

    await generateManagedStyle1Video(actor, command, dependencies);
    await expect(
      generateManagedStyle1Video(actor, command, dependencies),
    ).rejects.toMatchObject({ code: "PROVIDER_VIDEO_FAILED" });

    await expect(
      prisma.contentOperation.findFirstOrThrow({ where: { contentRunId } }),
    ).resolves.toMatchObject({ status: "failed", providerJobId: "provider-job-1" });
    await expect(
      prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
    expect(adapter.startVideo).toHaveBeenCalledTimes(1);
  });

  it("uses all safe technical start retries without duplicating an accepted job", async () => {
    const adapter = createAdapter();
    const retryable = () =>
      Object.assign(new Error("network timeout"), {
        classification: "technical-retryable",
        acceptedProviderIdentity: false,
        code: "transport_failure",
      });
    vi.mocked(adapter.startVideo)
      .mockRejectedValueOnce(retryable())
      .mockRejectedValueOnce(retryable())
      .mockResolvedValueOnce({ providerJobId: "provider-job-after-retries" });

    const result = await generateManagedStyle1Video(
      { workspaceId, actorType: "service", actorId: "hermes" },
      {
        contentRunId,
        slot: "scene_1_store_video",
        idempotencyKey: "technical-retries",
      },
      { prisma, objectStorage: createStorage(), createAdapter: () => adapter },
    );

    expect(result).toMatchObject({
      operationStatus: "running",
      providerJobId: "provider-job-after-retries",
    });
    expect(adapter.startVideo).toHaveBeenCalledTimes(3);
    await expect(
      prisma.contentOperation.findFirstOrThrow({ where: { contentRunId } }),
    ).resolves.toMatchObject({
      technicalAttemptCount: 3,
      providerJobId: "provider-job-after-retries",
      status: "running",
    });
  });

  it("never starts again when persisting an accepted provider identity fails", async () => {
    const adapter = createAdapter();
    const base = (await import("../operations")).createOperationRepository(prisma);
    const repository = {
      ...base,
      recordProviderJobId: vi.fn(async () => {
        throw Object.assign(new Error("database unavailable after accepted start"), {
          code: "PROVIDER_ID_PERSISTENCE_FAILED",
          acceptedProviderIdentity: true,
        });
      }),
    };
    const command = {
      contentRunId,
      slot: "scene_1_store_video" as const,
      idempotencyKey: "accepted-not-persisted",
    };
    const dependencies = {
      prisma,
      objectStorage: createStorage(),
      createAdapter: () => adapter,
      operationRepository: repository,
    };
    const actor = { workspaceId, actorType: "service" as const, actorId: "hermes" };

    await expect(generateManagedStyle1Video(actor, command, dependencies)).rejects.toThrow(
      "database unavailable after accepted start",
    );
    await expect(generateManagedStyle1Video(actor, command, dependencies)).rejects.toMatchObject({
      code: "OPERATION_TERMINAL",
    });
    expect(adapter.startVideo).toHaveBeenCalledTimes(1);
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
  });
});
