import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { SLOT_DEFINITIONS } from "@/lib/content-runs/constants";
import { vi } from "vitest";
import type { ObjectStorage, PutManagedObjectInput, ReadObjectResult, StoredObjectMetadata } from "@/lib/storage";

export type AcceptanceStyle =
  | { styleId: "style1"; variant: "store_discovery" }
  | { styleId: "style2"; variant: "handheld" | "large_countertop" | "worn" };

const databasePath = resolve(tmpdir(), `managed-ready-to-post-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
process.env.DATABASE_URL = databaseUrl;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const mediaDir = mkdtempSync(join(tmpdir(), "ready-to-post-fixtures-"));
let initialized = false;
let modulesPromise: ReturnType<typeof loadModules> | null = null;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeSyntheticMedia() {
  const clipPath = join(mediaDir, "synthetic-source.mp4");
  const voicePath = join(mediaDir, "synthetic-voice.wav");
  execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x275d8c:s=108x192:r=5:d=8",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=8",
    "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", clipPath,
  ]);
  execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
    "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=30", "-c:a", "pcm_s16le", voicePath,
  ]);
  return {
    clip: new Uint8Array(readFileSync(clipPath)),
    voice: new Uint8Array(readFileSync(voicePath)),
  };
}

const media = makeSyntheticMedia();

class DeterministicPrivateStorage implements ObjectStorage {
  readonly bucket = "acceptance-private";
  readonly objects = new Map<string, ReadObjectResult>();
  readonly puts: PutManagedObjectInput[] = [];
  readonly deletes: string[] = [];

  async put(input: PutManagedObjectInput): Promise<StoredObjectMetadata> {
    const directory = input.mediaType === "audio" ? "audio" : input.mediaType === "final_video" ? "final" : `${input.mediaType}s`;
    const key = `managed-content/${input.workspaceId}/${input.contentRunId}/${directory}/${input.assetId}.${input.extension.replace(/^\./, "")}`;
    const metadata = { bucket: this.bucket, key, contentType: input.contentType, bytes: input.body.byteLength, sha256: sha256(input.body) };
    this.puts.push({ ...input, body: new Uint8Array(input.body) });
    this.objects.set(key, { body: new Uint8Array(input.body), contentType: input.contentType, bytes: input.body.byteLength, metadata: { sha256: metadata.sha256, visibility: "private" } });
    return metadata;
  }

  async get(key: string): Promise<ReadObjectResult> {
    const value = this.objects.get(key);
    if (!value) throw new Error(`private object not found: ${key}`);
    return { ...value, body: new Uint8Array(value.body) };
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  async createSignedReadUrl(key: string): Promise<string> {
    if (!this.objects.has(key)) throw new Error(`cannot sign missing private object: ${key}`);
    return `memory-private://${encodeURIComponent(key)}?expires=300`;
  }
}

async function loadModules() {
  return Promise.all([
    import("@/lib/content-runs/create-run"),
    import("@/lib/content-generation/generate-image"),
    import("@/lib/content-generation/generate-video"),
    import("@/lib/content-runs/run-managed-qa"),
    import("@/lib/final-output/run-final-output"),
    import("@/lib/qa/final-rubric"),
    import("@/lib/media/probe-media"),
    import("@/lib/media/assemble-final-video"),
  ]);
}

async function waitForCallCount(readCount: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (readCount() < expected) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for acceptance call ${expected}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  return { promise, release };
}

async function setupDatabase() {
  if (initialized) return;
  const prismaCli = fileURLToPath(import.meta.resolve("prisma/build/index.js"));
  execFileSync(process.execPath, [prismaCli, "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe",
  });
  initialized = true;
  modulesPromise = loadModules();
  await modulesPromise;
}

async function resetDatabase() {
  await prisma.workspaceProviderLock.deleteMany();
  await prisma.qaAttempt.deleteMany();
  await prisma.finalVideoAsset.deleteMany();
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
}

const voiceover70 = Array.from({ length: 70 }, (_, index) => `word${index + 1}`).join(" ");

function compilerInput(input: AcceptanceStyle, productReferenceId: string, garmentReferenceId: string) {
  if (input.styleId === "style1") {
    return {
      styleId: "style1" as const,
      version: "managed-style1-v1" as const,
      variant: "store_discovery" as const,
      productReferenceImageId: productReferenceId,
      style1Kit: {
        productName: "Portable Blender",
        market: "UK" as const,
        category: "Kitchen/Food" as const,
        copy: {
          part1Options: ["WAIT, this Portable Blender deal is worth checking before your next busy morning."],
          part2Options: ["It makes quick smoothies feel simple at home, and the basket voucher is available today."],
          part3Options: ["Tap the basket"],
        },
        hashtags: ["#tiktokshopuk", "#AIGC"],
        productDescription: "A compact blender.", discountPercent: 20, warnings: [],
      },
    };
  }
  const worn = input.variant === "worn";
  return {
    styleId: "style2" as const,
    version: "managed-style2-v1" as const,
    variant: input.variant,
    productName: "Portable Blender",
    productType: worn ? "clothing_fashion_shoes" as const : "skincare_beauty_makeup_haircare" as const,
    productForm: worn ? "worn" as const : input.variant === "large_countertop" ? "large_countertop" as const : "serum" as const,
    productCount: 1 as const,
    characterReferenceId: "registered-character-acceptance",
    productReferenceId: worn ? null : productReferenceId,
    garmentReferenceId: worn ? garmentReferenceId : null,
    seed: 20260821,
    recentSceneHashes: [],
    copy: {
      market: "UK" as const,
      hook_text: "WAIT, the basket voucher is live",
      benefit_text: "Soft glide, easy routine feel",
      cta_text: "Tap the basket voucher today",
      voiceover: voiceover70,
    },
  };
}

async function seedEligibleProduct() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@acceptance.test` } });
  const workspace = await prisma.workspace.create({ data: { name: "acceptance", ownerId: user.id } });
  const batch = await prisma.batch.create({ data: { workspaceId: workspace.id, name: "Friday", market: "uk" } });
  const product = await prisma.product.create({
    data: { batchId: batch.id, productName: "Portable Blender", category: "kitchen", market: "uk", reviewStatus: "approved", discountPercent: 20, discountType: "sale" },
  });
  const primary = await prisma.productImage.create({ data: { productId: product.id, role: "primary", url: "https://fixture.invalid/primary.png", source: "upload", width: 108, height: 192, bytes: PNG_BYTES.byteLength } });
  const garment = await prisma.productImage.create({ data: { productId: product.id, role: "ref2", url: "https://fixture.invalid/garment.png", source: "upload", width: 108, height: 192, bytes: PNG_BYTES.byteLength } });
  await prisma.workspaceSettings.create({ data: { workspaceId: workspace.id, flowEmail: "flow@acceptance.test", flowImageModel: "nano-banana-pro", flowVideoModel: "veo-3.1-lite-low-priority", elevenLabsVoiceIdUk: "voice-acceptance-uk" } });
  return { workspace, product, primary, garment };
}

function apexAdapter() {
  let job = 0;
  return {
    getCharacter: vi.fn(async ({ characterReferenceId }: { characterReferenceId: string }) => ({ characterReferenceId, entityId: "character-entity-acceptance" })),
    uploadAsset: vi.fn(async () => ({ mediaGenerationId: "uploaded-reference", kind: "image" as const, mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength })),
    generateImage: vi.fn(async () => ({ mediaGenerationId: `image-${++job}`, url: `fixture://image/${job}` })),
    startVideo: vi.fn(async () => ({ providerJobId: `video-job-${++job}` })),
    pollVideo: vi.fn(async ({ providerJobId }: { providerJobId: string }) => ({ status: "succeeded" as const, providerJobId, mediaGenerationId: `media-${providerJobId}`, url: `fixture://video/${providerJobId}` })),
    resolveAssetUrl: vi.fn(),
  };
}

function fetchFixture(url: string) {
  const isVideo = url.startsWith("fixture://video/");
  const bytes = isVideo ? media.clip : PNG_BYTES;
  return Promise.resolve(new Response(bytes, { headers: { "content-type": isVideo ? "video/mp4" : "image/png", "content-length": String(bytes.byteLength) } }));
}

async function approveSceneAsset(assetId: string, assetKind: "image" | "video") {
  const data = { qaStatus: "APPROVED", qaScore: 98, qaVerdictJson: JSON.stringify({ decision: "APPROVE", score: 98 }) };
  if (assetKind === "image") await prisma.flowGeneratedImage.update({ where: { id: assetId }, data });
  else await prisma.flowGeneratedVideo.update({ where: { id: assetId }, data });
  await prisma.qaAttempt.create({
    data: {
      ...(assetKind === "image" ? { imageId: assetId } : { videoId: assetId }),
      assetType: assetKind === "image" ? "MANAGED_IMAGE" : "MANAGED_VIDEO",
      attemptNumber: 1, rubricVersion: "managed-scene-qa-v1", providerModel: "fake-visual-qa-v1",
      framesJson: assetKind === "video" ? JSON.stringify({ frameCount: 1, timestampsMs: [0] }) : null,
      resultJson: JSON.stringify({ decision: "APPROVE", score: 98 }), decision: "APPROVE", overallScore: 98, hasHardFailure: false,
    },
  });
  return { assetId, assetKind, decision: "APPROVE" as const, qaStatus: "APPROVED" as const };
}

export async function runReadyToPostScenario(input: AcceptanceStyle) {
  await setupDatabase();
  await resetDatabase();
  const [createRunModule, imageModule, videoModule, qaModule, finalModule, rubricModule, probeModule, assemblyModule] = await modulesPromise!;
  const storage = new DeterministicPrivateStorage();
  const seeded = await seedEligibleProduct();
  const adapter = apexAdapter();
  const run = await createRunModule.createManagedContentRun({
    workspaceId: seeded.workspace.id,
    productId: seeded.product.id,
    idempotencyKey: `acceptance-${input.styleId}-${input.variant}`,
    styleId: input.styleId,
    compilerInput: compilerInput(input, seeded.primary.id, seeded.garment.id) as never,
  }, { createAdapter: () => adapter as never });
  const frozenSnapshot = JSON.parse(run.promptSnapshotJson!);
  const frozenSnapshotBytes = run.promptSnapshotJson!;
  const actor = { workspaceId: seeded.workspace.id, actorType: "service" as const, actorId: "acceptance-harness" };

  for (const slot of frozenSnapshot.styleManifest.slots as Array<{ id: string; mediaType: "image" | "video" }>) {
    let result: any;
    const command = { contentRunId: run.id, slot: slot.id, idempotencyKey: `${run.id}:${slot.id}` };
    const deps = { prisma, objectStorage: storage, createAdapter: () => adapter as never, fetchMedia: fetchFixture };
    if (slot.mediaType === "image") {
      result = await imageModule.generateManagedImage(actor, command as never, deps);
    } else {
      await videoModule.generateManagedVideo(actor, command as never, deps);
      result = await videoModule.generateManagedVideo(actor, command as never, deps);
    }
    await qaModule.runManagedQa(actor, { contentRunId: run.id, assetId: result.asset.id, assetKind: slot.mediaType }, {
      prisma,
      runQa: async () => approveSceneAsset(result.asset.id, slot.mediaType) as never,
    });
  }

  const manifest = frozenSnapshot.styleManifest;
  const voiceoverGate = deferred();
  const assemblyGate = deferred();
  const finalQaGate = deferred();
  const tts = vi.fn(async () => {
    await voiceoverGate.promise;
    return {
    provider: "elevenlabs" as const,
    voiceId: "voice-acceptance-uk",
    modelId: "eleven-multilingual-v2",
    normalizedScript: frozenSnapshot.voiceoverPlan.script,
    bytes: media.voice,
    bytesLength: media.voice.byteLength,
    sha256: sha256(media.voice),
    contentType: "audio/wav" as const,
    };
  });
  const visualProvider = {
    identifier: "fake-final-visual-qa-v1",
    evaluateFinal: vi.fn(async () => {
      await finalQaGate.promise;
      return {
      result: { overallScore: 96, hasHardFailure: false, checks: rubricModule.FINAL_RUBRIC.map((criterion) => ({ name: criterion.name, passed: true, score: 96 })), issues: [] },
      providerModel: "fake-final-visual-qa-v1", elapsedMs: 1,
      };
    }),
  };
  const assembleFinalVideo = vi.fn(async (...args: Parameters<typeof assemblyModule.assembleFinalVideo>) => {
    await assemblyGate.promise;
    return assemblyModule.assembleFinalVideo(...args);
  });
  const finalDeps: any = {
    prisma, storage,
    voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate: tts }),
    probeAudio: async () => ({ durationSeconds: manifest.assembly.output.finalDurationSeconds }),
    visualProvider, assembleFinalVideo,
    ffmpegVersion: "acceptance-real-ffmpeg",
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  };
  const phases = [];
  const concurrentPhases = [];
  let assemblyManifestBytesAfterAssembly: string | null = null;
  for (let phaseIndex = 0; phaseIndex < 3; phaseIndex += 1) {
    const calls = [
      finalModule.runFinalOutput(actor, { contentRunId: run.id, idempotencyRoot: `final-${run.id}` }, finalDeps),
      finalModule.runFinalOutput(actor, { contentRunId: run.id, idempotencyRoot: `final-${run.id}` }, finalDeps),
    ];
    if (phaseIndex === 0) {
      await waitForCallCount(() => tts.mock.calls.length, 1);
      voiceoverGate.release();
    } else if (phaseIndex === 1) {
      await waitForCallCount(() => assembleFinalVideo.mock.calls.length, 1);
      assemblyGate.release();
    } else {
      await waitForCallCount(() => visualProvider.evaluateFinal.mock.calls.length, 1);
      finalQaGate.release();
    }
    const pair = await Promise.all(calls);
    if (phaseIndex === 1) {
      assemblyManifestBytesAfterAssembly = (await prisma.finalVideoAsset.findUniqueOrThrow({
        where: { contentRunId: run.id },
        select: { assemblyManifestJson: true },
      })).assemblyManifestJson;
    }
    concurrentPhases.push(pair);
    phases.push(pair[0]);
  }
  const replay = await finalModule.runFinalOutput(actor, { contentRunId: run.id, idempotencyRoot: `final-${run.id}` }, finalDeps);

  const persistedRun = await prisma.contentRun.findUniqueOrThrow({ where: { id: run.id } });
  const final = await prisma.finalVideoAsset.findUniqueOrThrow({ where: { contentRunId: run.id } });
  const [images, videos, videoOperations] = await Promise.all([
    prisma.flowGeneratedImage.findMany({ where: { contentRunId: run.id } }),
    prisma.flowGeneratedVideo.findMany({ where: { contentRunId: run.id } }),
    prisma.contentOperation.findMany({
      where: { contentRunId: run.id, kind: "video_generation" },
      orderBy: { createdAt: "asc" },
      select: { providerAttemptsJson: true },
    }),
  ]);
  const assetsBySceneLabel = new Map<string, { id: string; sceneLabel: string; contentRunId: string | null; qaStatus: string }>();
  for (const asset of images) assetsBySceneLabel.set(asset.sceneLabel, asset);
  for (const asset of videos) assetsBySceneLabel.set(asset.sceneLabel, asset);
  const lineage = (frozenSnapshot.styleManifest.slots as Array<{ id: string }>).map((slot) => {
    const persistedSceneLabel = slot.id in SLOT_DEFINITIONS
      ? SLOT_DEFINITIONS[slot.id as keyof typeof SLOT_DEFINITIONS].persistedSceneLabel
      : slot.id;
    const asset = assetsBySceneLabel.get(persistedSceneLabel);
    if (!asset) throw new Error(`missing persisted acceptance asset for ${slot.id}`);
    return { id: asset.id, slot: slot.id, contentRunId: asset.contentRunId, qaStatus: asset.qaStatus };
  });
  const videoModels = videoOperations.map((operation) => {
    const attempts = JSON.parse(operation.providerAttemptsJson) as Array<{ model?: string }>;
    const model = attempts.find((attempt) => attempt.model)?.model;
    if (!model) throw new Error("missing frozen provider model in video attempt audit");
    return model;
  });
  const finalObject = await storage.get(final.finalStorageKey!);
  const audioObject = await storage.get(final.audioStorageKey!);
  const outputPath = join(mediaDir, `${input.styleId}-${input.variant}-final.mp4`);
  writeFileSync(outputPath, finalObject.body);
  const probed = await probeModule.probeMedia(outputPath);
  const signedUrl = await storage.createSignedReadUrl(final.finalStorageKey!);
  const assemblyManifest = JSON.parse(final.assemblyManifestJson!);

  return {
    run: persistedRun,
    final,
    replay,
    phases,
    concurrentPhases,
    signedUrl,
    outputPath,
    frozenSnapshot,
    frozenSnapshotBytes,
    persistedSnapshotBytes: persistedRun.promptSnapshotJson,
    lineage,
    videoModels,
    assemblyManifest,
    assemblyManifestBytesAfterAssembly,
    ttsCalls: tts.mock.calls.length,
    providerCalls: { images: adapter.generateImage.mock.calls.length, videoStarts: adapter.startVideo.mock.calls.length, videoPolls: adapter.pollVideo.mock.calls.length, visualFinal: visualProvider.evaluateFinal.mock.calls.length },
    counts: {
      images: await prisma.flowGeneratedImage.count({ where: { contentRunId: run.id } }),
      videos: await prisma.flowGeneratedVideo.count({ where: { contentRunId: run.id } }),
      operations: await prisma.contentOperation.count({ where: { contentRunId: run.id } }),
      sceneQaAttempts: await prisma.qaAttempt.count({ where: { OR: [{ image: { contentRunId: run.id } }, { video: { contentRunId: run.id } }] } }),
      finalVideos: await prisma.finalVideoAsset.count({ where: { contentRunId: run.id } }),
      finalQaAttempts: await prisma.qaAttempt.count({ where: { finalVideoId: final.id } }),
      audioObjects: storage.puts.filter((put) => put.mediaType === "audio").length,
      finalObjects: storage.puts.filter((put) => put.mediaType === "final_video").length,
      locks: await prisma.workspaceProviderLock.count({ where: { workspaceId: seeded.workspace.id } }),
    },
    probe: { width: probed.video.width, height: probed.video.height, videoCodec: probed.video.codec, audioCodec: probed.audio?.codec, durationSeconds: probed.durationSeconds },
    hashes: { audio: final.audioSha256, actualAudio: sha256(audioObject.body), final: final.finalSha256, actualFinal: sha256(finalObject.body) },
  };
}

export async function persistReadyToPostSmokeEvidence(outputDirectory: string) {
  const outputDir = resolve(outputDirectory);
  mkdirSync(outputDir, { recursive: true });
  const scenario = await runReadyToPostScenario({ styleId: "style1", variant: "store_discovery" });
  const videoPath = join(outputDir, "ready-to-post-style1.mp4");
  const evidencePath = join(outputDir, "ready-to-post-evidence.json");
  copyFileSync(scenario.outputPath, videoPath);
  writeFileSync(evidencePath, `${JSON.stringify({
    contentRunId: scenario.run.id,
    finalVideoId: scenario.final.id,
    status: scenario.run.status,
    finalQaStatus: scenario.final.finalQaStatus,
    sha256: scenario.hashes.final,
    bytes: scenario.final.finalBytes,
    durationSeconds: scenario.probe.durationSeconds,
    width: scenario.probe.width,
    height: scenario.probe.height,
    videoCodec: scenario.probe.videoCodec,
    audioCodec: scenario.probe.audioCodec,
    signedUrl: scenario.signedUrl,
    networkProviderSpend: false,
    providerCalls: scenario.providerCalls,
    ttsCalls: scenario.ttsCalls,
  }, null, 2)}\n`, "utf8");
  return { outputDir, videoPath, evidencePath };
}

export type AcceptanceFault =
  | "provider"
  | "storage"
  | "tts"
  | "ffmpeg"
  | "final_qa"
  | "final_qa_reject"
  | "workspace_lock"
  | "source_revocation";

export async function runReadyToPostFailureScenario(fault: AcceptanceFault) {
  await setupDatabase();
  await resetDatabase();
  const [createRunModule, imageModule, videoModule, qaModule, finalModule, rubricModule, , assemblyModule] = await modulesPromise!;
  const storage = new DeterministicPrivateStorage();
  const seeded = await seedEligibleProduct();
  const adapter = apexAdapter();
  const input: AcceptanceStyle = { styleId: "style1", variant: "store_discovery" };
  const run = await createRunModule.createManagedContentRun({
    workspaceId: seeded.workspace.id,
    productId: seeded.product.id,
    idempotencyKey: `acceptance-failure-${fault}`,
    styleId: input.styleId,
    compilerInput: compilerInput(input, seeded.primary.id, seeded.garment.id) as never,
  }, { createAdapter: () => adapter as never });
  const frozenSnapshot = JSON.parse(run.promptSnapshotJson!);
  const actor = { workspaceId: seeded.workspace.id, actorType: "service" as const, actorId: "acceptance-failure-harness" };
  const tts = vi.fn(async () => {
    if (fault === "tts") throw new Error("acceptance TTS failure after unknown provider state");
    return {
      provider: "elevenlabs" as const,
      voiceId: "voice-acceptance-uk",
      modelId: "eleven-multilingual-v2",
      normalizedScript: frozenSnapshot.voiceoverPlan.script,
      bytes: media.voice,
      bytesLength: media.voice.byteLength,
      sha256: sha256(media.voice),
      contentType: "audio/wav" as const,
    };
  });

  const evidence = async (error: string) => {
    const [persistedRun, final] = await Promise.all([
      prisma.contentRun.findUniqueOrThrow({ where: { id: run.id } }),
      prisma.finalVideoAsset.findUnique({ where: { contentRunId: run.id } }),
    ]);
    return {
      error,
      runStatus: persistedRun.status,
      finalStatus: final?.status ?? null,
      finalFailureCode: final?.failureCode ?? null,
      ttsCalls: tts.mock.calls.length,
      audioObjects: storage.puts.filter((put) => put.mediaType === "audio").length,
      finalObjects: storage.puts.filter((put) => put.mediaType === "final_video").length,
      finalQaAttempts: final ? await prisma.qaAttempt.count({ where: { finalVideoId: final.id } }) : 0,
      readyCount: await prisma.contentRun.count({ where: { id: run.id, status: "ready" } }),
      locks: await prisma.workspaceProviderLock.count({ where: { workspaceId: seeded.workspace.id } }),
    };
  };

  if (fault === "provider") {
    adapter.generateImage.mockRejectedValueOnce(new Error("acceptance provider failure"));
  }
  if (fault === "workspace_lock") {
    const blockingRun = await createRunModule.createManagedContentRun({
      workspaceId: seeded.workspace.id,
      productId: seeded.product.id,
      idempotencyKey: `acceptance-lock-holder-${run.id}`,
      styleId: input.styleId,
      compilerInput: compilerInput(input, seeded.primary.id, seeded.garment.id) as never,
    }, { createAdapter: () => adapter as never });
    const blocker = await prisma.contentOperation.create({
      data: {
        workspaceId: seeded.workspace.id,
        contentRunId: blockingRun.id,
        kind: "image_generation",
        sceneLabel: "acceptance-lock-holder",
        idempotencyKey: `acceptance-lock-${run.id}`,
        status: "running",
      },
    });
    await prisma.workspaceProviderLock.create({
      data: {
        workspaceId: seeded.workspace.id,
        operationId: blocker.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  for (const slot of frozenSnapshot.styleManifest.slots as Array<{ id: string; mediaType: "image" | "video" }>) {
    const command = { contentRunId: run.id, slot: slot.id, idempotencyKey: `${run.id}:${slot.id}` };
    const deps = { prisma, objectStorage: storage, createAdapter: () => adapter as never, fetchMedia: fetchFixture };
    let result: any;
    try {
      if (slot.mediaType === "image") result = await imageModule.generateManagedImage(actor, command as never, deps);
      else {
        await videoModule.generateManagedVideo(actor, command as never, deps);
        result = await videoModule.generateManagedVideo(actor, command as never, deps);
      }
    } catch (caught) {
      return evidence(caught instanceof Error ? caught.message : String(caught));
    }
    await qaModule.runManagedQa(actor, { contentRunId: run.id, assetId: result.asset.id, assetKind: slot.mediaType }, {
      prisma,
      runQa: async () => approveSceneAsset(result.asset.id, slot.mediaType) as never,
    });
  }

  if (fault === "source_revocation") {
    await prisma.flowGeneratedVideo.updateMany({ where: { contentRunId: run.id }, data: { qaStatus: "HUMAN_REVIEW" } });
  }
  if (fault === "storage") {
    storage.put = vi.fn(async () => { throw new Error("acceptance storage failure"); });
  }
  const assembleFinalVideo = vi.fn(async (...args: Parameters<typeof assemblyModule.assembleFinalVideo>) => {
    if (fault === "ffmpeg") throw new Error("acceptance FFmpeg failure");
    return assemblyModule.assembleFinalVideo(...args);
  });
  const visualProvider = {
    identifier: "fake-final-visual-qa-v1",
    evaluateFinal: vi.fn(async () => {
      if (fault === "final_qa") throw new Error("acceptance final QA failure");
      const rejected = fault === "final_qa_reject";
      return {
        result: {
          overallScore: rejected ? 60 : 96,
          hasHardFailure: rejected,
          checks: rubricModule.FINAL_RUBRIC.map((criterion) => ({ name: criterion.name, passed: !rejected, score: rejected ? 60 : 96 })),
          issues: rejected ? [{ type: "acceptance_rejection", severity: "critical" as const, description: "Deterministic acceptance rejection" }] : [],
        },
        providerModel: "fake-final-visual-qa-v1",
        elapsedMs: 1,
      };
    }),
  };
  const deps: any = {
    prisma,
    storage,
    voiceoverProviderFactory: () => ({ provider: "elevenlabs", generate: tts }),
    probeAudio: async () => ({ durationSeconds: frozenSnapshot.styleManifest.assembly.output.finalDurationSeconds }),
    assembleFinalVideo,
    visualProvider,
    ffmpegVersion: "acceptance-real-ffmpeg",
    now: () => new Date("2026-08-21T12:00:00.000Z"),
  };
  let error = "";
  for (let phase = 0; phase < 3; phase += 1) {
    try {
      await finalModule.runFinalOutput(actor, { contentRunId: run.id, idempotencyRoot: `failure-${run.id}` }, deps);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      break;
    }
  }
  return evidence(error);
}

export async function disposeReadyToPostHarness() {
  await prisma.$disconnect();
  const globalPrisma = (globalThis as any).prisma as PrismaClient | undefined;
  if (globalPrisma && globalPrisma !== prisma) await globalPrisma.$disconnect().catch(() => undefined);
  rmSync(databasePath, { force: true });
  rmSync(mediaDir, { recursive: true, force: true });
}
