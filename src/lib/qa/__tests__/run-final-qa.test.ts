import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { compileStyleManifest } from "@/lib/content-styles/registry";
import { FINAL_RUBRIC, type FinalVisualQaResult } from "../final-rubric";
import { __finalQaInternals, runFinalQa, type RunFinalQaDependencies } from "../run-final-qa";

const databasePath = resolve(tmpdir(), `run-final-qa-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const mediaBytes = new TextEncoder().encode("persisted-final-mp4");
const finalSha256 = createHash("sha256").update(mediaBytes).digest("hex");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const now = new Date("2026-08-20T20:01:00.000Z");

let workspaceId: string;
let otherWorkspaceId: string;
let contentRunId: string;
let finalVideoId: string;

const manifest = {
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
} as const;

const approvedVisual: FinalVisualQaResult = {
  overallScore: 94,
  hasHardFailure: false,
  checks: FINAL_RUBRIC.map((criterion) => ({ name: criterion.name, passed: true, score: 94 })),
  issues: [],
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
  await prisma.flowGeneratedImage.deleteMany();
  await prisma.flowGeneratedVideo.deleteMany();
  await prisma.contentOperation.deleteMany();
  await prisma.contentRun.deleteMany();
  await prisma.product.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const workspace = await prisma.workspace.create({ data: { name: "one", ownerId: owner.id } });
  const other = await prisma.workspace.create({ data: { name: "two", ownerId: owner.id } });
  const batch = await prisma.batch.create({ data: { workspaceId: workspace.id, name: "batch" } });
  const product = await prisma.product.create({
    data: { batchId: batch.id, productName: "Test Product" },
  });
  const styleManifest = compileStyleManifest("style1", "managed-style1-v1", "store_discovery");
  const run = await prisma.contentRun.create({
    data: {
      productId: product.id,
      style: "style1",
      market: "uk",
      status: "qa_running",
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
  otherWorkspaceId = other.id;
  contentRunId = run.id;
  await prisma.flowGeneratedVideo.createMany({
    data: [
      {
        id: "video-1",
        productId: product.id,
        contentRunId,
        sceneLabel: "scene_1_store",
        mediaGenerationId: "provider-video-1",
        storageSha256: SHA_A,
        qaStatus: "APPROVED",
      },
      {
        id: "video-2",
        productId: product.id,
        contentRunId,
        sceneLabel: "scene_2_home",
        mediaGenerationId: "provider-video-2",
        storageSha256: SHA_B,
        qaStatus: "APPROVED",
      },
    ],
  });
  await prisma.flowGeneratedImage.createMany({
    data: [
      {
        id: "image-1",
        productId: product.id,
        contentRunId,
        sceneLabel: "scene_1_store_image",
        mediaGenerationId: "provider-image-1",
        storageSha256: SHA_A,
        qaStatus: "APPROVED",
      },
      {
        id: "image-2",
        productId: product.id,
        contentRunId,
        sceneLabel: "scene_2_home_image",
        mediaGenerationId: "provider-image-2",
        storageSha256: SHA_B,
        qaStatus: "APPROVED",
      },
    ],
  });
  const final = await prisma.finalVideoAsset.create({
    data: {
      contentRunId,
      status: "MEDIA_VALIDATED",
      voiceoverScript: "Frozen narration.",
      voiceoverProvider: "elevenlabs",
      voiceoverVoiceId: "voice-1",
      voiceoverModel: "eleven-multilingual-v2",
      audioStorageBucket: "private-media",
      audioStorageKey: `managed/${workspaceId}/${contentRunId}/audio/audio-1.mp3`,
      audioContentType: "audio/mpeg",
      audioBytes: 100,
      audioSha256: SHA_A,
      audioDurationSeconds: 16,
      assemblyManifestJson: JSON.stringify(manifest),
      finalStorageBucket: "private-media",
      finalStorageKey: `managed/${workspaceId}/${contentRunId}/final/final.mp4`,
      finalContentType: "video/mp4",
      finalBytes: mediaBytes.byteLength,
      finalSha256,
      finalDurationSeconds: 16,
      finalWidth: 1080,
      finalHeight: 1920,
      finalVideoCodec: "h264",
      finalAudioCodec: "aac",
      mediaValidationPassed: true,
      mediaValidatedAt: new Date("2026-08-20T20:00:00.000Z"),
    },
  });
  finalVideoId = final.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

function dependencies(overrides: Partial<RunFinalQaDependencies> = {}): RunFinalQaDependencies {
  return {
    prisma,
    storage: {
      bucket: "private-media",
      put: vi.fn(),
      get: vi.fn(async () => ({
        body: mediaBytes,
        contentType: "video/mp4",
        bytes: mediaBytes.byteLength,
        metadata: {},
      })),
      delete: vi.fn(),
      createSignedReadUrl: vi.fn(async () => {
        throw new Error("final QA must not mint or consume provider URLs");
      }),
    },
    probeMedia: vi.fn(async () => ({
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      durationSeconds: 16,
      streams: [
        { type: "video" as const, codecName: "h264", width: 1080, height: 1920, averageFrameRate: "30/1" },
        { type: "audio" as const, codecName: "aac", durationSeconds: 16, channels: 2 },
      ],
    })),
    analyzeAudio: vi.fn(async () => ({
      leadingSilenceSeconds: 0.1,
      trailingSilenceSeconds: 0.1,
      clippedSampleCount: 0,
    })),
    extractFrames: vi.fn(async () => [
      { timestampMs: 0, data: "ZmFrZS1qcGVn", mediaType: "image/jpeg" as const },
      { timestampMs: 15_950, data: "ZmFrZS1qcGVn", mediaType: "image/jpeg" as const },
    ]),
    visualProvider: {
      identifier: "test:vision",
      evaluateFinal: vi.fn(async (input) => {
        expect(input.rubric).toBe(FINAL_RUBRIC);
        expect(input.systemPrompt).toContain("Final-output rubric");
        expect(input.userText).toContain("Expected clip order");
        return { result: approvedVisual, providerModel: "test-vision-v1", elapsedMs: 12 };
      }),
    },
    now: () => now,
    ...overrides,
  };
}

function command() {
  return { contentRunId, finalVideoId };
}

async function latestState() {
  return {
    final: await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: finalVideoId } }),
    run: await prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } }),
    attempts: await prisma.qaAttempt.findMany({ where: { finalVideoId } }),
  };
}

describe("runFinalQa", () => {
  it("approves persisted bytes and atomically records one final attempt before READY", async () => {
    const result = await runFinalQa({ workspaceId }, command(), dependencies());
    const state = await latestState();

    expect(result).toMatchObject({ decision: "APPROVE", finalQaStatus: "APPROVED", runStatus: "ready" });
    expect(state.run.status).toBe("ready");
    expect(state.final).toMatchObject({
      status: "APPROVED",
      finalQaStatus: "APPROVED",
      finalQaScore: 94,
      finalQaVerdict: "Final deterministic and sampled-frame QA approved.",
    });
    expect(JSON.parse((state.final as typeof state.final & { mediaValidationJson: string }).mediaValidationJson)).toMatchObject({
      passed: true,
      verifiedObject: { bytes: mediaBytes.byteLength, sha256: finalSha256 },
    });
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({
      imageId: null,
      videoId: null,
      finalVideoId,
      assetType: "FINAL_VIDEO",
      decision: "APPROVE",
      overallScore: 94,
    });
  });

  it("routes deterministic missing-audio and visual defects to HUMAN_REVIEW without false READY", async () => {
    const missingAudio = dependencies({
      probeMedia: vi.fn(async () => ({
        formatName: "mp4",
        durationSeconds: 16,
        streams: [
          { type: "video" as const, codecName: "h264", width: 1080, height: 1920, averageFrameRate: 30 },
        ],
      })),
    });
    const first = await runFinalQa({ workspaceId }, command(), missingAudio);
    expect(first.decision).toBe("HUMAN_REVIEW");
    expect((await latestState()).run.status).toBe("human_review");

    await prisma.qaAttempt.deleteMany();
    await prisma.finalVideoAsset.update({
      where: { id: finalVideoId },
      data: { status: "MEDIA_VALIDATED", finalQaStatus: "NOT_QA_CHECKED", finalQaScore: null, finalQaVerdict: null, finalQaEvaluatedAt: null },
    });
    await prisma.contentRun.update({ where: { id: contentRunId }, data: { status: "qa_running" } });
    const visualDefect: FinalVisualQaResult = {
      ...approvedVisual,
      overallScore: 50,
      hasHardFailure: true,
      checks: approvedVisual.checks.map((check, index) =>
        index === 0 ? { ...check, passed: false, score: 20, severity: "major" as const } : check,
      ),
    };
    const second = await runFinalQa(
      { workspaceId },
      command(),
      dependencies({
        visualProvider: {
          identifier: "test:defect",
          evaluateFinal: vi.fn(async () => ({ result: visualDefect, providerModel: "test-v2", elapsedMs: 1 })),
        },
      }),
    );
    expect(second.decision).toBe("HUMAN_REVIEW");
    expect((await latestState()).run.status).toBe("human_review");
  });

  it.each([
    ["storage", { storage: { get: vi.fn(async () => { throw new Error("secret=https://provider.example/token"); }) } }],
    ["probe", { probeMedia: vi.fn(async () => { throw new Error("ffprobe unavailable"); }) }],
    ["provider", { visualProvider: { identifier: "test:broken", evaluateFinal: vi.fn(async () => { throw new Error("api-key-secret"); }) } }],
  ])("fails closed on %s infrastructure failure and redacts exception text", async (_label, override) => {
    const base = dependencies();
    const deps = {
      ...base,
      ...override,
      storage: "storage" in override ? { ...base.storage, ...override.storage } : base.storage,
    } as RunFinalQaDependencies;
    const result = await runFinalQa({ workspaceId }, command(), deps);
    const state = await latestState();

    expect(result.decision).toBe("FAILED");
    expect(state.run.status).toBe("failed");
    expect(state.final.status).toBe("FAILED");
    expect(state.attempts).toHaveLength(1);
    expect(JSON.stringify(state)).not.toMatch(/provider\.example|api-key-secret/);
  });

  it.each([
    ["tampered object hash", async () => prisma.finalVideoAsset.update({ where: { id: finalVideoId }, data: { finalSha256: "f".repeat(64) } })],
    ["tampered immutable manifest", async () => prisma.finalVideoAsset.update({ where: { id: finalVideoId }, data: { assemblyManifestJson: JSON.stringify({ ...manifest, providerUrl: "https://forbidden.example" }) } })],
  ])("routes %s to HUMAN_REVIEW", async (_label, tamper) => {
    await tamper();
    const result = await runFinalQa({ workspaceId }, command(), dependencies());
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect((await latestState()).run.status).toBe("human_review");
  });

  it.each([
    ["tampered persisted audio hash", { audioSha256: "f".repeat(64) }],
    ["missing frozen voiceover", { voiceoverScript: null }],
  ])("does not approve with %s", async (_label, data) => {
    await prisma.finalVideoAsset.update({ where: { id: finalVideoId }, data });
    const result = await runFinalQa({ workspaceId }, command(), dependencies());
    expect(result.decision).toBe("HUMAN_REVIEW");
    expect((await latestState()).run.status).not.toBe("ready");
  });

  it("rejects cross-workspace calls before object storage or provider work", async () => {
    const deps = dependencies();
    await expect(runFinalQa({ workspaceId: otherWorkspaceId }, command(), deps)).rejects.toThrow(/workspace|not found/i);
    expect(deps.storage!.get).not.toHaveBeenCalled();
    expect(deps.visualProvider.evaluateFinal).not.toHaveBeenCalled();
    expect((await latestState()).attempts).toHaveLength(0);
  });

  it("allows only one concurrent caller to acquire final QA and creates one attempt", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const firstDeps = dependencies({
      probeMedia: vi.fn(async () => {
        entered();
        await wait;
        return {
          formatName: "mp4",
          durationSeconds: 16,
          streams: [
            { type: "video" as const, codecName: "h264", width: 1080, height: 1920, averageFrameRate: 30 },
            { type: "audio" as const, codecName: "aac", durationSeconds: 16, channels: 2 },
          ],
        };
      }),
    });
    const first = runFinalQa({ workspaceId }, command(), firstDeps);
    await started;
    await expect(runFinalQa({ workspaceId }, command(), dependencies())).rejects.toThrow(/concurrent|running|conflict/i);
    release();
    await first;
    expect((await latestState()).attempts).toHaveLength(1);
  });

  it("replays the terminal attempt without storage, ffmpeg, or provider work", async () => {
    const first = await runFinalQa({ workspaceId }, command(), dependencies());
    const replayDeps = dependencies();
    const replay = await runFinalQa({ workspaceId }, command(), replayDeps);

    expect(replay).toEqual(first);
    expect(replayDeps.storage!.get).not.toHaveBeenCalled();
    expect(replayDeps.probeMedia).not.toHaveBeenCalled();
    expect(replayDeps.visualProvider.evaluateFinal).not.toHaveBeenCalled();
    expect((await latestState()).attempts).toHaveLength(1);
  });

  it("fails the approval CAS if a required source approval is revoked before commit", async () => {
    const deps = dependencies({
      visualProvider: {
        identifier: "test:revoke",
        evaluateFinal: vi.fn(async () => {
          await prisma.flowGeneratedImage.update({ where: { id: "image-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
          return { result: approvedVisual, providerModel: "test-v1", elapsedMs: 1 };
        }),
      },
    });
    const result = await runFinalQa({ workspaceId }, command(), deps);
    const state = await latestState();

    expect(result.decision).not.toBe("APPROVE");
    expect(state.run.status).not.toBe("ready");
    expect(state.final.finalQaStatus).not.toBe("APPROVED");
    expect(state.attempts).toHaveLength(1);
  });

  it("rejects completion when immutable final metadata changes after the QA lock", async () => {
    const deps = dependencies({
      visualProvider: {
        identifier: "test:metadata-race",
        evaluateFinal: vi.fn(async () => {
          await prisma.finalVideoAsset.update({
            where: { id: finalVideoId },
            data: { assemblyManifestJson: JSON.stringify({ ...manifest, ffmpegVersion: "7.2.0" }) },
          });
          return { result: approvedVisual, providerModel: "test-v1", elapsedMs: 1 };
        }),
      },
    });

    await expect(runFinalQa({ workspaceId }, command(), deps)).rejects.toThrow(/CAS|conflict|changed/i);
    const state = await latestState();
    expect(state.run.status).not.toBe("ready");
    expect(state.final.finalQaStatus).not.toBe("APPROVED");
    expect(state.attempts).toHaveLength(0);
  });

  it("counts only full-scale peak samples as clipped audio", () => {
    const ordinary = __finalQaInternals.parseAudioAnalysis(
      "Peak level dB: -18.06\nPeak count: 128\n",
      16,
    );
    const clipped = __finalQaInternals.parseAudioAnalysis(
      "Peak level dB: 0.00\nPeak count: 7\n",
      16,
    );
    const interiorSilence = __finalQaInternals.parseAudioAnalysis(
      "silence_start: 1\nsilence_end: 2 | silence_duration: 1\nPeak level dB: -18\nPeak count: 1\n",
      3,
    );
    expect(ordinary.clippedSampleCount).toBe(0);
    expect(clipped.clippedSampleCount).toBe(7);
    expect(interiorSilence.trailingSilenceSeconds).toBe(0);
  });
});
