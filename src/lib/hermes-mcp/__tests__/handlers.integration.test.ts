import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { generateManagedVideo } from "@/lib/content-generation/generate-video";
import type { ApexFlowAdapter } from "@/lib/content-generation/apex-flow-adapter";
import { projectContentRun } from "@/lib/content-runs/project-run";
import type { ServiceActorContext } from "@/lib/content-runs/types";
import { compileStyleManifest } from "@/lib/content-styles/registry";
import { StyleManifestSchema } from "@/lib/content-styles/schemas";
import type { ObjectStorage, PutManagedObjectInput } from "@/lib/storage";
import { createHermesContentHandlers } from "../handlers";
import { HermesContentQueryError } from "../queries";

const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
]);
const databasePath = resolve(tmpdir(), `hermes-handlers-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

let actor: ServiceActorContext;
let contentRunId: string;

function createAdapter() {
  return {
    uploadAsset: vi.fn(),
    generateImage: vi.fn(),
    startVideo: vi.fn(async () => ({ providerJobId: "provider-job-1" })),
    pollVideo: vi
      .fn()
      .mockResolvedValueOnce({ status: "running", providerJobId: "provider-job-1" })
      .mockResolvedValueOnce({
        status: "completed",
        providerJobId: "provider-job-1",
        mediaGenerationId: "managed-video-n1",
        url: "https://provider.example/managed-video-n1.mp4",
      }),
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

async function getRunView(requestActor: ServiceActorContext, runId: string) {
  const run = await prisma.contentRun.findFirst({
    where: { id: runId, product: { batch: { workspaceId: requestActor.workspaceId } } },
    include: {
      images: { where: { deletedAt: null } },
      videos: { where: { deletedAt: null } },
      operations: { orderBy: { createdAt: "asc" } },
      finalVideo: true,
    },
  });
  if (!run) {
    throw new HermesContentQueryError(
      "CONTENT_RUN_NOT_FOUND",
      "Content run was not found in the authenticated workspace.",
    );
  }
  const snapshot = JSON.parse(run.promptSnapshotJson ?? "") as Record<string, unknown>;
  const manifest = StyleManifestSchema.parse(snapshot.styleManifest);
  return {
    style: { id: manifest.styleId, version: manifest.version, variant: manifest.variant },
    slotMediaTypes: Object.fromEntries(manifest.slots.map((slot) => [slot.id, slot.mediaType])),
    run: projectContentRun({
      run,
      images: run.images,
      videos: run.videos,
      operations: run.operations,
      finalVideo: run.finalVideo,
    }),
  };
}

async function getReplayOperation(
  requestActor: ServiceActorContext,
  runId: string,
  operationId: string,
) {
  return prisma.contentOperation.findFirst({
    where: {
      id: operationId,
      workspaceId: requestActor.workspaceId,
      contentRunId: runId,
      status: { in: ["requested", "running"] },
      contentRun: { product: { batch: { workspaceId: requestActor.workspaceId } } },
    },
    select: {
      id: true,
      workspaceId: true,
      contentRunId: true,
      kind: true,
      sceneLabel: true,
      status: true,
      idempotencyKey: true,
    },
  });
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

  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const workspace = await prisma.workspace.create({ data: { name: "workspace", ownerId: user.id } });
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

  const manifest = compileStyleManifest("style2", "managed-style2-v1", "handheld");
  const snapshot = {
    objective: "create_style2_piece",
    style: "style2",
    specVersion: "managed-style2-v1",
    variant: "handheld",
    product: { id: product.id, name: "product", references: [] },
    modelSnapshot: {
      imageModel: "nano-banana-pro",
      videoModel: "veo-3.1-lite-low-priority",
    },
    styleManifest: manifest,
    slots: manifest.slots.map((slot) => ({
      slot: slot.id,
      mediaType: slot.mediaType,
      prompt: `frozen ${slot.id} prompt`,
      promptCompilerId: slot.promptCompilerId,
      generation: {
        aspectRatio: slot.mediaType === "image" ? "9:16" : "portrait",
        durationSeconds: slot.providerRequestDurationSeconds,
        startImageSlot: slot.sourceDependency,
        characterReferenceIds: ["registered-character-1"],
        referenceAttachmentIds: [],
      },
    })),
  };
  const run = await prisma.contentRun.create({
    data: {
      productId: product.id,
      style: "style2",
      market: "uk",
      status: "generating",
      idempotencyKey: randomUUID(),
      promptSnapshotJson: JSON.stringify(snapshot),
    },
  });

  actor = { workspaceId: workspace.id, actorType: "service", actorId: "hermes-test" };
  contentRunId = run.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

describe("Hermes managed generation handler integration", () => {
  it("starts once then replays the same WAIT command through polling and completion", async () => {
    const adapter = createAdapter();
    const storage = createStorage();
    const handlers = createHermesContentHandlers(actor, {
      getRun: getRunView,
      getGenerationReplayOperation: getReplayOperation,
      generateVideo: (requestActor, command) =>
        generateManagedVideo(requestActor, command, {
          prisma,
          objectStorage: storage,
          createAdapter: () => adapter,
          fetchMedia: vi.fn(async () =>
            new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
          ),
        }),
    });
    const command = { contentRunId, idempotencyKey: "stable-style2-n1" };

    const started = await handlers.content_generate_video(command);
    const waiting = await handlers.content_generate_video(command);
    const completed = await handlers.content_generate_video(command);

    expect(started).toMatchObject({
      operationStatus: "running",
      contentRunId,
      slot: "N1",
      providerJobId: "provider-job-1",
      requiredNextAction: { type: "WAIT_FOR_OPERATION" },
    });
    expect(waiting).toMatchObject({
      operationId: started.operationId,
      operationStatus: "running",
      requiredNextAction: { type: "WAIT_FOR_OPERATION", operationId: started.operationId },
    });
    expect(completed).toMatchObject({
      operationId: started.operationId,
      operationStatus: "succeeded",
      contentRunId,
      slot: "N1",
      providerJobId: "provider-job-1",
      asset: {
        contentRunId,
        sceneLabel: "N1",
        mediaGenerationId: "managed-video-n1",
        qaStatus: "NOT_QA_CHECKED",
      },
      requiredNextAction: { type: "RUN_QA", slot: "N1" },
    });
    expect(adapter.startVideo).toHaveBeenCalledTimes(1);
    expect(adapter.pollVideo).toHaveBeenCalledTimes(2);
    expect(storage.put).toHaveBeenCalledTimes(1);
    await expect(prisma.contentOperation.count({ where: { contentRunId } })).resolves.toBe(1);
    await expect(prisma.flowGeneratedVideo.count({ where: { contentRunId } })).resolves.toBe(1);
  });

  it("does not resolve or replay another workspace's active operation", async () => {
    const adapter = createAdapter();
    const storage = createStorage();
    const dependencies = {
      getRun: getRunView,
      getGenerationReplayOperation: getReplayOperation,
      generateVideo: (requestActor: ServiceActorContext, command: Parameters<typeof generateManagedVideo>[1]) =>
        generateManagedVideo(requestActor, command, {
          prisma,
          objectStorage: storage,
          createAdapter: () => adapter,
          fetchMedia: vi.fn(async () =>
            new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
          ),
        }),
    };
    const ownerHandlers = createHermesContentHandlers(actor, dependencies);
    const command = { contentRunId, idempotencyKey: "stable-style2-n1" };
    await ownerHandlers.content_generate_video(command);

    const otherUser = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
    const otherWorkspace = await prisma.workspace.create({
      data: { name: "other", ownerId: otherUser.id },
    });
    const otherHandlers = createHermesContentHandlers(
      { workspaceId: otherWorkspace.id, actorType: "service", actorId: "other-hermes" },
      dependencies,
    );

    await expect(otherHandlers.content_generate_video(command)).rejects.toMatchObject({
      code: "CONTENT_RUN_NOT_FOUND",
    });
    expect(adapter.startVideo).toHaveBeenCalledTimes(1);
    expect(adapter.pollVideo).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    await expect(prisma.contentOperation.count({ where: { contentRunId } })).resolves.toBe(1);
    await expect(prisma.flowGeneratedVideo.count({ where: { contentRunId } })).resolves.toBe(0);
  });
});
