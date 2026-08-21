import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { compileStyleManifest } from "@/lib/content-styles/registry";
import type { StyleManifest } from "@/lib/content-styles/types";
import { createFinalOutputRepository } from "../repository";
import type { AssemblyManifest } from "../types";

const databasePath = resolve(tmpdir(), `final-output-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let workspaceId: string;
let otherWorkspaceId: string;
let contentRunId: string;
let otherProductId: string;

const voiceover = {
  script: "Frozen narration.\nSecond spoken line.",
  provider: "elevenlabs" as const,
  voiceId: "voice-1",
  model: "eleven-multilingual-v2",
};
const audio = {
  bucket: "private-media",
  key: "runs/run-1/voice.mp3",
  contentType: "audio/mpeg" as const,
  bytes: 1234,
  sha256: SHA_A,
  durationSeconds: 16,
};
const manifest: AssemblyManifest = {
  version: "assembly-manifest-v1",
  clips: [
    {
      order: 0,
      slotId: "scene_1_store_video",
      assetId: "video-1",
      assetSha256: SHA_A,
      approvalStatus: "APPROVED",
      trimStartSeconds: 0,
      trimEndSeconds: 8,
      durationSeconds: 8,
      nativeAudioMode: "duck",
    },
    {
      order: 1,
      slotId: "scene_2_home_video",
      assetId: "video-2",
      assetSha256: SHA_B,
      approvalStatus: "APPROVED",
      trimStartSeconds: 0,
      trimEndSeconds: 8,
      durationSeconds: 8,
      nativeAudioMode: "duck",
    },
  ],
  audio: { assetId: "audio-1", assetSha256: SHA_A, durationSeconds: 16 },
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    voiceoverGainDb: 0,
    nativeAudioGainDb: -18,
    duckingThresholdDb: -24,
    expectedDurationSeconds: 16,
  },
  ffmpegVersion: "7.1.1",
};
const mp4 = {
  bucket: "private-media",
  key: "runs/run-1/final.mp4",
  contentType: "video/mp4" as const,
  bytes: 4567,
  sha256: SHA_B,
  durationSeconds: 16,
  width: 1080,
  height: 1920,
  videoCodec: "h264",
  audioCodec: "aac",
  mediaValidatedAt: new Date("2026-08-20T20:00:00.000Z"),
};

beforeAll(() => {
  const prismaCli = fileURLToPath(import.meta.resolve("prisma/build/index.js"));
  execFileSync(
    process.execPath,
    [prismaCli, "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
});

beforeEach(async () => {
  await prisma.qaAttempt.deleteMany();
  await prisma.finalVideoAsset.deleteMany();
  await prisma.contentOperation.deleteMany();
  await prisma.contentRun.deleteMany();
  await prisma.product.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const workspace = await prisma.workspace.create({ data: { name: "one", ownerId: user.id } });
  const otherWorkspace = await prisma.workspace.create({ data: { name: "two", ownerId: user.id } });
  const batch = await prisma.batch.create({ data: { workspaceId: workspace.id, name: "batch" } });
  const otherBatch = await prisma.batch.create({
    data: { workspaceId: otherWorkspace.id, name: "other-batch" },
  });
  const product = await prisma.product.create({ data: { batchId: batch.id, productName: "product" } });
  const otherProduct = await prisma.product.create({
    data: { batchId: otherBatch.id, productName: "other-product" },
  });
  const styleManifest = compileStyleManifest("style1", "managed-style1-v1", "store_discovery");
  const run = await prisma.contentRun.create({
    data: {
      productId: product.id,
      style: "style1",
      market: "uk",
      status: "generating",
      idempotencyKey: randomUUID(),
      promptSnapshotJson: JSON.stringify({
        objective: "create_style1_piece",
        style: "style1",
        specVersion: "managed-style1-v1",
        variant: "store_discovery",
        styleManifest,
        modelSnapshot: { imageModel: "nano-banana-pro", videoModel: "veo-3.1-lite" },
      }),
    },
  });
  workspaceId = workspace.id;
  otherWorkspaceId = otherWorkspace.id;
  contentRunId = run.id;
  otherProductId = otherProduct.id;

  await prisma.flowGeneratedVideo.createMany({
    data: [
      {
        id: "video-1",
        productId: product.id,
        contentRunId: run.id,
        sceneLabel: "scene_1_store",
        mediaGenerationId: "provider-video-1",
        storageSha256: SHA_A,
        qaStatus: "APPROVED",
      },
      {
        id: "video-2",
        productId: product.id,
        contentRunId: run.id,
        sceneLabel: "scene_2_home",
        mediaGenerationId: "provider-video-2",
        storageSha256: SHA_B,
        qaStatus: "APPROVED",
      },
    ],
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

function scope(workspace = workspaceId) {
  return { workspaceId: workspace, contentRunId };
}

function withFinalOutputRace(
  racePrisma: PrismaClient,
  requestedStatus: "APPROVED" | "FAILED",
  winnerData: Record<string, unknown>,
): PrismaClient {
  return new Proxy(racePrisma, {
    get(target, prop, receiver) {
      if (prop !== "finalVideoAsset") return Reflect.get(target, prop, receiver);
      const delegate = target.finalVideoAsset;
      return new Proxy(delegate, {
        get(finalVideoAsset, delegateProp, delegateReceiver) {
          if (delegateProp !== "updateMany") {
            return Reflect.get(finalVideoAsset, delegateProp, delegateReceiver);
          }
          return async (args: Parameters<typeof delegate.updateMany>[0]) => {
            const data = args.data as { status?: unknown };
            if (data.status === requestedStatus) {
              await delegate.update({
                where: { id: args.where?.id as string },
                data: winnerData,
              });
            }
            return delegate.updateMany(args);
          };
        },
      });
    },
  }) as PrismaClient;
}

function withWorkspaceMoveBeforeFinalWrite(racePrisma: PrismaClient): PrismaClient {
  let moved = false;
  return new Proxy(racePrisma, {
    get(target, prop, receiver) {
      if (prop === "$executeRaw") {
        const executeRaw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<number>;
        return async (...args: unknown[]) => {
          if (String(args[0]).includes("FinalVideoAsset")) {
            if (!moved) {
              moved = true;
              await target.contentRun.update({
                where: { id: contentRunId },
                data: { productId: otherProductId },
              });
            }
          }
          return Reflect.apply(executeRaw, target, args);
        };
      }
      if (prop !== "finalVideoAsset") return Reflect.get(target, prop, receiver);
      const delegate = target.finalVideoAsset;
      return new Proxy(delegate, {
        get(finalVideoAsset, delegateProp, delegateReceiver) {
          if (delegateProp !== "updateMany") {
            return Reflect.get(finalVideoAsset, delegateProp, delegateReceiver);
          }
          return async (args: Parameters<typeof delegate.updateMany>[0]) => {
            if (!moved) {
              moved = true;
              await target.contentRun.update({
                where: { id: contentRunId },
                data: { productId: otherProductId },
              });
            }
            return delegate.updateMany(args);
          };
        },
      });
    },
  }) as PrismaClient;
}

function withWorkspaceMoveBeforeReserveWrite(racePrisma: PrismaClient): PrismaClient {
  let moved = false;
  const move = async () => {
    if (moved) return;
    moved = true;
    await racePrisma.contentRun.update({
      where: { id: contentRunId },
      data: { productId: otherProductId },
    });
  };
  return new Proxy(racePrisma, {
    get(target, prop, receiver) {
      if (prop === "$executeRaw") {
        const executeRaw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<number>;
        return async (...args: unknown[]) => {
          await move();
          return Reflect.apply(executeRaw, target, args);
        };
      }
      if (prop !== "finalVideoAsset") return Reflect.get(target, prop, receiver);
      const delegate = target.finalVideoAsset;
      return new Proxy(delegate, {
        get(finalVideoAsset, delegateProp, delegateReceiver) {
          if (delegateProp !== "create") {
            return Reflect.get(finalVideoAsset, delegateProp, delegateReceiver);
          }
          return async (args: Parameters<typeof delegate.create>[0]) => {
            await move();
            return delegate.create(args);
          };
        },
      });
    },
  }) as PrismaClient;
}

async function throughManifest() {
  const repository = createFinalOutputRepository(prisma);
  const reserved = await repository.reserve(scope(), voiceover);
  await repository.persistVoiceover(scope(), reserved.id, audio);
  await repository.persistAssemblyManifest(scope(), reserved.id, manifest);
  return { repository, reserved };
}

async function configureFrozenStyle(
  styleId: "style1" | "style2",
  version: "managed-style1-v1" | "managed-style2-v1",
  variant: "store_discovery" | "handheld" | "large_countertop" | "worn",
): Promise<{ policy: StyleManifest; runtimeManifest: AssemblyManifest; styleAudio: typeof audio }> {
  const policy = compileStyleManifest(styleId, version, variant);
  await prisma.contentRun.update({
    where: { id: contentRunId },
    data: {
      style: styleId,
      promptSnapshotJson: JSON.stringify({
        objective: `create_${styleId}_piece`,
        style: styleId,
        specVersion: version,
        variant,
        styleManifest: policy,
        modelSnapshot: { imageModel: "nano-banana-pro", videoModel: "veo-3.1-lite" },
      }),
    },
  });
  await prisma.flowGeneratedVideo.deleteMany({ where: { contentRunId } });
  const product = await prisma.contentRun.findUniqueOrThrow({
    where: { id: contentRunId },
    select: { productId: true },
  });
  await prisma.flowGeneratedVideo.createMany({
    data: policy.assembly.clips.map((clip, index) => ({
      id: `asset-${clip.slotId}`,
      productId: product.productId,
      contentRunId,
      sceneLabel: clip.slotId,
      mediaGenerationId: `provider-${clip.slotId}`,
      storageSha256: index % 2 === 0 ? SHA_A : SHA_B,
      qaStatus: "APPROVED",
    })),
  });
  const durationSeconds = policy.assembly.output.finalDurationSeconds;
  return {
    policy,
    styleAudio: { ...audio, durationSeconds },
    runtimeManifest: {
      version: "assembly-manifest-v1",
      clips: policy.assembly.clips.map((clip, index) => ({
        ...clip,
        assetId: `asset-${clip.slotId}`,
        assetSha256: index % 2 === 0 ? SHA_A : SHA_B,
        approvalStatus: "APPROVED" as const,
      })),
      audio: { assetId: "audio-1", assetSha256: SHA_A, durationSeconds },
      output: {
        width: policy.assembly.output.width,
        height: policy.assembly.output.height,
        fps: policy.assembly.output.fps,
        voiceoverGainDb: policy.assembly.output.audioMix.voiceoverGainDb,
        nativeAudioGainDb: policy.assembly.output.audioMix.nativeAudioGainDb,
        duckingThresholdDb: policy.assembly.output.audioMix.duckingThresholdDb,
        expectedDurationSeconds: durationSeconds,
      },
      ffmpegVersion: "7.1.1",
    },
  };
}

describe("final output repository", () => {
  it.each([
    ["style1", "managed-style1-v1", "store_discovery", (value: any): void => { value.clips[0].nativeAudioMode = "preserve"; }],
    ["style1", "managed-style1-v1", "store_discovery", (value: any): void => { value.output.fps = 60; }],
    ["style2", "managed-style2-v1", "handheld", (value: any) => {
      [value.clips[0].slotId, value.clips[1].slotId] = [value.clips[1].slotId, value.clips[0].slotId];
    }],
    ["style2", "managed-style2-v1", "handheld", (value: any) => {
      value.clips[0].trimEndSeconds += 1;
      value.clips[0].durationSeconds += 1;
      value.output.expectedDurationSeconds += 1;
    }],
    ["style2", "managed-style2-v1", "large_countertop", (value: any) => {
      value.output.width = 1920;
      value.output.height = 1080;
    }],
    ["style2", "managed-style2-v1", "large_countertop", (value: any) => {
      value.clips[0].trimEndSeconds += 1;
      value.clips[0].durationSeconds += 1;
      value.output.expectedDurationSeconds += 1;
    }],
    ["style2", "managed-style2-v1", "worn", (value: any): void => { value.output.nativeAudioGainDb = -18; }],
    ["style2", "managed-style2-v1", "worn", (value: any): void => { value.clips[0].nativeAudioMode = "duck"; }],
  ] as const)(
    "rejects a structurally valid assembly manifest that drifts from %s/%s/%s frozen policy",
    async (styleId, version, variant, mutate) => {
      const configured = await configureFrozenStyle(styleId, version, variant);
      const repository = createFinalOutputRepository(prisma);
      const reserved = await repository.reserve(scope(), voiceover);
      await repository.persistVoiceover(scope(), reserved.id, configured.styleAudio);
      const drifted = structuredClone(configured.runtimeManifest);
      mutate(drifted);

      await expect(
        repository.persistAssemblyManifest(scope(), reserved.id, drifted),
      ).rejects.toThrow(/frozen|policy|manifest/i);
    },
  );

  it("atomically rejects reservation when the run is re-homed after authorization", async () => {
    const racedRepository = createFinalOutputRepository(withWorkspaceMoveBeforeReserveWrite(prisma));

    await expect(racedRepository.reserve(scope(), voiceover)).rejects.toThrow(
      /workspace|not found|conflict/i,
    );
    expect(await prisma.finalVideoAsset.count({ where: { contentRunId } })).toBe(0);
  });

  it("atomically rejects a CAS write when the run is re-homed after authorization", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    const racedRepository = createFinalOutputRepository(withWorkspaceMoveBeforeFinalWrite(prisma));

    await expect(
      racedRepository.persistVoiceover(scope(), reserved.id, audio),
    ).rejects.toThrow(/workspace|not found|conflict/i);
    expect(
      await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: reserved.id } }),
    ).toMatchObject({ status: "PENDING", audioStorageKey: null });
  });

  it("reserves exactly one tenant-fenced final row and replays the same frozen voice config", async () => {
    const repository = createFinalOutputRepository(prisma);
    const first = await repository.reserve(scope(), voiceover);
    const replay = await repository.reserve(scope(), voiceover);

    expect(replay.id).toBe(first.id);
    expect(await prisma.finalVideoAsset.count({ where: { contentRunId } })).toBe(1);
    await expect(repository.reserve(scope(otherWorkspaceId), voiceover)).rejects.toThrow(/workspace/i);
    await expect(
      repository.reserve(scope(), { ...voiceover, voiceId: "different-voice" }),
    ).rejects.toThrow(/idempotency|frozen/i);
  });

  it("persists voiceover object metadata idempotently only on the reserved row", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    const saved = await repository.persistVoiceover(scope(), reserved.id, audio);
    const replay = await repository.persistVoiceover(scope(), reserved.id, audio);

    expect(saved).toMatchObject({ status: "VOICEOVER_READY", audioSha256: SHA_A });
    expect(replay.updatedAt).toEqual(saved.updatedAt);
    await expect(
      repository.persistVoiceover(scope(), reserved.id, { ...audio, sha256: SHA_B }),
    ).rejects.toThrow(/overwrit|conflict/i);
  });

  it("persists the assembly manifest once and never overwrites it", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    await expect(
      repository.persistAssemblyManifest(scope(), reserved.id, manifest),
    ).rejects.toThrow(/voiceover/i);
    await repository.persistVoiceover(scope(), reserved.id, audio);

    const saved = await repository.persistAssemblyManifest(scope(), reserved.id, manifest);
    const replay = await repository.persistAssemblyManifest(scope(), reserved.id, manifest);
    expect(replay.assemblyManifestJson).toBe(saved.assemblyManifestJson);
    await expect(
      repository.persistAssemblyManifest(scope(), reserved.id, {
        ...manifest,
        ffmpegVersion: "7.2.0",
      }),
    ).rejects.toThrow(/overwrit|conflict/i);
  });

  it("rejects assembly manifests with unpersisted audio or cross-run source provenance", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    await repository.persistVoiceover(scope(), reserved.id, audio);

    await expect(
      repository.persistAssemblyManifest(scope(), reserved.id, {
        ...manifest,
        audio: { ...manifest.audio, assetSha256: SHA_B },
      }),
    ).rejects.toThrow(/audio|provenance/i);
    await expect(
      repository.persistAssemblyManifest(scope(), reserved.id, {
        ...manifest,
        clips: manifest.clips.map((clip, index) =>
          index === 0 ? { ...clip, assetId: "other-run-video" } : clip,
        ),
      }),
    ).rejects.toThrow(/source|provenance/i);
    await expect(
      repository.persistAssemblyManifest(scope(), reserved.id, {
        ...manifest,
        clips: [
          { ...manifest.clips[0], assetId: "video-2", assetSha256: SHA_B },
          { ...manifest.clips[1], assetId: "video-1", assetSha256: SHA_A },
        ],
      }),
    ).rejects.toThrow(/slot|source|provenance/i);
  });

  it("rejects final MP4 persistence until audio and manifest exist", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    await expect(repository.persistFinalMp4(scope(), reserved.id, mp4)).rejects.toThrow(
      /manifest|voiceover/i,
    );
  });

  it.each([
    ["duration", { durationSeconds: 15 }],
    ["dimensions", { width: 1920, height: 1080 }],
    ["codecs", { videoCodec: "hevc", audioCodec: "opus" }],
  ])("rejects final MP4 %s metadata that drifts from the frozen output policy", async (_label, drift) => {
    const { repository, reserved } = await throughManifest();

    await expect(
      repository.persistFinalMp4(scope(), reserved.id, { ...mp4, ...drift }),
    ).rejects.toThrow(/frozen|policy|metadata/i);
  });

  it("persists only a hash-and-probe-validated MP4 and replays idempotently", async () => {
    const { repository, reserved } = await throughManifest();
    const saved = await repository.persistFinalMp4(scope(), reserved.id, mp4);
    const replay = await repository.persistFinalMp4(scope(), reserved.id, mp4);

    expect(saved).toMatchObject({
      status: "MEDIA_VALIDATED",
      finalSha256: SHA_B,
      mediaValidationPassed: true,
    });
    expect(replay.updatedAt).toEqual(saved.updatedAt);
  });

  it("transitions final QA without approving an incomplete output", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    await expect(repository.startFinalQa(scope(), reserved.id)).rejects.toThrow(/validated/i);

    await repository.persistVoiceover(scope(), reserved.id, audio);
    await repository.persistAssemblyManifest(scope(), reserved.id, manifest);
    await repository.persistFinalMp4(scope(), reserved.id, mp4);
    const running = await repository.startFinalQa(scope(), reserved.id);
    expect(running).toMatchObject({ status: "QA_RUNNING", finalQaStatus: "QA_RUNNING" });

    const approved = await repository.completeFinalQa(scope(), reserved.id, {
      status: "APPROVED",
      score: 95,
      verdict: "Approved final audiovisual output",
      evaluatedAt: new Date("2026-08-20T20:01:00.000Z"),
    });
    expect(approved).toMatchObject({ status: "APPROVED", finalQaStatus: "APPROVED" });
  });

  it("rejects an unknown final QA lifecycle decision from runtime callers", async () => {
    const { repository, reserved } = await throughManifest();
    await repository.persistFinalMp4(scope(), reserved.id, mp4);
    await repository.startFinalQa(scope(), reserved.id);

    await expect(
      repository.completeFinalQa(scope(), reserved.id, {
        status: "READY",
        score: 95,
        verdict: "Invalid lifecycle decision",
        evaluatedAt: new Date("2026-08-20T20:01:00.000Z"),
      } as never),
    ).rejects.toThrow(/status|decision|metadata/i);
  });

  it("rejects invalid deterministic final QA metadata", async () => {
    const { repository, reserved } = await throughManifest();
    await repository.persistFinalMp4(scope(), reserved.id, mp4);
    await repository.startFinalQa(scope(), reserved.id);

    await expect(
      repository.completeFinalQa(scope(), reserved.id, {
        status: "APPROVED",
        score: 101,
        verdict: "Out-of-range score",
        evaluatedAt: new Date("2026-08-20T20:01:00.000Z"),
      }),
    ).rejects.toThrow(/score/i);
    await expect(
      repository.completeFinalQa(scope(), reserved.id, {
        status: "APPROVED",
        score: 95,
        verdict: "Invalid timestamp",
        evaluatedAt: new Date("invalid"),
      }),
    ).rejects.toThrow(/timestamp|date/i);
  });

  it("rejects a final QA CAS loser when a different decision wins", async () => {
    const { repository, reserved } = await throughManifest();
    await repository.persistFinalMp4(scope(), reserved.id, mp4);
    await repository.startFinalQa(scope(), reserved.id);
    const winnerAt = new Date("2026-08-20T20:01:30.000Z");
    const racedRepository = createFinalOutputRepository(
      withFinalOutputRace(prisma, "APPROVED", {
        status: "HUMAN_REVIEW",
        finalQaStatus: "HUMAN_REVIEW",
        finalQaScore: 60,
        finalQaVerdict: "Concurrent review winner",
        finalQaEvaluatedAt: winnerAt,
      }),
    );

    await expect(
      racedRepository.completeFinalQa(scope(), reserved.id, {
        status: "APPROVED",
        score: 95,
        verdict: "Losing approval",
        evaluatedAt: new Date("2026-08-20T20:01:00.000Z"),
      }),
    ).rejects.toThrow(/conflict/i);
  });

  it("records terminal infrastructure failure without false READY and replays it", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    const input = {
      code: "OBJECT_STORAGE_FAILED",
      details: { retryable: false },
      failedAt: new Date("2026-08-20T20:02:00.000Z"),
    };
    const failed = await repository.recordTerminalFailure(scope(), reserved.id, input);
    const replay = await repository.recordTerminalFailure(scope(), reserved.id, input);

    expect(failed).toMatchObject({ status: "FAILED", failureCode: input.code });
    expect(replay.updatedAt).toEqual(failed.updatedAt);
    expect(failed.finalQaStatus).not.toBe("APPROVED");
  });

  it("rejects a terminal failure CAS loser when different failure audit wins", async () => {
    const repository = createFinalOutputRepository(prisma);
    const reserved = await repository.reserve(scope(), voiceover);
    const racedRepository = createFinalOutputRepository(
      withFinalOutputRace(prisma, "FAILED", {
        status: "FAILED",
        failureCode: "WINNER_FAILURE",
        failureJson: JSON.stringify({ retryable: true }),
        failedAt: new Date("2026-08-20T20:03:00.000Z"),
      }),
    );

    await expect(
      racedRepository.recordTerminalFailure(scope(), reserved.id, {
        code: "LOSER_FAILURE",
        details: { retryable: false },
        failedAt: new Date("2026-08-20T20:02:00.000Z"),
      }),
    ).rejects.toThrow(/conflict/i);
  });
});
