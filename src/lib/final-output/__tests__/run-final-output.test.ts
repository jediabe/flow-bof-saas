import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { compileStyleManifest } from "@/lib/content-styles/registry";
import { FINAL_RUBRIC, type FinalVisualQaResult } from "@/lib/qa/final-rubric";
import type { AssemblyManifest } from "@/lib/content-runs/types";
import type { ObjectStorage, PutManagedObjectInput, ReadObjectResult, StoredObjectMetadata } from "@/lib/storage";
import { runFinalOutput } from "../run-final-output";

const databasePath = resolve(tmpdir(), `run-final-output-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const text = new TextEncoder();
const SHA_A = createHash("sha256").update(text.encode("aaa")).digest("hex");
const SHA_B = createHash("sha256").update(text.encode("bbb")).digest("hex");

class MemoryStorage implements ObjectStorage {
  readonly bucket = "private-media";
  readonly puts: PutManagedObjectInput[] = [];
  readonly deletes: string[] = [];
  readonly objects = new Map<string, ReadObjectResult>();

  async put(input: PutManagedObjectInput): Promise<StoredObjectMetadata> {
    this.puts.push(input);
    const directory = input.mediaType === "audio" ? "audio" : input.mediaType === "final_video" ? "final" : `${input.mediaType}s`;
    const key = ["managed-content", input.workspaceId, input.contentRunId, directory, `${input.assetId}.${input.extension.replace(/^\./, "")}`].join("/");
    const metadata = {
      bucket: this.bucket,
      key,
      contentType: input.contentType,
      bytes: input.body.byteLength,
      sha256: createHash("sha256").update(input.body).digest("hex"),
    };
    this.objects.set(key, { body: input.body, contentType: input.contentType, bytes: input.body.byteLength, metadata: { sha256: metadata.sha256 } });
    return metadata;
  }

  async get(key: string): Promise<ReadObjectResult> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing object ${key}`);
    return object;
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  async createSignedReadUrl(): Promise<string> {
    return "https://signed.example/final";
  }
}

let workspaceId: string;
let contentRunId: string;
let storage: MemoryStorage;

beforeAll(() => {
  const prismaCli = fileURLToPath(import.meta.resolve("prisma/build/index.js"));
  execFileSync(process.execPath, [prismaCli, "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });
});

beforeEach(async () => {
  await prisma.qaAttempt.deleteMany();
  await prisma.finalVideoAsset.deleteMany();
  await prisma.contentOperation.deleteMany();
  await prisma.flowGeneratedVideo.deleteMany();
  await prisma.flowGeneratedImage.deleteMany();
  await prisma.contentRun.deleteMany();
  await prisma.product.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();
  storage = new MemoryStorage();

  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const workspace = await prisma.workspace.create({ data: { name: "one", ownerId: user.id } });
  const batch = await prisma.batch.create({ data: { workspaceId: workspace.id, name: "batch" } });
  const product = await prisma.product.create({ data: { batchId: batch.id, productName: "product" } });
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
        voiceoverPlan: {
          scriptCompilerId: "style1.elevenlabs-script.v1",
          validationProfileId: "style1.voiceover.v1",
          script: "Frozen approved narration.",
          wordCount: 3,
          selection: {},
          tts: {
            provider: "elevenlabs",
            markets: { uk: { voiceId: "voice-uk", model: "eleven-multilingual-v2", settings: { stability: 0.4 } } },
          },
        },
      }),
    },
  });
  workspaceId = workspace.id;
  contentRunId = run.id;
  await prisma.flowGeneratedImage.createMany({
    data: [
      { id: "image-1", productId: product.id, contentRunId: run.id, sceneLabel: "scene_1_store_image", mediaGenerationId: "provider-image-1", storageSha256: SHA_A, qaStatus: "APPROVED" },
      { id: "image-2", productId: product.id, contentRunId: run.id, sceneLabel: "scene_2_home_image", mediaGenerationId: "provider-image-2", storageSha256: SHA_B, qaStatus: "APPROVED" },
    ],
  });
  await prisma.flowGeneratedVideo.createMany({
    data: [
      { id: "video-1", productId: product.id, contentRunId: run.id, sceneLabel: "scene_1_store", mediaGenerationId: "provider-video-1", storageBucket: storage.bucket, storageKey: "clip-1", storageContentType: "video/mp4", storageBytes: 3, storageSha256: SHA_A, qaStatus: "APPROVED" },
      { id: "video-2", productId: product.id, contentRunId: run.id, sceneLabel: "scene_2_home", mediaGenerationId: "provider-video-2", storageBucket: storage.bucket, storageKey: "clip-2", storageContentType: "video/mp4", storageBytes: 3, storageSha256: SHA_B, qaStatus: "APPROVED" },
    ],
  });
  storage.objects.set("clip-1", { body: text.encode("aaa"), contentType: "video/mp4", bytes: 3, metadata: { sha256: SHA_A } });
  storage.objects.set("clip-2", { body: text.encode("bbb"), contentType: "video/mp4", bytes: 3, metadata: { sha256: SHA_B } });
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

function actor() {
  return { workspaceId, actorType: "service" as const, actorId: "worker" };
}

describe("runFinalOutput", () => {
  it("passes frozen per-market TTS settings through the production ElevenLabs factory path", async () => {
    const originalApiKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-api-key";
    const originalFetch = globalThis.fetch;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        text: "Frozen approved narration.",
        model_id: "eleven-multilingual-v2",
        voice_settings: { stability: 0.4 },
      });
      return new Response(text.encode("voice-bytes"), { headers: { "content-type": "audio/mpeg", "content-length": "11" } });
    });
    vi.stubGlobal("fetch", fetch);

    try {
      const result = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
        prisma,
        storage,
        probeAudio: async () => ({ durationSeconds: 16 }),
      });

      expect(result.phase).toBe("GENERATE_VOICEOVER");
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      if (originalApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = originalApiKey;
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("generates and privately persists exactly one frozen voiceover, then replays without duplicate TTS", async () => {
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));

    const first = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
      now: () => new Date("2026-08-20T20:00:00.000Z"),
    });
    const replay = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
      assembleFinalVideo: async (manifest) => ({
        bytes: text.encode("final-mp4"),
        sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
        probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
        commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
      }),
      now: () => new Date("2026-08-20T20:00:00.000Z"),
    });

    expect(first.phase).toBe("GENERATE_VOICEOVER");
    expect(replay.finalVideoId).toBe(first.finalVideoId);
    expect(generate).toHaveBeenCalledOnce();
    expect(storage.puts.filter((put) => put.mediaType === "audio")).toHaveLength(1);
    expect(storage.puts[0]).toMatchObject({ mediaType: "audio", contentType: "audio/mpeg", assetId: first.finalVideoId });
    expect(await prisma.finalVideoAsset.count({ where: { contentRunId, audioStorageKey: { not: null } } })).toBe(1);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "voiceover_generation", status: "succeeded" } })).toBe(1);
  });

  it("assembles approved hashed clips with persisted voiceover and compensates an orphan final object on DB failure", async () => {
    const final = await prisma.finalVideoAsset.create({
      data: {
        contentRunId,
        status: "VOICEOVER_READY",
        voiceoverScript: "Frozen approved narration.",
        voiceoverProvider: "elevenlabs",
        voiceoverVoiceId: "voice-uk",
        voiceoverModel: "eleven-multilingual-v2",
        audioStorageBucket: storage.bucket,
        audioStorageKey: "audio-key",
        audioContentType: "audio/mpeg",
        audioBytes: 11,
        audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
        audioDurationSeconds: 16,
      },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));
    const failingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$executeRaw") {
          const executeRaw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<number>;
          return async (...args: unknown[]) => {
            if (String(args[0]).includes("finalStorageKey")) throw new Error("simulated db failure");
            return Reflect.apply(executeRaw, target, args);
          };
        }
        if (prop !== "finalVideoAsset") return Reflect.get(target, prop, receiver);
        return new Proxy(target.finalVideoAsset, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "updateMany") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (args.data?.finalStorageKey) throw new Error("simulated db failure");
              return target.finalVideoAsset.updateMany(args);
            };
          },
        });
      },
    }) as PrismaClient;

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, { prisma: failingPrisma, storage, assembleFinalVideo: assemble })).rejects.toThrow(/simulated db failure/);

    expect(assemble).toHaveBeenCalledOnce();
    expect(storage.puts.at(-1)).toMatchObject({ mediaType: "final_video", contentType: "video/mp4", assetId: final.id });
    expect(storage.deletes).toContain(`managed-content/${workspaceId}/${contentRunId}/final/${final.id}.mp4`);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ status: "FAILED", finalStorageKey: null, failureCode: "FINAL_ASSEMBLY_FAILED" });
  });

  it("does not delete a committed voiceover object when the post-commit operation audit fails", async () => {
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));
    const failingPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "contentOperation") return Reflect.get(target, prop, receiver);
        return new Proxy(target.contentOperation, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "updateMany") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (args.data?.status === "succeeded") throw new Error("simulated audit failure");
              return target.contentOperation.updateMany(args);
            };
          },
        });
      },
    }) as PrismaClient;

    const result = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma: failingPrisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    });

    const row = await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: result.finalVideoId } });
    expect(row.audioStorageKey).toBeTruthy();
    expect(storage.objects.has(row.audioStorageKey!)).toBe(true);
    expect(storage.deletes).toHaveLength(0);
  });

  it("rechecks exact source approval after private reads and before ffmpeg assembly", async () => {
    const final = await prisma.finalVideoAsset.create({
      data: {
        contentRunId,
        status: "VOICEOVER_READY",
        voiceoverScript: "Frozen approved narration.",
        voiceoverProvider: "elevenlabs",
        voiceoverVoiceId: "voice-uk",
        voiceoverModel: "eleven-multilingual-v2",
        audioStorageBucket: storage.bucket,
        audioStorageKey: "audio-key",
        audioContentType: "audio/mpeg",
        audioBytes: 11,
        audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
        audioDurationSeconds: 16,
      },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));
    const originalGet = storage.get.bind(storage);
    storage.get = vi.fn(async (key: string) => {
      const object = await originalGet(key);
      if (key === "clip-1") {
        await prisma.flowGeneratedVideo.update({ where: { id: "video-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
      }
      return object;
    });

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, { prisma, storage, assembleFinalVideo: assemble })).rejects.toThrow(/source/i);

    expect(assemble).not.toHaveBeenCalled();
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ finalStorageKey: null });
  });

  it("rechecks source approval after TTS before storing voiceover bytes", async () => {
    const generate = vi.fn(async () => {
      await prisma.flowGeneratedVideo.update({ where: { id: "video-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
      return {
        provider: "elevenlabs" as const,
        voiceId: "voice-uk",
        modelId: "eleven-multilingual-v2",
        normalizedScript: "Frozen approved narration.",
        bytes: text.encode("voice-bytes"),
        bytesLength: 11,
        sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
        contentType: "audio/mpeg",
      };
    });

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/source/i);

    expect(generate).toHaveBeenCalledOnce();
    expect(storage.puts.filter((put) => put.mediaType === "audio")).toHaveLength(0);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { contentRunId } })).toMatchObject({ status: "FAILED", audioStorageKey: null, failureCode: "VOICEOVER_GENERATION_FAILED" });
  });

  it("deletes final object and fails final output when source approval changes during final-object storage", async () => {
    const final = await prisma.finalVideoAsset.create({
      data: {
        contentRunId,
        status: "VOICEOVER_READY",
        voiceoverScript: "Frozen approved narration.",
        voiceoverProvider: "elevenlabs",
        voiceoverVoiceId: "voice-uk",
        voiceoverModel: "eleven-multilingual-v2",
        audioStorageBucket: storage.bucket,
        audioStorageKey: "audio-key",
        audioContentType: "audio/mpeg",
        audioBytes: 11,
        audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
        audioDurationSeconds: 16,
      },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    const originalPut = storage.put.bind(storage);
    storage.put = vi.fn(async (input: PutManagedObjectInput) => {
      const stored = await originalPut(input);
      if (input.mediaType === "final_video") {
        await prisma.flowGeneratedVideo.update({ where: { id: "video-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
      }
      return stored;
    });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, { prisma, storage, assembleFinalVideo: assemble })).rejects.toThrow(/source/i);

    const finalKey = `managed-content/${workspaceId}/${contentRunId}/final/${final.id}.mp4`;
    expect(storage.deletes).toContain(finalKey);
    expect(storage.objects.has(finalKey)).toBe(false);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ status: "FAILED", finalStorageKey: null, failureCode: "FINAL_ASSEMBLY_FAILED" });
  });

  it("deletes orphan audio and fails when source approval changes during audio storage", async () => {
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));
    const originalPut = storage.put.bind(storage);
    storage.put = vi.fn(async (input: PutManagedObjectInput) => {
      const stored = await originalPut(input);
      if (input.mediaType === "audio") {
        await prisma.flowGeneratedVideo.update({ where: { id: "video-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
      }
      return stored;
    });

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
      now: () => new Date("2026-08-20T20:00:00.000Z"),
    })).rejects.toThrow(/source/i);

    const final = await prisma.finalVideoAsset.findUniqueOrThrow({ where: { contentRunId } });
    const audioKey = `managed-content/${workspaceId}/${contentRunId}/audio/${final.id}.mp3`;
    expect(storage.deletes).toContain(audioKey);
    expect(storage.objects.has(audioKey)).toBe(false);
    expect(final).toMatchObject({ status: "FAILED", audioStorageKey: null, failureCode: "VOICEOVER_GENERATION_FAILED" });
    expect(storage.puts.filter((put) => put.mediaType === "audio")).toHaveLength(1);
  });

  it("rejects final MP4 commit when the frozen assembly manifest drifts after final-object storage", async () => {
    const final = await prisma.finalVideoAsset.create({
      data: {
        contentRunId,
        status: "VOICEOVER_READY",
        voiceoverScript: "Frozen approved narration.",
        voiceoverProvider: "elevenlabs",
        voiceoverVoiceId: "voice-uk",
        voiceoverModel: "eleven-multilingual-v2",
        audioStorageBucket: storage.bucket,
        audioStorageKey: "audio-key",
        audioContentType: "audio/mpeg",
        audioBytes: 11,
        audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
        audioDurationSeconds: 16,
      },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    const originalPut = storage.put.bind(storage);
    storage.put = vi.fn(async (input: PutManagedObjectInput) => {
      const stored = await originalPut(input);
      if (input.mediaType === "final_video") {
        const run = await prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId }, select: { promptSnapshotJson: true } });
        const snapshot = JSON.parse(run.promptSnapshotJson!);
        snapshot.styleManifest.assembly.clips[0].nativeAudioMode = snapshot.styleManifest.assembly.clips[0].nativeAudioMode === "duck" ? "preserve" : "duck";
        await prisma.contentRun.update({ where: { id: contentRunId }, data: { promptSnapshotJson: JSON.stringify(snapshot) } });
      }
      return stored;
    });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, { prisma, storage, assembleFinalVideo: assemble })).rejects.toThrow(/manifest|policy|stage|source/i);

    const finalKey = `managed-content/${workspaceId}/${contentRunId}/final/${final.id}.mp4`;
    expect(storage.deletes).toContain(finalKey);
    expect(storage.objects.has(finalKey)).toBe(false);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ status: "FAILED", finalStorageKey: null, failureCode: "FINAL_ASSEMBLY_FAILED" });
  });

  it("does not reserve or spend final-output work unless the run status remains generating", async () => {
    await prisma.contentRun.update({ where: { id: contentRunId }, data: { status: "created" } });
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/not ready|found|status|stage|conflict/i);

    expect(generate).not.toHaveBeenCalled();
    expect(await prisma.finalVideoAsset.count({ where: { contentRunId } })).toBe(0);
    expect(await prisma.contentOperation.count({ where: { contentRunId } })).toBe(0);
  });

  it("replays past a committed voiceover when operation success audit failed without another TTS call", async () => {
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));
    const failingAuditPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "contentOperation") return Reflect.get(target, prop, receiver);
        return new Proxy(target.contentOperation, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "updateMany") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (args.data?.status === "succeeded") throw new Error("simulated audit failure");
              return target.contentOperation.updateMany(args);
            };
          },
        });
      },
    }) as PrismaClient;

    const first = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma: failingAuditPrisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));

    const replay = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, { prisma, storage, assembleFinalVideo: assemble });

    expect(first.phase).toBe("GENERATE_VOICEOVER");
    expect(replay.phase).toBe("GENERATE_VOICEOVER");
    expect(generate).toHaveBeenCalledOnce();
    expect(assemble).not.toHaveBeenCalled();
    expect(storage.puts.filter((put) => put.mediaType === "audio")).toHaveLength(1);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "voiceover_generation", status: "succeeded" } })).toBe(1);
  });

  it("rejects cross-workspace voiceover before provider or storage work", async () => {
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));

    await expect(runFinalOutput({ ...actor(), workspaceId: randomUUID() }, { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/workspace|not found/i);

    expect(generate).not.toHaveBeenCalled();
    expect(storage.puts).toHaveLength(0);
  });

  it("does no final work before every required scene is approved", async () => {
    await prisma.flowGeneratedImage.update({ where: { id: "image-2" }, data: { qaStatus: "NOT_QA_CHECKED" } });
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/not ready|RUN_QA|final-output/i);

    expect(generate).not.toHaveBeenCalled();
    expect(await prisma.finalVideoAsset.count({ where: { contentRunId } })).toBe(0);
  });

  it("marks ambiguous TTS failure terminal without storing audio or retrying on replay", async () => {
    const generate = vi.fn(async () => { throw new Error("provider timeout after unknown state"); });

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/provider timeout/);
    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/not ready|FAILED|failed|final-output/i);

    expect(generate).toHaveBeenCalledOnce();
    expect(storage.puts.filter((put) => put.mediaType === "audio")).toHaveLength(0);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { contentRunId } })).toMatchObject({ status: "FAILED", failureCode: "VOICEOVER_GENERATION_FAILED" });
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "voiceover_generation", status: "failed" } })).toBe(1);
  });

  it("replays past a committed assembly when operation success audit failed with one final object", async () => {
    const final = await prisma.finalVideoAsset.create({
      data: { contentRunId, status: "VOICEOVER_READY", voiceoverScript: "Frozen approved narration.", voiceoverProvider: "elevenlabs", voiceoverVoiceId: "voice-uk", voiceoverModel: "eleven-multilingual-v2", audioStorageBucket: storage.bucket, audioStorageKey: "audio-key", audioContentType: "audio/mpeg", audioBytes: 11, audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"), audioDurationSeconds: 16 },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));
    const failingAuditPrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== "contentOperation") return Reflect.get(target, prop, receiver);
        return new Proxy(target.contentOperation, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "updateMany") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (args.data?.status === "succeeded") throw new Error("simulated audit failure");
              return target.contentOperation.updateMany(args);
            };
          },
        });
      },
    }) as PrismaClient;

    const first = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, { prisma: failingAuditPrisma, storage, assembleFinalVideo: assemble });
    const replay = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root" }, { prisma, storage, runFinalQa: vi.fn(async () => ({ attemptId: "qa", contentRunId, finalVideoId: final.id, decision: "APPROVE", finalQaStatus: "APPROVED", score: 99, verdict: "ok", runStatus: "ready", providerModel: "test" })) as any });

    expect(first.phase).toBe("ASSEMBLE_FINAL");
    expect(replay.phase).toBe("ASSEMBLE_FINAL");
    expect(assemble).toHaveBeenCalledOnce();
    expect(storage.puts.filter((put) => put.mediaType === "final_video")).toHaveLength(1);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "final_assembly", status: "succeeded" } })).toBe(1);
  });

  it.each(["handheld", "large_countertop", "worn"] as const)("assembles Style 2 %s with exact ordered trims, durations, and native audio modes", async (variant) => {
    await prisma.flowGeneratedVideo.deleteMany({ where: { contentRunId } });
    await prisma.flowGeneratedImage.deleteMany({ where: { contentRunId } });
    const run = await prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId }, select: { productId: true } });
    const styleManifest = compileStyleManifest("style2", "managed-style2-v1", variant);
    await prisma.contentRun.update({
      where: { id: contentRunId },
      data: {
        style: "style2",
        promptSnapshotJson: JSON.stringify({
          objective: "create_style2_piece",
          style: "style2",
          specVersion: "managed-style2-v1",
          variant,
          styleManifest,
          modelSnapshot: { imageModel: "nano-banana-pro", videoModel: "veo-3.1-lite" },
          voiceoverPlan: {
            scriptCompilerId: "style2.validated-copy-script.v1",
            validationProfileId: "style2.voiceover-70-75-words.v1",
            script: "Frozen approved narration.",
            wordCount: 3,
            selection: {},
            tts: { provider: "elevenlabs", markets: { uk: { voiceId: "voice-uk", model: "eleven-multilingual-v2", settings: { stability: 0.4 } } } },
          },
        }),
      },
    });
    for (const slot of styleManifest.slots) {
      const bytes = text.encode(`${variant}-${slot.id}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (slot.mediaType === "video") {
        await prisma.flowGeneratedVideo.create({ data: { id: `${variant}-${slot.id}-video`, productId: run.productId, contentRunId, sceneLabel: slot.id, mediaGenerationId: `${variant}-${slot.id}`, storageBucket: storage.bucket, storageKey: `${variant}-${slot.id}`, storageContentType: "video/mp4", storageBytes: bytes.byteLength, storageSha256: digest, qaStatus: "APPROVED" } });
        storage.objects.set(`${variant}-${slot.id}`, { body: bytes, contentType: "video/mp4", bytes: bytes.byteLength, metadata: { sha256: digest } });
      } else {
        await prisma.flowGeneratedImage.create({ data: { id: `${variant}-${slot.id}-image`, productId: run.productId, contentRunId, sceneLabel: slot.id, mediaGenerationId: `${variant}-${slot.id}`, storageSha256: digest, qaStatus: "APPROVED" } });
      }
    }
    const audioHash = createHash("sha256").update(text.encode("voice-bytes")).digest("hex");
    const final = await prisma.finalVideoAsset.create({ data: { contentRunId, status: "VOICEOVER_READY", voiceoverScript: "Frozen approved narration.", voiceoverProvider: "elevenlabs", voiceoverVoiceId: "voice-uk", voiceoverModel: "eleven-multilingual-v2", audioStorageBucket: storage.bucket, audioStorageKey: "audio-key", audioContentType: "audio/mpeg", audioBytes: 11, audioSha256: audioHash, audioDurationSeconds: styleManifest.assembly.output.finalDurationSeconds } });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    let captured: unknown = null;
    const assemble = vi.fn(async (manifest: AssemblyManifest) => {
      captured = manifest;
      return {
        bytes: text.encode("final-mp4"),
        sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
        probe: { durationSeconds: styleManifest.assembly.output.finalDurationSeconds, video: { width: styleManifest.assembly.output.width, height: styleManifest.assembly.output.height, codec: styleManifest.finalOutput.videoCodec, pixelFormat: "yuv420p", fps: styleManifest.assembly.output.fps }, audio: { codec: styleManifest.finalOutput.audioCodec, channels: 2 }, formatName: "mov,mp4" },
        commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
      };
    });

    const result = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: `root-${variant}` }, { prisma, storage, assembleFinalVideo: assemble });

    expect(result).toMatchObject({ phase: "ASSEMBLE_FINAL", finalVideoId: final.id });
    expect(captured).not.toBeNull();
    const capturedManifest = captured as AssemblyManifest;
    expect(capturedManifest.clips.map(({ order, slotId, trimStartSeconds, trimEndSeconds, durationSeconds, nativeAudioMode }) => ({ order, slotId, trimStartSeconds, trimEndSeconds, durationSeconds, nativeAudioMode }))).toEqual(styleManifest.assembly.clips);
    expect(storage.puts.filter((put) => put.mediaType === "final_video")).toHaveLength(1);
  });

  async function createMediaValidatedFinal(
    finalBytes = text.encode("persisted-final-mp4"),
    runStatus: "generating" | "qa_running" = "qa_running",
  ) {
    const styleManifest = compileStyleManifest("style1", "managed-style1-v1", "store_discovery");
    const manifest: AssemblyManifest = {
      version: "assembly-manifest-v1",
      clips: [
        { ...styleManifest.assembly.clips[0], assetId: "video-1", assetSha256: SHA_A, approvalStatus: "APPROVED" },
        { ...styleManifest.assembly.clips[1], assetId: "video-2", assetSha256: SHA_B, approvalStatus: "APPROVED" },
      ],
      audio: { assetId: "audio-1", assetSha256: SHA_A, durationSeconds: 16 },
      output: { width: 1080, height: 1920, fps: 30, voiceoverGainDb: 0, nativeAudioGainDb: -18, duckingThresholdDb: -24, expectedDurationSeconds: 16 },
      ffmpegVersion: "7.1.1",
    };
    const finalSha256 = createHash("sha256").update(finalBytes).digest("hex");
    const final = await prisma.finalVideoAsset.create({
      data: { contentRunId, status: "MEDIA_VALIDATED", voiceoverScript: "Frozen approved narration.", voiceoverProvider: "elevenlabs", voiceoverVoiceId: "voice-uk", voiceoverModel: "eleven-multilingual-v2", audioStorageBucket: storage.bucket, audioStorageKey: "audio-key", audioContentType: "audio/mpeg", audioBytes: 11, audioSha256: SHA_A, audioDurationSeconds: 16, assemblyManifestJson: JSON.stringify(manifest), finalStorageBucket: storage.bucket, finalStorageKey: "final-key", finalContentType: "video/mp4", finalBytes: finalBytes.byteLength, finalSha256, finalDurationSeconds: 16, finalWidth: 1080, finalHeight: 1920, finalVideoCodec: "h264", finalAudioCodec: "aac", mediaValidationPassed: true, mediaValidatedAt: new Date("2026-08-20T20:00:00.000Z") },
    });
    storage.objects.set("final-key", { body: finalBytes, contentType: "video/mp4", bytes: finalBytes.byteLength, metadata: {} });
    await prisma.contentRun.update({ where: { id: contentRunId }, data: { status: runStatus } });
    return final;
  }

  function acceptedFinalQaDependencies(visualResult: FinalVisualQaResult, finalBytes = text.encode("persisted-final-mp4")) {
    return {
      prisma,
      storage,
      probeMedia: vi.fn(async () => ({ formatName: "mp4", durationSeconds: 16, streams: [{ type: "video" as const, codecName: "h264", width: 1080, height: 1920, averageFrameRate: 30 }, { type: "audio" as const, codecName: "aac", durationSeconds: 16, channels: 2 }] })),
      analyzeAudio: vi.fn(async () => ({ leadingSilenceSeconds: 0.1, trailingSilenceSeconds: 0.1, clippedSampleCount: 0 })),
      extractFrames: vi.fn(async () => [{ timestampMs: 0, data: "ZmFrZS1qcGVn", mediaType: "image/jpeg" as const }]),
      visualProvider: { identifier: "test:vision", evaluateFinal: vi.fn(async () => ({ result: visualResult, providerModel: "test-vision-v1", elapsedMs: 12 })) },
      now: () => new Date("2026-08-20T20:01:00.000Z"),
    } as any;
  }

  it("atomically enters final QA from a generating run with validated final media", async () => {
    const final = await createMediaValidatedFinal(text.encode("persisted-final-mp4"), "generating");
    const deps = acceptedFinalQaDependencies({
      overallScore: 94,
      hasHardFailure: false,
      checks: FINAL_RUBRIC.map((criterion) => ({ name: criterion.name, passed: true, score: 94 })),
      issues: [],
    });

    const result = await runFinalOutput(
      actor(),
      { contentRunId, idempotencyRoot: "root-enter-final-qa" },
      deps,
    );

    expect(result).toMatchObject({ phase: "RUN_FINAL_QA", status: "ready", finalVideoId: final.id });
    expect(deps.visualProvider.evaluateFinal).toHaveBeenCalledOnce();
    expect(await prisma.qaAttempt.count({ where: { finalVideoId: final.id } })).toBe(1);
    expect(await prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } })).toMatchObject({ status: "ready" });
  });

  it.each([
    ["APPROVE", "ready", "APPROVED", { overallScore: 94, hasHardFailure: false, checks: FINAL_RUBRIC.map((criterion) => ({ name: criterion.name, passed: true, score: 94 })), issues: [] }],
    ["HUMAN_REVIEW", "human_review", "HUMAN_REVIEW", { overallScore: 50, hasHardFailure: true, checks: FINAL_RUBRIC.map((criterion, index) => ({ name: criterion.name, passed: index !== 0, score: index === 0 ? 20 : 94, ...(index === 0 ? { severity: "major" as const } : {}) })), issues: [] }],
  ] as const)("orchestrates accepted final QA service %s without direct DB mutation", async (_decision, runStatus, finalQaStatus, visualResult) => {
    const final = await createMediaValidatedFinal();
    const deps = acceptedFinalQaDependencies(visualResult as FinalVisualQaResult);

    const result = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: `root-${runStatus}` }, deps);

    expect(result).toMatchObject({ phase: "RUN_FINAL_QA", status: runStatus, finalVideoId: final.id });
    expect(deps.visualProvider.evaluateFinal).toHaveBeenCalledOnce();
    expect(await prisma.qaAttempt.count({ where: { finalVideoId: final.id } })).toBe(1);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ status: finalQaStatus, finalQaStatus });
  });

  it("orchestrates accepted final QA infrastructure failure as FAILED without false READY", async () => {
    const final = await createMediaValidatedFinal();

    const result = await runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-failed-qa" }, {
      prisma,
      storage,
      probeMedia: vi.fn(async () => { throw new Error("ffprobe exploded"); }),
      analyzeAudio: vi.fn(),
      extractFrames: vi.fn(),
      visualProvider: { identifier: "test:vision", evaluateFinal: vi.fn() },
      now: () => new Date("2026-08-20T20:01:00.000Z"),
    } as any);

    expect(result).toMatchObject({ phase: "RUN_FINAL_QA", status: "failed", finalVideoId: final.id });
    expect(await prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } })).toMatchObject({ status: "failed" });
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ status: "FAILED", finalQaStatus: "FAILED" });
    expect(await prisma.qaAttempt.count({ where: { finalVideoId: final.id } })).toBe(1);
  });

  it("atomically rejects operation reservation when run status changes after projection", async () => {
    let raced = false;
    const racePrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$executeRaw") {
          const executeRaw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<number>;
          return async (...args: unknown[]) => {
            if (!raced && String(args[0]).includes("ContentOperation")) {
              raced = true;
              await target.contentRun.update({ where: { id: contentRunId }, data: { status: "created" } });
            }
            return Reflect.apply(executeRaw, target, args);
          };
        }
        if (prop !== "contentOperation") return Reflect.get(target, prop, receiver);
        return new Proxy(target.contentOperation, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "create") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (!raced) {
                raced = true;
                await target.contentRun.update({ where: { id: contentRunId }, data: { status: "created" } });
              }
              return target.contentOperation.create(args);
            };
          },
        });
      },
    }) as PrismaClient;
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-race-reserve" }, {
      prisma: racePrisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/status|stage|conflict|eligible/i);

    expect(raced).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(storage.puts).toHaveLength(0);
    expect(await prisma.contentOperation.count({ where: { contentRunId } })).toBe(0);
  });

  it("rejects voiceover spend when run status changes after reservation before mark-running", async () => {
    let raced = false;
    const racePrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$executeRaw") {
          const executeRaw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<number>;
          return async (...args: unknown[]) => {
            if (!raced && String(args[0]).includes("UPDATE") && String(args[0]).includes("ContentOperation")) {
              raced = true;
              await target.contentRun.update({ where: { id: contentRunId }, data: { status: "created" } });
            }
            return Reflect.apply(executeRaw, target, args);
          };
        }
        if (prop !== "contentOperation") return Reflect.get(target, prop, receiver);
        return new Proxy(target.contentOperation, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "updateMany") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (!raced && args.data?.status === "running") {
                raced = true;
                await target.contentRun.update({ where: { id: contentRunId }, data: { status: "created" } });
              }
              return target.contentOperation.updateMany(args);
            };
          },
        });
      },
    }) as PrismaClient;
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-race-mark-voiceover" }, {
      prisma: racePrisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => ({ durationSeconds: 16 }),
    })).rejects.toThrow(/status|stage|eligible|changed/i);

    expect(raced).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(storage.puts).toHaveLength(0);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "voiceover_generation", status: "running" } })).toBe(0);
  });

  it("rejects assembly spend when run status changes after reservation before mark-running", async () => {
    await prisma.finalVideoAsset.create({
      data: { contentRunId, status: "VOICEOVER_READY", voiceoverScript: "Frozen approved narration.", voiceoverProvider: "elevenlabs", voiceoverVoiceId: "voice-uk", voiceoverModel: "eleven-multilingual-v2", audioStorageBucket: storage.bucket, audioStorageKey: "audio-key", audioContentType: "audio/mpeg", audioBytes: 11, audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"), audioDurationSeconds: 16 },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    let raced = false;
    const racePrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$executeRaw") {
          const executeRaw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<number>;
          return async (...args: unknown[]) => {
            if (!raced && String(args[0]).includes("UPDATE") && String(args[0]).includes("ContentOperation")) {
              raced = true;
              await target.contentRun.update({ where: { id: contentRunId }, data: { status: "created" } });
            }
            return Reflect.apply(executeRaw, target, args);
          };
        }
        if (prop !== "contentOperation") return Reflect.get(target, prop, receiver);
        return new Proxy(target.contentOperation, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "updateMany") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (!raced && args.data?.status === "running") {
                raced = true;
                await target.contentRun.update({ where: { id: contentRunId }, data: { status: "created" } });
              }
              return target.contentOperation.updateMany(args);
            };
          },
        });
      },
    }) as PrismaClient;
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-race-mark-assembly" }, { prisma: racePrisma, storage, assembleFinalVideo: assemble })).rejects.toThrow(/status|stage|eligible|changed/i);

    expect(raced).toBe(true);
    expect(assemble).not.toHaveBeenCalled();
    expect(storage.puts.filter((put) => put.mediaType === "final_video")).toHaveLength(0);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "final_assembly", status: "running" } })).toBe(0);
  });

  it("deletes orphan audio and fails when source approval changes during audio probe before commit", async () => {
    const generate = vi.fn(async () => ({
      provider: "elevenlabs" as const,
      voiceId: "voice-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: "Frozen approved narration.",
      bytes: text.encode("voice-bytes"),
      bytesLength: 11,
      sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"),
      contentType: "audio/mpeg",
    }));

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-probe-race" }, {
      prisma,
      storage,
      voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }),
      probeAudio: async () => {
        await prisma.flowGeneratedVideo.update({ where: { id: "video-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
        return { durationSeconds: 16 };
      },
      now: () => new Date("2026-08-20T20:00:00.000Z"),
    })).rejects.toThrow(/source|conflict|approval/i);

    const final = await prisma.finalVideoAsset.findUniqueOrThrow({ where: { contentRunId } });
    const audioKey = `managed-content/${workspaceId}/${contentRunId}/audio/${final.id}.mp3`;
    expect(storage.deletes).toContain(audioKey);
    expect(storage.objects.has(audioKey)).toBe(false);
    expect(final).toMatchObject({ status: "FAILED", audioStorageKey: null, failureCode: "VOICEOVER_GENERATION_FAILED" });
  });

  it("deletes orphan final object and fails when source approval changes at final MP4 commit", async () => {
    const final = await prisma.finalVideoAsset.create({
      data: { contentRunId, status: "VOICEOVER_READY", voiceoverScript: "Frozen approved narration.", voiceoverProvider: "elevenlabs", voiceoverVoiceId: "voice-uk", voiceoverModel: "eleven-multilingual-v2", audioStorageBucket: storage.bucket, audioStorageKey: "audio-key", audioContentType: "audio/mpeg", audioBytes: 11, audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"), audioDurationSeconds: 16 },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));
    let raced = false;
    const racePrisma = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$executeRaw") {
          const executeRaw = Reflect.get(target, prop, receiver) as (...args: unknown[]) => Promise<number>;
          return async (...args: unknown[]) => {
            if (!raced && String(args[0]).includes("finalStorageKey")) {
              raced = true;
              await target.flowGeneratedVideo.update({ where: { id: "video-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
            }
            return Reflect.apply(executeRaw, target, args);
          };
        }
        if (prop !== "finalVideoAsset") return Reflect.get(target, prop, receiver);
        return new Proxy(target.finalVideoAsset, {
          get(delegate, delegateProp, delegateReceiver) {
            if (delegateProp !== "updateMany") return Reflect.get(delegate, delegateProp, delegateReceiver);
            return async (args: any) => {
              if (!raced && args.data?.finalStorageKey) {
                raced = true;
                await target.flowGeneratedVideo.update({ where: { id: "video-1" }, data: { qaStatus: "HUMAN_REVIEW" } });
              }
              return target.finalVideoAsset.updateMany(args);
            };
          },
        });
      },
    }) as PrismaClient;

    await expect(runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-final-commit-race" }, { prisma: racePrisma, storage, assembleFinalVideo: assemble })).rejects.toThrow(/source|conflict|approval/i);

    const finalKey = `managed-content/${workspaceId}/${contentRunId}/final/${final.id}.mp4`;
    expect(raced).toBe(true);
    expect(storage.deletes).toContain(finalKey);
    expect(storage.objects.has(finalKey)).toBe(false);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ status: "FAILED", finalStorageKey: null, failureCode: "FINAL_ASSEMBLY_FAILED" });
  });

  it("competing voiceover calls produce one TTS call, one audio object, and replay the same final output", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async () => {
      await gate;
      return { provider: "elevenlabs" as const, voiceId: "voice-uk", modelId: "eleven-multilingual-v2", normalizedScript: "Frozen approved narration.", bytes: text.encode("voice-bytes"), bytesLength: 11, sha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"), contentType: "audio/mpeg" };
    });

    const assemble = vi.fn(async (manifest: AssemblyManifest) => ({
      bytes: text.encode("final-mp4"),
      sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"),
      probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" },
      commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) },
    }));

    const calls = [
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-concurrent-vo" }, { prisma, storage, voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }), probeAudio: async () => ({ durationSeconds: 16 }), assembleFinalVideo: assemble }),
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-concurrent-vo" }, { prisma, storage, voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate }), probeAudio: async () => ({ durationSeconds: 16 }), assembleFinalVideo: assemble }),
    ];
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all(calls);

    expect(new Set(results.map((result) => result.finalVideoId)).size).toBe(1);
    expect(results.every((result) => result.phase === "GENERATE_VOICEOVER" && result.status === "VOICEOVER_READY")).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(assemble).not.toHaveBeenCalled();
    expect(storage.puts.filter((put) => put.mediaType === "audio")).toHaveLength(1);
    expect(storage.puts.filter((put) => put.mediaType === "final_video")).toHaveLength(0);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "voiceover_generation" } })).toBe(1);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "final_assembly" } })).toBe(0);
  });

  it("competing assembly calls produce one ffmpeg run, one final object, and replay the same final output", async () => {
    const final = await prisma.finalVideoAsset.create({
      data: { contentRunId, status: "VOICEOVER_READY", voiceoverScript: "Frozen approved narration.", voiceoverProvider: "elevenlabs", voiceoverVoiceId: "voice-uk", voiceoverModel: "eleven-multilingual-v2", audioStorageBucket: storage.bucket, audioStorageKey: "audio-key", audioContentType: "audio/mpeg", audioBytes: 11, audioSha256: createHash("sha256").update(text.encode("voice-bytes")).digest("hex"), audioDurationSeconds: 16 },
    });
    storage.objects.set("audio-key", { body: text.encode("voice-bytes"), contentType: "audio/mpeg", bytes: 11, metadata: {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const assemble = vi.fn(async (manifest: AssemblyManifest) => {
      await gate;
      return { bytes: text.encode("final-mp4"), sha256: createHash("sha256").update(text.encode("final-mp4")).digest("hex"), probe: { durationSeconds: 16, video: { width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 30 }, audio: { codec: "aac", channels: 2 }, formatName: "mov,mp4" }, commandManifest: { ffmpeg: { binary: "ffmpeg", args: [] }, filterGraph: "deterministic", inputs: manifest.clips.map((clip) => ({ assetId: clip.assetId, slotId: clip.slotId, sha256: clip.assetSha256, trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds } })), audioModes: manifest.clips.map((clip) => clip.nativeAudioMode) } };
    });

    const runFinalQa = vi.fn(async () => { throw new Error("unexpected downstream final QA"); });
    const calls = [
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-concurrent-assembly" }, { prisma, storage, assembleFinalVideo: assemble, runFinalQa: runFinalQa as any }),
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-concurrent-assembly" }, { prisma, storage, assembleFinalVideo: assemble, runFinalQa: runFinalQa as any }),
    ];
    await vi.waitFor(() => expect(assemble).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all(calls);

    expect(new Set(results.map((result) => result.finalVideoId))).toEqual(new Set([final.id]));
    expect(results.every((result) => result.phase === "ASSEMBLE_FINAL" && result.status === "MEDIA_VALIDATED")).toBe(true);
    expect(assemble).toHaveBeenCalledOnce();
    expect(runFinalQa).not.toHaveBeenCalled();
    expect(storage.puts.filter((put) => put.mediaType === "final_video")).toHaveLength(1);
    expect(await prisma.contentOperation.count({ where: { contentRunId, kind: "final_assembly" } })).toBe(1);
    expect(await prisma.qaAttempt.count({ where: { finalVideoId: final.id } })).toBe(0);
  });

  it("competing final QA calls atomically enter from generating, produce one accepted-service attempt, and no false READY", async () => {
    const final = await createMediaValidatedFinal(text.encode("persisted-final-mp4"), "generating");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const deps = acceptedFinalQaDependencies({ overallScore: 94, hasHardFailure: false, checks: FINAL_RUBRIC.map((criterion) => ({ name: criterion.name, passed: true, score: 94 })), issues: [] });
    const evaluate = deps.visualProvider.evaluateFinal;
    deps.visualProvider.evaluateFinal = vi.fn(async (...args: any[]) => {
      await gate;
      return evaluate(...args);
    });

    const calls = [
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-concurrent-qa" }, deps),
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-concurrent-qa" }, deps),
    ];
    await vi.waitFor(() => expect(deps.visualProvider.evaluateFinal).toHaveBeenCalledOnce());
    release();
    const results = await Promise.all(calls);

    expect(results.every((result) => result.finalVideoId === final.id)).toBe(true);
    expect(deps.visualProvider.evaluateFinal).toHaveBeenCalledOnce();
    expect(await prisma.qaAttempt.count({ where: { finalVideoId: final.id } })).toBe(1);
    expect(await prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } })).toMatchObject({ status: "ready" });
  });

  it("replays a slow winner to a stale final QA contender after the evaluator returns immediately", async () => {
    const final = await createMediaValidatedFinal(text.encode("persisted-final-mp4"), "generating");
    const deps = acceptedFinalQaDependencies({ overallScore: 94, hasHardFailure: false, checks: FINAL_RUBRIC.map((criterion) => ({ name: criterion.name, passed: true, score: 94 })), issues: [] });
    deps.extractFrames = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      return [{ timestampMs: 0, data: "ZmFrZS1qcGVn", mediaType: "image/jpeg" as const }];
    });

    const results = await Promise.all([
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-fast-final-qa" }, deps),
      runFinalOutput(actor(), { contentRunId, idempotencyRoot: "root-fast-final-qa" }, deps),
    ]);

    expect(results).toEqual([
      { phase: "RUN_FINAL_QA", status: "ready", finalVideoId: final.id },
      { phase: "RUN_FINAL_QA", status: "ready", finalVideoId: final.id },
    ]);
    expect(deps.visualProvider.evaluateFinal).toHaveBeenCalledOnce();
    expect(await prisma.qaAttempt.count({ where: { finalVideoId: final.id } })).toBe(1);
    expect(await prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: final.id } })).toMatchObject({ status: "APPROVED", finalQaStatus: "APPROVED" });
    expect(await prisma.contentRun.findUniqueOrThrow({ where: { id: contentRunId } })).toMatchObject({ status: "ready" });
  });
});
