import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApexFlowAdapter } from "../apex-flow-adapter";
import { createOperationRepository } from "../operations";
import type { ObjectStorage, PutManagedObjectInput } from "@/lib/storage";
import { generateManagedStyle1Image } from "../generate-image";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const databasePath = resolve(tmpdir(), `generate-image-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

let workspaceId: string;
let contentRunId: string;
let productId: string;

function frozenSnapshot() {
  return {
    objective: "create_style1_piece",
    style: "style1",
    specVersion: "managed-style1-v1",
    product: {
      id: productId,
      primaryReferenceImageId: "frozen-primary",
      references: [
        {
          id: "frozen-primary",
          role: "primary",
          url: "https://saas.example/reference.png",
          bytes: PNG_BYTES.byteLength,
        },
      ],
    },
    modelSnapshot: {
      imageModel: "nano-banana-pro",
      videoModel: "veo-3.1-lite",
    },
    prompts: {
      scene_1_store_image: "frozen store prompt",
      scene_1_store_video: "frozen store video prompt",
      scene_2_home_image: "frozen home prompt",
      scene_2_home_video: "frozen home video prompt",
    },
    slots: [
      {
        slot: "scene_1_store_image",
        mediaType: "image",
        prompt: "frozen store prompt",
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: ["frozen-primary"],
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
        prompt: "frozen home prompt",
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: ["frozen-primary"],
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
    policy: { creativeAttemptsPerSlot: 1, qaRequired: true },
  };
}

function createAdapter() {
  return {
    uploadAsset: vi.fn(async () => ({
      mediaGenerationId: "flow-uploaded-frozen-primary",
      kind: "image" as const,
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
    })),
    generateImage: vi.fn(async () => ({
      mediaGenerationId: "flow-image-1",
      url: "https://provider.example/image.png",
    })),
    startVideo: vi.fn(),
    pollVideo: vi.fn(),
    resolveAssetUrl: vi.fn(),
  } as unknown as ApexFlowAdapter;
}

function createStorage() {
  return {
    bucket: "managed",
    put: vi.fn(async (input: PutManagedObjectInput) => ({
      bucket: "managed",
      key: `managed-content/${input.workspaceId}/${input.contentRunId}/images/${input.assetId}.png`,
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
      status: "created",
      idempotencyKey: randomUUID(),
      promptSnapshotJson: JSON.stringify(frozenSnapshot()),
    },
  });
  contentRunId = run.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

async function seedScene2Ready(): Promise<void> {
  await prisma.contentRun.update({
    where: { id: contentRunId },
    data: { status: "generating" },
  });
  await prisma.flowGeneratedImage.create({
    data: {
      productId,
      contentRunId,
      sceneLabel: "scene_1_store_image",
      mediaGenerationId: "scene-1-image",
      qaStatus: "APPROVED",
      attemptNumber: 1,
    },
  });
  await prisma.flowGeneratedVideo.create({
    data: {
      productId,
      contentRunId,
      sceneLabel: "scene_1_store",
      mediaGenerationId: "scene-1-video",
      qaStatus: "APPROVED",
      attemptNumber: 1,
    },
  });
}

async function expectTerminalFailure(): Promise<void> {
  await expect(
    prisma.contentOperation.findFirstOrThrow({ where: { contentRunId } }),
  ).resolves.toMatchObject({ status: "failed" });
  await expect(
    prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } }),
  ).resolves.toMatchObject({ status: "failed" });
  await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
}

describe("generateManagedStyle1Image", () => {
  it("generates scene 1 only from the frozen prompt, model, and references", async () => {
    const adapter = createAdapter();
    const storage = createStorage();

    const result = await generateManagedStyle1Image(
      { workspaceId, actorType: "service", actorId: "hermes" },
      {
        contentRunId,
        slot: "scene_1_store_image",
        idempotencyKey: "scene-1-image",
      },
      {
        prisma,
        objectStorage: storage,
        createAdapter: () => adapter,
        fetchMedia: vi.fn(async () =>
          new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
        ),
      },
    );

    expect(adapter.generateImage).toHaveBeenCalledWith({
      prompt: "frozen store prompt",
      model: "nano-banana-pro",
      aspectRatio: "9:16",
      referenceMediaIds: ["flow-uploaded-frozen-primary"],
    });
    expect(adapter.uploadAsset).toHaveBeenCalledExactlyOnceWith({
      base64Data: Buffer.from(PNG_BYTES).toString("base64"),
      mimeType: "image/png",
      expectedKind: "image",
      expectedSizeBytes: PNG_BYTES.byteLength,
    });
    expect(result).toMatchObject({
      contentRunId,
      slot: "scene_1_store_image",
      requiredNextAction: {
        type: "RUN_QA",
        slot: "scene_1_store_image",
      },
      asset: {
        contentRunId,
        sceneLabel: "scene_1_store_image",
        attemptNumber: 1,
        qaStatus: "NOT_QA_CHECKED",
        storageBucket: "managed",
        storageContentType: "image/png",
      },
    });
    await expect(
      prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } }),
    ).resolves.toMatchObject({ status: "qa_running" });
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
  });

  it("uses the frozen scene 2 inputs and ignores injected prompt/model/reference fields", async () => {
    await seedScene2Ready();
    const adapter = createAdapter();

    await generateManagedStyle1Image(
      { workspaceId, actorType: "service", actorId: "hermes" },
      {
        contentRunId,
        slot: "scene_2_home_image",
        idempotencyKey: "scene-2-image",
        prompt: "injected prompt",
        model: "injected model",
        referenceMediaIds: ["injected-reference"],
      } as never,
      {
        prisma,
        objectStorage: createStorage(),
        createAdapter: () => adapter,
        fetchMedia: vi.fn(async () =>
          new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
        ),
      },
    );

    expect(adapter.generateImage).toHaveBeenCalledWith({
      prompt: "frozen home prompt",
      model: "nano-banana-pro",
      aspectRatio: "9:16",
      referenceMediaIds: ["flow-uploaded-frozen-primary"],
    });
    await expect(
      prisma.flowGeneratedImage.findFirstOrThrow({
        where: { contentRunId, sceneLabel: "scene_2_home_image" },
      }),
    ).resolves.toMatchObject({
      prompt: "frozen home prompt",
      attemptNumber: 1,
      qaStatus: "NOT_QA_CHECKED",
    });
  });

  it("returns the original persisted asset for a completed idempotent replay", async () => {
    const adapter = createAdapter();
    const dependencies = {
      prisma,
      objectStorage: createStorage(),
      createAdapter: () => adapter,
      fetchMedia: vi.fn(async () =>
        new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
      ),
    };
    const command = {
      contentRunId,
      slot: "scene_1_store_image" as const,
      idempotencyKey: "idempotent-image",
    };

    const first = await generateManagedStyle1Image(
      { workspaceId, actorType: "service", actorId: "hermes" },
      command,
      dependencies,
    );
    const repeated = await generateManagedStyle1Image(
      { workspaceId, actorType: "service", actorId: "hermes" },
      command,
      dependencies,
    );

    expect(repeated.asset.id).toBe(first.asset.id);
    expect(repeated.operationId).toBe(first.operationId);
    expect(adapter.generateImage).toHaveBeenCalledTimes(1);
    await expect(prisma.flowGeneratedImage.count({ where: { contentRunId } })).resolves.toBe(1);
    await expect(prisma.contentOperation.count({ where: { contentRunId } })).resolves.toBe(1);
  });

  it("rejects a second creative attempt for the same image slot", async () => {
    const adapter = createAdapter();
    const common = {
      prisma,
      objectStorage: createStorage(),
      createAdapter: () => adapter,
      fetchMedia: vi.fn(async () =>
        new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
      ),
    };
    await generateManagedStyle1Image(
      { workspaceId, actorType: "service", actorId: "hermes" },
      {
        contentRunId,
        slot: "scene_1_store_image",
        idempotencyKey: "attempt-one",
      },
      common,
    );

    await expect(
      generateManagedStyle1Image(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_image",
          idempotencyKey: "attempt-two",
        },
        common,
      ),
    ).rejects.toMatchObject({ code: "CREATIVE_ATTEMPT_EXHAUSTED" });
    expect(adapter.generateImage).toHaveBeenCalledTimes(1);
  });

  it("rejects a content run from another workspace before provider work", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const other = await prisma.workspace.create({
      data: { name: "other", ownerId: user.id },
    });
    const adapter = createAdapter();

    await expect(
      generateManagedStyle1Image(
        { workspaceId: other.id, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_image",
          idempotencyKey: "cross-workspace",
        },
        {
          prisma,
          objectStorage: createStorage(),
          createAdapter: () => adapter,
        },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_NOT_FOUND" });
    expect(adapter.generateImage).not.toHaveBeenCalled();
    await expect(prisma.contentOperation.count()).resolves.toBe(0);
  });

  it("records provider failure terminally and releases the workspace lock", async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.generateImage).mockRejectedValue(
      Object.assign(new Error("provider rejected"), {
        classification: "terminal-nontechnical",
        acceptedProviderIdentity: false,
        code: "provider_failure",
      }),
    );

    await expect(
      generateManagedStyle1Image(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_image",
          idempotencyKey: "provider-failure",
        },
        {
          prisma,
          objectStorage: createStorage(),
          createAdapter: () => adapter,
          fetchMedia: vi.fn(async () =>
            new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
          ),
        },
      ),
    ).rejects.toThrow("provider rejected");
    expect(adapter.generateImage).toHaveBeenCalledTimes(1);
    await expectTerminalFailure();
  });

  it("records storage failure terminally and releases the workspace lock", async () => {
    const storage = createStorage();
    vi.mocked(storage.put).mockRejectedValue(new Error("storage unavailable"));

    await expect(
      generateManagedStyle1Image(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_image",
          idempotencyKey: "storage-failure",
        },
        {
          prisma,
          objectStorage: storage,
          createAdapter: () => createAdapter(),
          fetchMedia: vi.fn(async () =>
            new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
          ),
        },
      ),
    ).rejects.toMatchObject({ code: "OBJECT_UPLOAD_FAILED", stage: "storage" });
    await expect(prisma.flowGeneratedImage.count()).resolves.toBe(0);
    await expectTerminalFailure();
  });

  it("records DB asset persistence failure terminally and releases the workspace lock", async () => {
    const storage = createStorage();
    const persistMedia = vi.fn(async () => {
      await storage.put({
        workspaceId,
        contentRunId,
        assetId: "orphan",
        mediaType: "image",
        extension: "png",
        contentType: "image/png",
        body: PNG_BYTES,
      });
      await storage.delete(
        `managed-content/${workspaceId}/${contentRunId}/images/orphan.png`,
      );
      throw Object.assign(new Error("asset row failed"), {
        code: "DB_ASSET_PERSISTENCE_FAILED",
        stage: "database",
      });
    });

    await expect(
      generateManagedStyle1Image(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_image",
          idempotencyKey: "db-failure",
        },
        {
          prisma,
          objectStorage: storage,
          createAdapter: () => createAdapter(),
          persistMedia: persistMedia as never,
          fetchMedia: vi.fn(async () =>
            new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
          ),
        },
      ),
    ).rejects.toMatchObject({
      code: "DB_ASSET_PERSISTENCE_FAILED",
      stage: "database",
    });
    expect(storage.delete).toHaveBeenCalledTimes(1);
    await expect(prisma.flowGeneratedImage.count()).resolves.toBe(0);
    await expectTerminalFailure();
  });

  it("removes an unstarted reservation after lock contention so the same command can retry", async () => {
    const competingProduct = await prisma.product.create({
      data: {
        batchId: (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).batchId,
        productName: "competing product",
      },
    });
    const competingRun = await prisma.contentRun.create({
      data: {
        productId: competingProduct.id,
        style: "style1",
        market: "uk",
        idempotencyKey: "competing-run",
      },
    });
    const competingOperation = await prisma.contentOperation.create({
      data: {
        workspaceId,
        contentRunId: competingRun.id,
        kind: "image_generation",
        sceneLabel: "scene_1_store_image",
        idempotencyKey: "competing-operation",
        status: "running",
      },
    });
    await prisma.workspaceProviderLock.create({
      data: {
        workspaceId,
        operationId: competingOperation.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const adapter = createAdapter();
    const command = {
      contentRunId,
      slot: "scene_1_store_image" as const,
      idempotencyKey: "retry-after-busy",
    };
    const dependencies = {
      prisma,
      objectStorage: createStorage(),
      createAdapter: () => adapter,
      fetchMedia: vi.fn(async () =>
        new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
      ),
    };

    await expect(
      generateManagedStyle1Image(
        { workspaceId, actorType: "service", actorId: "hermes" },
        command,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_PROVIDER_BUSY" });
    await expect(
      prisma.contentOperation.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId,
            idempotencyKey: command.idempotencyKey,
          },
        },
      }),
    ).resolves.toBeNull();

    await prisma.workspaceProviderLock.delete({ where: { workspaceId } });
    const result = await generateManagedStyle1Image(
      { workspaceId, actorType: "service", actorId: "hermes" },
      command,
      dependencies,
    );
    expect(result.requiredNextAction.type).toBe("RUN_QA");
    expect(adapter.generateImage).toHaveBeenCalledTimes(1);
  });

  it("rejects a run that is not the frozen managed Style 1 objective", async () => {
    await prisma.contentRun.update({
      where: { id: contentRunId },
      data: { style: "style2" },
    });
    const adapter = createAdapter();

    await expect(
      generateManagedStyle1Image(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_image",
          idempotencyKey: "wrong-style",
        },
        {
          prisma,
          objectStorage: createStorage(),
          createAdapter: () => adapter,
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_FROZEN_SNAPSHOT" });
    expect(adapter.generateImage).not.toHaveBeenCalled();
    await expect(prisma.contentOperation.count()).resolves.toBe(0);
  });

  it("does not mark the run failed when success persisted before an ambiguous repository error", async () => {
    const baseRepository = createOperationRepository(prisma);
    const ambiguousRepository = {
      ...baseRepository,
      succeed: vi.fn(async (...args: Parameters<typeof baseRepository.succeed>) => {
        await baseRepository.succeed(...args);
        throw new Error("ambiguous success response");
      }),
    };

    await expect(
      generateManagedStyle1Image(
        { workspaceId, actorType: "service", actorId: "hermes" },
        {
          contentRunId,
          slot: "scene_1_store_image",
          idempotencyKey: "ambiguous-success",
        },
        {
          prisma,
          objectStorage: createStorage(),
          createAdapter: () => createAdapter(),
          operationRepository: ambiguousRepository,
          fetchMedia: vi.fn(async () =>
            new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
          ),
        },
      ),
    ).rejects.toThrow("ambiguous success response");
    await expect(
      prisma.contentOperation.findFirstOrThrow({ where: { contentRunId } }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } }),
    ).resolves.toMatchObject({ status: "qa_running" });
    await expect(prisma.workspaceProviderLock.count()).resolves.toBe(0);
  });
});
