import { createHash, randomUUID } from "node:crypto";
import { Prisma, type FinalVideoAsset, type PrismaClient } from "@prisma/client";

import { StyleManifestSchema } from "@/lib/content-styles/schemas";
import type { StyleManifest } from "@/lib/content-styles/types";
import { SLOT_DEFINITIONS } from "@/lib/content-runs/constants";
import { projectContentRun } from "@/lib/content-runs/project-run";
import type { AssemblyManifest, RequiredNextAction, ServiceActorContext } from "@/lib/content-runs/types";
import { db } from "@/lib/db";
import { assembleFinalVideo as defaultAssembleFinalVideo } from "@/lib/media/assemble-final-video";
import type { AssembleFinalVideoResult } from "@/lib/media/assemble-final-video";
import { probeMedia } from "@/lib/media/probe-media";
import { runFinalQa as defaultRunFinalQa } from "@/lib/qa/run-final-qa";
import { createObjectStorageFromEnv, type ObjectStorage } from "@/lib/storage";
import { createElevenLabsVoiceoverProvider } from "@/lib/voiceover/elevenlabs-provider";
import type { VoiceoverProvider } from "@/lib/voiceover/provider";
import { createFinalOutputRepository } from "./repository";
import type { ExpectedSourceApproval, FinalOutputScope, FrozenVoiceover } from "./types";

export interface RunFinalOutputCommand {
  contentRunId: string;
  idempotencyRoot: string;
}

export interface RunFinalOutputDependencies {
  prisma?: PrismaClient;
  storage?: ObjectStorage;
  voiceoverProviderFactory?: (config: FrozenVoiceover & { settings?: unknown }) => VoiceoverProvider;
  probeAudio?: (bytes: Uint8Array, contentType: string) => Promise<{ durationSeconds: number }>;
  assembleFinalVideo?: (manifest: AssemblyManifest, sources: { assets: Record<string, { bytes: Uint8Array }> }) => Promise<AssembleFinalVideoResult>;
  runFinalQa?: typeof defaultRunFinalQa;
  now?: () => Date;
  ffmpegVersion?: string;
}

export interface RunFinalOutputResult {
  phase: "GENERATE_VOICEOVER" | "ASSEMBLE_FINAL" | "RUN_FINAL_QA" | "COMPLETE";
  status: string;
  finalVideoId: string;
}

export class RunFinalOutputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RunFinalOutputError";
  }
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new RunFinalOutputError("INVALID_FINAL_OUTPUT_REQUEST", `${field} must be a non-empty string`);
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseSnapshot(run: { promptSnapshotJson: string | null; style: string; market: string }): {
  manifest: StyleManifest;
  voiceover: FrozenVoiceover & { settings?: unknown };
} {
  try {
    const snapshot = JSON.parse(run.promptSnapshotJson ?? "") as Record<string, any>;
    const manifest = StyleManifestSchema.parse(snapshot.styleManifest);
    const plan = snapshot.voiceoverPlan ?? snapshot.voiceover;
    const market = String(run.market).toLowerCase();
    const marketConfig = plan?.tts?.markets?.[market] ?? plan?.markets?.[market] ?? plan?.marketSettings?.[market];
    const script = String(plan?.script ?? "").trim();
    const provider = String(plan?.provider ?? marketConfig?.provider ?? "elevenlabs");
    const voiceId = String(marketConfig?.voiceId ?? plan?.voiceId ?? "").trim();
    const model = String(marketConfig?.model ?? plan?.model ?? plan?.modelId ?? "").trim();
    if (manifest.styleId !== run.style || provider !== "elevenlabs" || !script || !voiceId || !model) {
      throw new Error("invalid frozen voiceover plan");
    }
    return { manifest, voiceover: { script, provider: "elevenlabs", voiceId, model, settings: marketConfig?.settings ?? plan?.settings } };
  } catch {
    throw new RunFinalOutputError("FROZEN_VOICEOVER_PLAN_INVALID", "Run snapshot is missing a frozen per-market voiceover plan");
  }
}

async function loadRun(prisma: PrismaClient, scope: FinalOutputScope) {
  const run = await prisma.contentRun.findFirst({
    where: { id: scope.contentRunId, product: { batch: { workspaceId: scope.workspaceId } } },
    select: { id: true, productId: true, style: true, status: true, market: true, promptSnapshotJson: true },
  });
  if (!run) throw new RunFinalOutputError("CONTENT_RUN_NOT_FOUND", "Content run was not found in the authenticated workspace");
  return run;
}

async function project(prisma: PrismaClient, scope: FinalOutputScope): Promise<RequiredNextAction> {
  const run = await loadRun(prisma, scope);
  const [images, videos, operations, finalVideo] = await Promise.all([
    prisma.flowGeneratedImage.findMany({ where: { contentRunId: scope.contentRunId } }),
    prisma.flowGeneratedVideo.findMany({ where: { contentRunId: scope.contentRunId } }),
    prisma.contentOperation.findMany({ where: { contentRunId: scope.contentRunId }, orderBy: { createdAt: "asc" } }),
    prisma.finalVideoAsset.findUnique({ where: { contentRunId: scope.contentRunId } }),
  ]);
  return projectContentRun({ run, images, videos, operations, finalVideo }).requiredNextAction;
}

async function reserveOperation(prisma: PrismaClient, input: {
  scope: FinalOutputScope;
  idempotencyKey: string;
  kind: "voiceover_generation" | "final_assembly";
  sceneLabel: string;
  provider: string;
}) {
  const operationId = randomUUID();
  try {
    const inserted = await prisma.$executeRaw`
      INSERT INTO "ContentOperation" (
        "id", "workspaceId", "contentRunId", "kind", "sceneLabel", "provider", "idempotencyKey"
      )
      SELECT
        ${operationId}, ${input.scope.workspaceId}, run."id", ${input.kind}, ${input.sceneLabel}, ${input.provider}, ${input.idempotencyKey}
      FROM "ContentRun" AS run
      INNER JOIN "Product" AS product ON product."id" = run."productId"
      INNER JOIN "Batch" AS batch ON batch."id" = product."batchId"
      WHERE run."id" = ${input.scope.contentRunId}
        AND run."status" = 'generating'
        AND batch."workspaceId" = ${input.scope.workspaceId}
        AND NOT EXISTS (
          SELECT 1 FROM "ContentOperation" AS existing
          WHERE existing."workspaceId" = ${input.scope.workspaceId}
            AND existing."idempotencyKey" = ${input.idempotencyKey}
        )
    `;
    if (inserted === 1) {
      return await prisma.contentOperation.findUniqueOrThrow({ where: { id: operationId } });
    }
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }
  const existing = await prisma.contentOperation.findUnique({
    where: { workspaceId_idempotencyKey: { workspaceId: input.scope.workspaceId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    if (existing.contentRunId !== input.scope.contentRunId || existing.kind !== input.kind || existing.sceneLabel !== input.sceneLabel || existing.provider !== input.provider) {
      throw new RunFinalOutputError("FINAL_OUTPUT_IDEMPOTENCY_CONFLICT", "Final-output idempotency key is bound to another command");
    }
    return existing;
  }
  const inWorkspace = await prisma.contentRun.count({
    where: {
      id: input.scope.contentRunId,
      product: { batch: { workspaceId: input.scope.workspaceId } },
    },
  });
  throw new RunFinalOutputError(
    inWorkspace === 1 ? "FINAL_OUTPUT_RUN_STATUS_CHANGED" : "CONTENT_RUN_NOT_FOUND",
    inWorkspace === 1 ? "Content run is no longer eligible for final-output work" : "Content run was not found in the authenticated workspace",
  );
}

function exactSceneLabel(slotId: string): string {
  return slotId in SLOT_DEFINITIONS ? SLOT_DEFINITIONS[slotId as keyof typeof SLOT_DEFINITIONS].persistedSceneLabel : slotId;
}

async function assertAllRequiredSourcesStillApproved(prisma: PrismaClient, scope: FinalOutputScope): Promise<ExpectedSourceApproval[]> {
  const run = await loadRun(prisma, scope);
  const { manifest } = parseSnapshot(run);
  const sources: ExpectedSourceApproval[] = [];
  for (const slot of manifest.slots) {
    const delegate = slot.mediaType === "image" ? prisma.flowGeneratedImage : prisma.flowGeneratedVideo;
    const current = await (delegate as any).findFirst({
      where: { contentRunId: scope.contentRunId, sceneLabel: exactSceneLabel(slot.id) },
      orderBy: [{ attemptNumber: "desc" }, { id: "desc" }],
      select: { id: true, sceneLabel: true, qaStatus: true, storageSha256: true },
    });
    if (current?.qaStatus !== "APPROVED" || !current.storageSha256) {
      throw new RunFinalOutputError("SOURCE_APPROVAL_INVALID", "Every required source asset must remain approved and hashed before final output work");
    }
    sources.push({ mediaType: slot.mediaType, id: current.id, sceneLabel: current.sceneLabel, sha256: current.storageSha256 });
  }
  return sources;
}

async function enterFinalQa(
  prisma: PrismaClient,
  scope: FinalOutputScope,
  finalVideoId: string,
): Promise<void> {
  const sources = await assertAllRequiredSourcesStillApproved(prisma, scope);
  const sourcePredicates = sources.map((source) => {
    const table = source.mediaType === "image" ? "FlowGeneratedImage" : "FlowGeneratedVideo";
    return Prisma.sql`EXISTS (
      SELECT 1 FROM ${Prisma.raw(`"${table}"`)} AS source
      WHERE source."id" = ${source.id}
        AND source."contentRunId" = run."id"
        AND source."sceneLabel" = ${source.sceneLabel}
        AND source."storageSha256" = ${source.sha256}
        AND source."qaStatus" = 'APPROVED'
    )`;
  });
  const sourceFence = sourcePredicates.length > 0
    ? Prisma.sql`AND ${Prisma.join(sourcePredicates, " AND ")}`
    : Prisma.empty;
  const updated = await prisma.$executeRaw`
    UPDATE "ContentRun" AS run
    SET "status" = 'qa_running', "updatedAt" = CURRENT_TIMESTAMP
    WHERE run."id" = ${scope.contentRunId}
      AND run."status" = 'generating'
      AND EXISTS (
        SELECT 1 FROM "Product" AS product
        INNER JOIN "Batch" AS batch ON batch."id" = product."batchId"
        WHERE product."id" = run."productId"
          AND batch."workspaceId" = ${scope.workspaceId}
      )
      AND EXISTS (
        SELECT 1 FROM "FinalVideoAsset" AS final
        WHERE final."id" = ${finalVideoId}
          AND final."contentRunId" = run."id"
          AND final."status" = 'MEDIA_VALIDATED'
          AND final."finalQaStatus" = 'NOT_QA_CHECKED'
          AND final."mediaValidationPassed" = true
      )
      ${sourceFence}
  `;
  if (updated === 1) return;

  const replayable = await prisma.finalVideoAsset.count({
    where: {
      id: finalVideoId,
      contentRunId: scope.contentRunId,
      mediaValidationPassed: true,
      OR: [
        { status: "MEDIA_VALIDATED", finalQaStatus: "NOT_QA_CHECKED", contentRun: { status: "qa_running", product: { batch: { workspaceId: scope.workspaceId } } } },
        { status: "QA_RUNNING", finalQaStatus: "QA_RUNNING", contentRun: { status: "qa_running", product: { batch: { workspaceId: scope.workspaceId } } } },
        { status: "APPROVED", finalQaStatus: "APPROVED", contentRun: { status: "ready", product: { batch: { workspaceId: scope.workspaceId } } } },
        { status: "HUMAN_REVIEW", finalQaStatus: "HUMAN_REVIEW", contentRun: { status: "human_review", product: { batch: { workspaceId: scope.workspaceId } } } },
        { status: "FAILED", finalQaStatus: "FAILED", contentRun: { status: "failed", product: { batch: { workspaceId: scope.workspaceId } } } },
      ],
    },
  });
  if (replayable === 1) return;
  throw new RunFinalOutputError(
    "FINAL_OUTPUT_RUN_STATUS_CHANGED",
    "Content run or validated final media is no longer eligible to enter final QA",
  );
}

async function assertAssemblySourcesStillApproved(prisma: PrismaClient, scope: FinalOutputScope, manifest: AssemblyManifest): Promise<void> {
  const rows = await prisma.flowGeneratedVideo.findMany({
    where: { id: { in: manifest.clips.map((clip) => clip.assetId) }, contentRunId: scope.contentRunId, qaStatus: "APPROVED" },
    select: { id: true, storageSha256: true, sceneLabel: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== manifest.clips.length || manifest.clips.some((clip) => {
    const row = byId.get(clip.assetId);
    return row?.storageSha256 !== clip.assetSha256 || row.sceneLabel !== exactSceneLabel(clip.slotId);
  })) {
    throw new RunFinalOutputError("SOURCE_APPROVAL_INVALID", "Final assembly source approval or hash changed before deterministic assembly");
  }
}

async function markOperationRunning(prisma: PrismaClient, workspaceId: string, operationId: string) {
  const updated = await prisma.$executeRaw`
    UPDATE "ContentOperation"
    SET "status" = 'running', "startedAt" = CURRENT_TIMESTAMP, "technicalAttemptCount" = 1
    WHERE "id" = ${operationId}
      AND "workspaceId" = ${workspaceId}
      AND "status" = 'requested'
      AND EXISTS (
        SELECT 1 FROM "ContentRun" AS run
        INNER JOIN "Product" AS product ON product."id" = run."productId"
        INNER JOIN "Batch" AS batch ON batch."id" = product."batchId"
        WHERE run."id" = "ContentOperation"."contentRunId"
          AND run."status" = 'generating'
          AND batch."workspaceId" = ${workspaceId}
      )
  `;
  const op = await prisma.contentOperation.findUniqueOrThrow({ where: { id: operationId } });
  if (updated === 0 && op.status === "requested") {
    await failOperation(prisma, workspaceId, operationId, { code: "FINAL_OUTPUT_RUN_STATUS_CHANGED" }).catch(() => undefined);
    throw new RunFinalOutputError("FINAL_OUTPUT_RUN_STATUS_CHANGED", "Content run is no longer eligible to start final-output work");
  }
  if (updated === 0 && op.status !== "running") return null;
  if (updated === 0 && op.status === "running" && op.startedAt) return null;
  return op;
}

async function succeedOperation(prisma: PrismaClient, workspaceId: string, operationId: string, result: unknown) {
  await prisma.contentOperation.updateMany({
    where: { id: operationId, workspaceId, status: { in: ["requested", "running"] } },
    data: { status: "succeeded", resultJson: JSON.stringify(result), errorJson: null, completedAt: new Date() },
  });
}

async function failOperation(prisma: PrismaClient, workspaceId: string, operationId: string, error: unknown) {
  await prisma.contentOperation.updateMany({
    where: { id: operationId, workspaceId, status: { in: ["requested", "running"] } },
    data: { status: "failed", errorJson: JSON.stringify(error), completedAt: new Date() },
  });
}

function resolveVoiceoverProvider(voiceover: FrozenVoiceover & { settings?: unknown }): VoiceoverProvider {
  if (voiceover.provider === "elevenlabs") {
    return createElevenLabsVoiceoverProvider({
      apiKey: process.env.ELEVENLABS_API_KEY ?? "",
      voiceId: voiceover.voiceId,
      modelId: voiceover.model,
      voiceSettings: voiceover.settings as any,
    });
  }
  throw new RunFinalOutputError("UNSUPPORTED_VOICEOVER_PROVIDER", "Frozen voiceover provider is not supported by final-output orchestration");
}

async function generateVoiceover(actor: ServiceActorContext, command: RunFinalOutputCommand, deps: Required<Pick<RunFinalOutputDependencies, "prisma" | "storage">> & RunFinalOutputDependencies): Promise<RunFinalOutputResult> {
  const scope = { workspaceId: actor.workspaceId, contentRunId: command.contentRunId };
  const run = await loadRun(deps.prisma, scope);
  const { voiceover } = parseSnapshot(run);
  await assertAllRequiredSourcesStillApproved(deps.prisma, scope);
  const repository = createFinalOutputRepository(deps.prisma);
  const final = await repository.reserve(scope, voiceover);
  if (final.audioStorageKey) return { phase: "GENERATE_VOICEOVER", status: final.status, finalVideoId: final.id };
  const operation = await reserveOperation(deps.prisma, { scope, idempotencyKey: `${command.idempotencyRoot}:voiceover`, kind: "voiceover_generation", sceneLabel: "voiceover", provider: voiceover.provider });
  if (operation.status === "succeeded") {
    const replay = await finalOperationPhaseResult(actor, command, deps, operation.id);
    if (replay) return replay;
    return { phase: "GENERATE_VOICEOVER", status: final.status, finalVideoId: final.id };
  }
  const running = await markOperationRunning(deps.prisma, actor.workspaceId, operation.id);
  if (!running) return waitForFinalOperationResult(actor, command, deps, operation.id);
  let objectKey: string | null = null;
  try {
    await assertAllRequiredSourcesStillApproved(deps.prisma, scope);
    const provider = deps.voiceoverProviderFactory ? deps.voiceoverProviderFactory(voiceover) : resolveVoiceoverProvider(voiceover);
    const generated = await provider.generate({ script: voiceover.script });
    await assertAllRequiredSourcesStillApproved(deps.prisma, scope);
    const stored = await deps.storage.put({ workspaceId: actor.workspaceId, contentRunId: command.contentRunId, assetId: final.id, mediaType: "audio", extension: generated.contentType === "audio/wav" ? "wav" : "mp3", contentType: generated.contentType, body: generated.bytes });
    objectKey = stored.key;
    const commitSources = await assertAllRequiredSourcesStillApproved(deps.prisma, scope);
    const probe = deps.probeAudio ? await deps.probeAudio(generated.bytes, generated.contentType) : await defaultProbeAudio(generated.bytes);
    const row = await repository.persistVoiceover(scope, final.id, { ...stored, contentType: stored.contentType as "audio/mpeg" | "audio/wav", durationSeconds: probe.durationSeconds, expectedSources: commitSources });
    objectKey = null;
    await succeedOperation(deps.prisma, actor.workspaceId, operation.id, { finalVideoId: final.id, audioSha256: stored.sha256 }).catch(() => undefined);
    return { phase: "GENERATE_VOICEOVER", status: row.status, finalVideoId: final.id };
  } catch (error) {
    if (objectKey) await deps.storage.delete(objectKey).catch(() => undefined);
    await failOperation(deps.prisma, actor.workspaceId, operation.id, { code: "VOICEOVER_GENERATION_FAILED" });
    await createFinalOutputRepository(deps.prisma).recordTerminalFailure(scope, final.id, { code: "VOICEOVER_GENERATION_FAILED", failedAt: deps.now?.() ?? new Date() }).catch(() => undefined);
    throw error;
  }
}

async function defaultProbeAudio(bytes: Uint8Array): Promise<{ durationSeconds: number }> {
  // Used only in production-like paths; tests inject deterministic duration.
  const result = await probeMediaBytes(bytes, "voiceover.mp3", false);
  return { durationSeconds: result.durationSeconds };
}

async function probeMediaBytes(bytes: Uint8Array, name: string, requireVideo: boolean) {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "final-output-probe-"));
  const path = join(dir, name);
  try {
    await writeFile(path, bytes);
    return await probeMedia(path, { requireVideo });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sceneLabelForSlot(slotId: string): string {
  return slotId in SLOT_DEFINITIONS ? SLOT_DEFINITIONS[slotId as keyof typeof SLOT_DEFINITIONS].persistedSceneLabel : slotId;
}

async function buildAssemblyManifest(prisma: PrismaClient, scope: FinalOutputScope, final: FinalVideoAsset, ffmpegVersion: string): Promise<AssemblyManifest> {
  const run = await loadRun(prisma, scope);
  const { manifest } = parseSnapshot(run);
  if (!final.audioSha256 || !final.audioDurationSeconds) throw new RunFinalOutputError("VOICEOVER_NOT_READY", "Voiceover must be persisted before assembly");
  const clips = [] as AssemblyManifest["clips"];
  for (const clip of manifest.assembly.clips) {
    const source = await prisma.flowGeneratedVideo.findFirst({
      where: { contentRunId: scope.contentRunId, sceneLabel: sceneLabelForSlot(clip.slotId) },
      orderBy: [{ attemptNumber: "desc" }, { id: "desc" }],
    });
    if (!source || source.qaStatus !== "APPROVED" || !source.storageSha256) {
      throw new RunFinalOutputError("SOURCE_APPROVAL_INVALID", "Every required source video must be currently approved and hashed before final assembly");
    }
    clips.push({ ...clip, assetId: source.id, assetSha256: source.storageSha256, approvalStatus: "APPROVED" });
  }
  return {
    version: "assembly-manifest-v1",
    clips,
    audio: { assetId: final.id, assetSha256: final.audioSha256, durationSeconds: final.audioDurationSeconds },
    output: {
      width: manifest.assembly.output.width,
      height: manifest.assembly.output.height,
      fps: manifest.assembly.output.fps,
      voiceoverGainDb: manifest.assembly.output.audioMix.voiceoverGainDb,
      nativeAudioGainDb: manifest.assembly.output.audioMix.nativeAudioGainDb,
      duckingThresholdDb: manifest.assembly.output.audioMix.duckingThresholdDb,
      expectedDurationSeconds: manifest.assembly.output.finalDurationSeconds,
    },
    ffmpegVersion,
  };
}

async function readAssemblySources(prisma: PrismaClient, storage: ObjectStorage, scope: FinalOutputScope, manifest: AssemblyManifest, final: FinalVideoAsset) {
  const assets: Record<string, { bytes: Uint8Array }> = {};
  for (const clip of manifest.clips) {
    const row = await prisma.flowGeneratedVideo.findUniqueOrThrow({ where: { id: clip.assetId } });
    if (row.contentRunId !== scope.contentRunId || row.qaStatus !== "APPROVED" || !row.storageKey) {
      throw new RunFinalOutputError("SOURCE_APPROVAL_INVALID", "Final assembly source changed before read");
    }
    const read = await storage.get(row.storageKey);
    if (sha256(read.body) !== clip.assetSha256) throw new RunFinalOutputError("SOURCE_HASH_MISMATCH", "Final assembly source bytes do not match persisted hash");
    assets[clip.assetId] = { bytes: read.body };
  }
  if (!final.audioStorageKey || !final.audioSha256) throw new RunFinalOutputError("VOICEOVER_NOT_READY", "Voiceover object is missing");
  const audio = await storage.get(final.audioStorageKey);
  if (sha256(audio.body) !== final.audioSha256) throw new RunFinalOutputError("AUDIO_HASH_MISMATCH", "Voiceover bytes do not match persisted hash");
  assets[manifest.audio.assetId] = { bytes: audio.body };
  return { assets };
}

async function assembleFinal(actor: ServiceActorContext, command: RunFinalOutputCommand, deps: Required<Pick<RunFinalOutputDependencies, "prisma" | "storage">> & RunFinalOutputDependencies, finalVideoId: string): Promise<RunFinalOutputResult> {
  const scope = { workspaceId: actor.workspaceId, contentRunId: command.contentRunId };
  const repository = createFinalOutputRepository(deps.prisma);
  const current = await repository.find(scope);
  if (!current || current.id !== finalVideoId) throw new RunFinalOutputError("FINAL_OUTPUT_NOT_FOUND", "Final output was not reserved for this run");
  if (current.finalStorageKey) return { phase: "ASSEMBLE_FINAL", status: current.status, finalVideoId };
  const operation = await reserveOperation(deps.prisma, { scope, idempotencyKey: `${command.idempotencyRoot}:assembly`, kind: "final_assembly", sceneLabel: "final", provider: "local_ffmpeg" });
  if (operation.status === "succeeded") {
    const replay = await finalOperationPhaseResult(actor, command, deps, operation.id);
    if (replay) return replay;
    return { phase: "ASSEMBLE_FINAL", status: current.status, finalVideoId };
  }
  const running = await markOperationRunning(deps.prisma, actor.workspaceId, operation.id);
  if (!running) return waitForFinalOperationResult(actor, command, deps, operation.id);
  let objectKey: string | null = null;
  try {
    const manifest = await buildAssemblyManifest(deps.prisma, scope, current, deps.ffmpegVersion ?? "7.1.1");
    await repository.persistAssemblyManifest(scope, finalVideoId, manifest);
    const sources = await readAssemblySources(deps.prisma, deps.storage, scope, manifest, current);
    await assertAssemblySourcesStillApproved(deps.prisma, scope, manifest);
    await repository.persistAssemblyManifest(scope, finalVideoId, manifest);
    const assembled = await (deps.assembleFinalVideo ?? defaultAssembleFinalVideo)(manifest, sources);
    await assertAssemblySourcesStillApproved(deps.prisma, scope, manifest);
    await repository.persistAssemblyManifest(scope, finalVideoId, manifest);
    const stored = await deps.storage.put({ workspaceId: actor.workspaceId, contentRunId: command.contentRunId, assetId: finalVideoId, mediaType: "final_video", extension: "mp4", contentType: "video/mp4", body: assembled.bytes });
    objectKey = stored.key;
    await assertAssemblySourcesStillApproved(deps.prisma, scope, manifest);
    const row = await repository.persistFinalMp4(scope, finalVideoId, {
      bucket: stored.bucket,
      key: stored.key,
      contentType: "video/mp4",
      bytes: stored.bytes,
      sha256: stored.sha256,
      durationSeconds: assembled.probe.durationSeconds,
      width: assembled.probe.video.width,
      height: assembled.probe.video.height,
      videoCodec: assembled.probe.video.codec,
      audioCodec: assembled.probe.audio?.codec ?? "",
      mediaValidatedAt: deps.now?.() ?? new Date(),
    }, manifest);
    objectKey = null;
    await succeedOperation(deps.prisma, actor.workspaceId, operation.id, { finalVideoId, finalSha256: stored.sha256, commandManifest: assembled.commandManifest }).catch(() => undefined);
    return { phase: "ASSEMBLE_FINAL", status: row.status, finalVideoId };
  } catch (error) {
    if (objectKey) await deps.storage.delete(objectKey).catch(() => undefined);
    await failOperation(deps.prisma, actor.workspaceId, operation.id, { code: "FINAL_ASSEMBLY_FAILED" });
    await createFinalOutputRepository(deps.prisma).recordTerminalFailure(scope, finalVideoId, { code: "FINAL_ASSEMBLY_FAILED", failedAt: deps.now?.() ?? new Date() }).catch(() => undefined);
    throw error;
  }
}

async function runQa(actor: ServiceActorContext, command: RunFinalOutputCommand, deps: Required<Pick<RunFinalOutputDependencies, "prisma" | "storage">> & RunFinalOutputDependencies, finalVideoId: string): Promise<RunFinalOutputResult> {
  await enterFinalQa(
    deps.prisma,
    { workspaceId: actor.workspaceId, contentRunId: command.contentRunId },
    finalVideoId,
  );
  try {
    await (deps.runFinalQa ?? defaultRunFinalQa)(actor, { contentRunId: command.contentRunId, finalVideoId }, deps as any);
  } catch (error: any) {
    if (error?.code !== "FINAL_QA_CONFLICT") throw error;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const final = await deps.prisma.finalVideoAsset.findFirst({
        where: {
          id: finalVideoId,
          contentRunId: command.contentRunId,
          OR: [
            { status: "APPROVED", finalQaStatus: "APPROVED", contentRun: { status: "ready", product: { batch: { workspaceId: actor.workspaceId } } } },
            { status: "HUMAN_REVIEW", finalQaStatus: "HUMAN_REVIEW", contentRun: { status: "human_review", product: { batch: { workspaceId: actor.workspaceId } } } },
            { status: "FAILED", finalQaStatus: "FAILED", contentRun: { status: "failed", product: { batch: { workspaceId: actor.workspaceId } } } },
          ],
        },
        select: { id: true, contentRun: { select: { status: true } } },
      });
      if (final) return { phase: "RUN_FINAL_QA", status: final.contentRun.status, finalVideoId: final.id };
      if (attempt < 1_199) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw error;
  }
  const run = await loadRun(deps.prisma, { workspaceId: actor.workspaceId, contentRunId: command.contentRunId });
  const final = await deps.prisma.finalVideoAsset.findUniqueOrThrow({ where: { id: finalVideoId } });
  return { phase: "RUN_FINAL_QA", status: run.status, finalVideoId: final.id };
}

async function reconcileCompletedFinalOperation(
  actor: ServiceActorContext,
  command: RunFinalOutputCommand,
  deps: Required<Pick<RunFinalOutputDependencies, "prisma" | "storage">> & RunFinalOutputDependencies,
  operationId: string,
): Promise<boolean> {
  const operation = await deps.prisma.contentOperation.findFirst({
    where: { id: operationId, workspaceId: actor.workspaceId, contentRunId: command.contentRunId, status: { in: ["requested", "running"] } },
  });
  if (!operation) return false;
  const final = await createFinalOutputRepository(deps.prisma).find({ workspaceId: actor.workspaceId, contentRunId: command.contentRunId });
  if (!final) return false;
  if (operation.kind === "voiceover_generation" && final.audioStorageKey && final.audioSha256) {
    await succeedOperation(deps.prisma, actor.workspaceId, operation.id, { finalVideoId: final.id, audioSha256: final.audioSha256, reconciled: true });
    return true;
  }
  if (operation.kind === "final_assembly" && final.finalStorageKey && final.finalSha256) {
    await succeedOperation(deps.prisma, actor.workspaceId, operation.id, { finalVideoId: final.id, finalSha256: final.finalSha256, reconciled: true });
    return true;
  }
  return false;
}

async function finalOperationPhaseResult(
  actor: ServiceActorContext,
  command: RunFinalOutputCommand,
  deps: Required<Pick<RunFinalOutputDependencies, "prisma" | "storage">> & RunFinalOutputDependencies,
  operationId: string,
): Promise<RunFinalOutputResult | null> {
  const operation = await deps.prisma.contentOperation.findFirst({
    where: { id: operationId, workspaceId: actor.workspaceId, contentRunId: command.contentRunId },
    select: { kind: true },
  });
  if (!operation) return null;
  const final = await createFinalOutputRepository(deps.prisma).find({ workspaceId: actor.workspaceId, contentRunId: command.contentRunId });
  if (!final) return null;
  if (operation.kind === "voiceover_generation" && final.audioStorageKey && final.audioSha256) {
    return { phase: "GENERATE_VOICEOVER", status: final.status, finalVideoId: final.id };
  }
  if (operation.kind === "final_assembly" && final.finalStorageKey && final.finalSha256) {
    return { phase: "ASSEMBLE_FINAL", status: final.status, finalVideoId: final.id };
  }
  return null;
}

async function waitForFinalOperationResult(
  actor: ServiceActorContext,
  command: RunFinalOutputCommand,
  deps: Required<Pick<RunFinalOutputDependencies, "prisma" | "storage">> & RunFinalOutputDependencies,
  operationId: string,
): Promise<RunFinalOutputResult> {
  if (await reconcileCompletedFinalOperation(actor, command, deps, operationId)) {
    const result = await finalOperationPhaseResult(actor, command, deps, operationId);
    if (result) return result;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const operation = await deps.prisma.contentOperation.findFirst({
      where: { id: operationId, workspaceId: actor.workspaceId, contentRunId: command.contentRunId },
      select: { status: true },
    });
    if (!operation || operation.status !== "running") {
      const result = await finalOperationPhaseResult(actor, command, deps, operationId);
      if (result) return result;
      break;
    }
    if (await reconcileCompletedFinalOperation(actor, command, deps, operationId)) {
      const result = await finalOperationPhaseResult(actor, command, deps, operationId);
      if (result) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new RunFinalOutputError("FINAL_OUTPUT_ACTION_NOT_READY", "Final-output operation did not produce a persisted phase result");
}

export async function runFinalOutput(actorInput: ServiceActorContext, commandInput: RunFinalOutputCommand, dependencies: RunFinalOutputDependencies = {}, reconciliationDepth = 0): Promise<RunFinalOutputResult> {
  const actor = { ...actorInput, workspaceId: nonEmpty(actorInput?.workspaceId, "workspaceId") };
  const command = { contentRunId: nonEmpty(commandInput?.contentRunId, "contentRunId"), idempotencyRoot: nonEmpty(commandInput?.idempotencyRoot, "idempotencyRoot") };
  const deps = { ...dependencies, prisma: dependencies.prisma ?? db, storage: dependencies.storage ?? createObjectStorageFromEnv() };
  const action = await project(deps.prisma, { workspaceId: actor.workspaceId, contentRunId: command.contentRunId });
  if (action.type === "GENERATE_VOICEOVER") return generateVoiceover(actor, command, deps);
  if (action.type === "ASSEMBLE_FINAL") return assembleFinal(actor, command, deps, action.finalVideoId);
  if (action.type === "RUN_FINAL_QA") return runQa(actor, command, deps, action.finalVideoId);
  if (action.type === "WAIT_FOR_OPERATION" && reconciliationDepth < 1) {
    return waitForFinalOperationResult(actor, command, deps, action.operationId);
  }
  if (action.type === "COMPLETE") {
    const final = await deps.prisma.finalVideoAsset.findUniqueOrThrow({ where: { contentRunId: command.contentRunId } });
    return { phase: "COMPLETE", status: "ready", finalVideoId: final.id };
  }
  throw new RunFinalOutputError("FINAL_OUTPUT_ACTION_NOT_READY", `Run is not ready for final-output orchestration: ${action.type}`);
}
