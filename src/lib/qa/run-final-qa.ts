import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Prisma, type FinalVideoAsset, type PrismaClient } from "@prisma/client";

import { StyleManifestSchema } from "@/lib/content-styles/schemas";
import { SLOT_DEFINITIONS } from "@/lib/content-runs/constants";
import { AssemblyManifestSchema } from "@/lib/content-runs/schemas";
import type { AssemblyManifest } from "@/lib/content-runs/types";
import { db } from "@/lib/db";
import { runFfmpeg } from "@/lib/media/ffmpeg-runner";
import { probeMedia } from "@/lib/media/probe-media";
import { createObjectStorageFromEnv, type ObjectStorage } from "@/lib/storage";
import { computeSampleTimestamps, DEFAULT_FRAME_SAMPLING } from "./frame-extraction";
import {
  type FinalAudioAnalysis,
  type FinalMediaProbe,
  type FinalMediaSourceEvidence,
  type FinalMediaValidationResult,
  validateFinalMedia,
} from "./final-media-validation";
import {
  decideFinalQa,
  FINAL_RUBRIC,
  type FinalQaEvaluation,
  type FinalVisualQaResult,
} from "./final-rubric";
import { buildFinalQaSystemPrompt, buildFinalQaUserText } from "./final-qa-prompt";
import type { ExtractedFrame } from "./visual-qa-provider";

const FINAL_RUBRIC_VERSION = "final-qa-v1";
const FINAL_ASSET_TYPE = "FINAL_VIDEO";
const TERMINAL_STATUSES = new Set(["APPROVED", "HUMAN_REVIEW", "FAILED"]);
const VALIDATION_LIMITS = {
  durationToleranceSeconds: 0.25,
  fpsTolerance: 0.01,
  maxLeadingSilenceSeconds: 0.5,
  maxTrailingSilenceSeconds: 0.5,
  maxClippedSampleCount: 0,
} as const;

export interface RunFinalQaActor {
  workspaceId: string;
}

export interface RunFinalQaCommand {
  contentRunId: string;
  finalVideoId: string;
}

export interface FinalVisualQaInput {
  rubric: typeof FINAL_RUBRIC;
  systemPrompt: string;
  userText: string;
  frames: readonly ExtractedFrame[];
}

export interface FinalVisualQaProvider {
  readonly identifier: string;
  evaluateFinal(input: FinalVisualQaInput): Promise<{
    result: FinalVisualQaResult;
    providerModel: string;
    elapsedMs: number;
  }>;
}

export interface RunFinalQaDependencies {
  prisma?: PrismaClient;
  storage?: ObjectStorage;
  probeMedia?: (bytes: Uint8Array) => Promise<FinalMediaProbe>;
  analyzeAudio?: (bytes: Uint8Array, durationSeconds: number) => Promise<FinalAudioAnalysis>;
  extractFrames?: (bytes: Uint8Array, durationSeconds: number) => Promise<ExtractedFrame[]>;
  visualProvider: FinalVisualQaProvider;
  now?: () => Date;
}

export interface RunFinalQaResult {
  attemptId: string;
  contentRunId: string;
  finalVideoId: string;
  decision: FinalQaEvaluation["decision"];
  finalQaStatus: "APPROVED" | "HUMAN_REVIEW" | "FAILED";
  score: number | null;
  verdict: string;
  runStatus: "ready" | "human_review" | "failed";
  providerModel: string;
}

export class FinalQaOrchestratorError extends Error {
  constructor(
    readonly code:
      | "INVALID_FINAL_QA_REQUEST"
      | "FINAL_QA_NOT_FOUND"
      | "FINAL_QA_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "FinalQaOrchestratorError";
  }
}

interface LoadedFinalContext {
  final: FinalVideoAsset;
  productName: string;
  market: string;
  runStatus: string;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new FinalQaOrchestratorError("INVALID_FINAL_QA_REQUEST", `${field} must be a non-empty string`);
  }
  return value;
}

async function loadContext(
  prisma: PrismaClient,
  workspaceId: string,
  contentRunId: string,
  finalVideoId: string,
): Promise<LoadedFinalContext> {
  const row = await prisma.finalVideoAsset.findFirst({
    where: {
      id: finalVideoId,
      contentRunId,
      contentRun: { product: { batch: { workspaceId } } },
    },
    select: {
      id: true,
      contentRunId: true,
      attempt: true,
      status: true,
      voiceoverScript: true,
      voiceoverProvider: true,
      voiceoverVoiceId: true,
      voiceoverModel: true,
      audioStorageBucket: true,
      audioStorageKey: true,
      audioContentType: true,
      audioBytes: true,
      audioSha256: true,
      audioDurationSeconds: true,
      assemblyManifestJson: true,
      finalStorageBucket: true,
      finalStorageKey: true,
      finalContentType: true,
      finalBytes: true,
      finalSha256: true,
      finalDurationSeconds: true,
      finalWidth: true,
      finalHeight: true,
      finalVideoCodec: true,
      finalAudioCodec: true,
      mediaValidationPassed: true,
      mediaValidatedAt: true,
      mediaValidationJson: true,
      finalQaStatus: true,
      finalQaScore: true,
      finalQaVerdict: true,
      finalQaEvaluatedAt: true,
      failureCode: true,
      failureJson: true,
      failedAt: true,
      createdAt: true,
      updatedAt: true,
      contentRun: {
        select: {
          market: true,
          status: true,
          product: { select: { productName: true } },
        },
      },
    },
  });
  if (!row) {
    throw new FinalQaOrchestratorError(
      "FINAL_QA_NOT_FOUND",
      "Final video was not found in the authenticated workspace and content run",
    );
  }
  const { contentRun, ...final } = row;
  return {
    final: final as FinalVideoAsset,
    productName: contentRun.product.productName,
    market: contentRun.market,
    runStatus: contentRun.status,
  };
}

async function terminalReplay(
  prisma: PrismaClient,
  context: LoadedFinalContext,
): Promise<RunFinalQaResult | null> {
  if (!TERMINAL_STATUSES.has(context.final.status)) return null;
  const attempt = await prisma.qaAttempt.findFirst({
    where: { finalVideoId: context.final.id },
    orderBy: { createdAt: "desc" },
  });
  if (!attempt) {
    throw new FinalQaOrchestratorError(
      "FINAL_QA_CONFLICT",
      "Terminal final video is missing its append-only QA attempt",
    );
  }
  const status = context.final.finalQaStatus as RunFinalQaResult["finalQaStatus"];
  const runStatus = context.runStatus as RunFinalQaResult["runStatus"];
  return {
    attemptId: attempt.id,
    contentRunId: context.final.contentRunId,
    finalVideoId: context.final.id,
    decision: attempt.decision as RunFinalQaResult["decision"],
    finalQaStatus: status,
    score: context.final.finalQaScore,
    verdict: context.final.finalQaVerdict ?? "Final QA completed.",
    runStatus,
    providerModel: attempt.providerModel,
  };
}

async function acquireLock(
  prisma: PrismaClient,
  workspaceId: string,
  contentRunId: string,
  finalVideoId: string,
): Promise<void> {
  const updated = await prisma.finalVideoAsset.updateMany({
    where: {
      id: finalVideoId,
      contentRunId,
      status: "MEDIA_VALIDATED",
      finalQaStatus: "NOT_QA_CHECKED",
      mediaValidationPassed: true,
      contentRun: {
        status: "qa_running",
        product: { batch: { workspaceId } },
      },
    },
    data: { status: "QA_RUNNING", finalQaStatus: "QA_RUNNING" },
  });
  if (updated.count !== 1) {
    throw new FinalQaOrchestratorError(
      "FINAL_QA_CONFLICT",
      "Final QA is already running or the exact run/QA status fence changed",
    );
  }
}

function integrityValidation(final: FinalVideoAsset, storage: ObjectStorage, read: {
  body: Uint8Array;
  contentType: string | undefined;
  bytes: number;
}): FinalMediaValidationResult {
  const failures: FinalMediaValidationResult["failures"][number][] = [];
  const actualHash = createHash("sha256").update(read.body).digest("hex");
  if (
    final.finalStorageBucket !== storage.bucket ||
    final.finalContentType !== "video/mp4" ||
    read.contentType !== "video/mp4"
  ) {
    failures.push({ code: "OBJECT_BYTES_MISMATCH", message: "Persisted final object metadata is not the expected private MP4." });
  }
  if (read.bytes !== read.body.byteLength || read.bytes !== final.finalBytes) {
    failures.push({ code: "OBJECT_BYTES_MISMATCH", message: "Persisted final object byte length does not match immutable metadata." });
  }
  if (!final.finalSha256 || actualHash !== final.finalSha256) {
    failures.push({ code: "OBJECT_HASH_MISMATCH", message: "Persisted final object SHA-256 does not match immutable metadata." });
  }
  return { passed: failures.length === 0, failures };
}

async function loadSources(
  prisma: PrismaClient,
  contentRunId: string,
  manifest: AssemblyManifest,
  final: FinalVideoAsset,
): Promise<FinalMediaSourceEvidence> {
  const rows = await prisma.flowGeneratedVideo.findMany({
    where: { id: { in: manifest.clips.map((clip) => clip.assetId) }, contentRunId },
    select: { id: true, storageSha256: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row.storageSha256 ?? ""]));
  return {
    clips: manifest.clips.map((clip) => ({
      order: clip.order,
      slotId: clip.slotId,
      assetId: clip.assetId,
      sha256: byId.get(clip.assetId) ?? "",
    })),
    audio: { assetId: manifest.audio.assetId, sha256: final.audioSha256 ?? "" },
  };
}

function persistedInvariantValidation(
  final: FinalVideoAsset,
  manifest: AssemblyManifest,
): FinalMediaValidationResult {
  const required = [
    final.voiceoverScript,
    final.voiceoverProvider,
    final.voiceoverVoiceId,
    final.voiceoverModel,
    final.audioStorageBucket,
    final.audioStorageKey,
    final.audioContentType,
    final.audioBytes,
    final.audioSha256,
    final.audioDurationSeconds,
    final.assemblyManifestJson,
    final.finalStorageBucket,
    final.finalStorageKey,
    final.finalContentType,
    final.finalBytes,
    final.finalSha256,
    final.finalDurationSeconds,
    final.finalWidth,
    final.finalHeight,
    final.finalVideoCodec,
    final.finalAudioCodec,
    final.mediaValidatedAt,
  ];
  if (required.some((value) => value === null || value === "" || value === 0)) {
    return {
      passed: false,
      failures: [{ code: "MANIFEST_INVALID", message: "Final output is missing a mandatory persisted READY factor." }],
    };
  }
  if (
    final.audioSha256 !== manifest.audio.assetSha256 ||
    final.audioDurationSeconds !== manifest.audio.durationSeconds
  ) {
    return {
      passed: false,
      failures: [{ code: "AUDIO_SOURCE_MISMATCH", message: "Persisted voiceover hash or duration does not match the immutable assembly manifest." }],
    };
  }
  return { passed: true, failures: [] };
}

function mergeValidation(
  integrity: FinalMediaValidationResult,
  media: FinalMediaValidationResult,
): FinalMediaValidationResult {
  const failures = [...integrity.failures, ...media.failures];
  return { passed: failures.length === 0, failures };
}

function validationJson(
  validation: FinalMediaValidationResult,
  final: FinalVideoAsset,
  read: { bytes: number; body: Uint8Array },
  probe?: FinalMediaProbe,
  analysis?: FinalAudioAnalysis,
): string {
  return JSON.stringify({
    ...validation,
    verifiedObject: {
      bytes: read.bytes,
      sha256: createHash("sha256").update(read.body).digest("hex"),
      expectedBytes: final.finalBytes,
      expectedSha256: final.finalSha256,
    },
    ...(probe ? { probe } : {}),
    ...(analysis ? { analysis } : {}),
  });
}

function infrastructureEvaluation(code: string): FinalQaEvaluation {
  return decideFinalQa({
    deterministic: { passed: true, failures: [] },
    visual: null,
    failure: code,
  });
}

function deterministicReview(validation: FinalMediaValidationResult): FinalQaEvaluation {
  return {
    decision: "HUMAN_REVIEW",
    score: null,
    verdict: `Deterministic final-media gates failed: ${validation.failures.map((failure) => failure.code).join(", ")}.`,
    deterministic: validation,
    visual: null,
    providerModel: "deterministic",
    elapsedMs: 0,
  };
}

async function everyRequiredSourceIsStillApproved(
  tx: Prisma.TransactionClient,
  contentRunId: string,
  manifest: AssemblyManifest,
): Promise<boolean> {
  const run = await tx.contentRun.findUnique({
    where: { id: contentRunId },
    select: { promptSnapshotJson: true },
  });
  let slots: ReturnType<typeof StyleManifestSchema.parse>["slots"];
  try {
    const snapshot = JSON.parse(run?.promptSnapshotJson ?? "") as Record<string, unknown>;
    slots = StyleManifestSchema.parse(snapshot.styleManifest).slots;
  } catch {
    return false;
  }

  for (const slot of slots) {
    const sceneLabel =
      slot.id in SLOT_DEFINITIONS
        ? SLOT_DEFINITIONS[slot.id as keyof typeof SLOT_DEFINITIONS].persistedSceneLabel
        : slot.id;
    if (slot.mediaType === "image") {
      const current = await tx.flowGeneratedImage.findFirst({
        where: { contentRunId, sceneLabel },
        orderBy: [{ attemptNumber: "desc" }, { id: "desc" }],
        select: { qaStatus: true },
      });
      if (current?.qaStatus !== "APPROVED") return false;
      continue;
    }
    const current = await tx.flowGeneratedVideo.findFirst({
      where: { contentRunId, sceneLabel },
      orderBy: [{ attemptNumber: "desc" }, { id: "desc" }],
      select: { id: true, storageSha256: true, qaStatus: true },
    });
    const expected = manifest.clips.find((clip) => clip.slotId === slot.id);
    if (
      current?.qaStatus !== "APPROVED" ||
      !expected ||
      current.id !== expected.assetId ||
      current.storageSha256 !== expected.assetSha256
    ) {
      return false;
    }
  }
  return true;
}

async function persistTerminal(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    context: LoadedFinalContext;
    evaluation: FinalQaEvaluation;
    mediaValidationJson: string;
    frames: readonly ExtractedFrame[];
    evaluatedAt: Date;
    providerModel: string;
  },
): Promise<RunFinalQaResult> {
  return prisma.$transaction(async (tx) => {
    let evaluation = input.evaluation;
    if (evaluation.decision === "APPROVE") {
      let manifest: AssemblyManifest;
      try {
        manifest = AssemblyManifestSchema.parse(JSON.parse(input.context.final.assemblyManifestJson ?? ""));
      } catch {
        evaluation = deterministicReview({
          passed: false,
          failures: [{ code: "MANIFEST_INVALID", message: "Persisted assembly manifest changed before final QA commit." }],
        });
        manifest = { clips: [] } as unknown as AssemblyManifest;
      }
      const approvedSources = await tx.flowGeneratedVideo.count({
        where: {
          contentRunId: input.context.final.contentRunId,
          OR: manifest.clips.map((clip) => ({
            id: clip.assetId,
            storageSha256: clip.assetSha256,
            qaStatus: "APPROVED",
          })),
        },
      });
      const everyRequiredSourceApproved = await everyRequiredSourceIsStillApproved(
        tx,
        input.context.final.contentRunId,
        manifest,
      );
      if (approvedSources !== manifest.clips.length || !everyRequiredSourceApproved) {
        evaluation = deterministicReview({
          passed: false,
          failures: [{ code: "CLIP_SOURCE_MISMATCH", message: "A manifest-required source approval or hash changed before commit." }],
        });
      }
    }

    const status: RunFinalQaResult["finalQaStatus"] =
      evaluation.decision === "APPROVE"
        ? "APPROVED"
        : evaluation.decision === "HUMAN_REVIEW"
          ? "HUMAN_REVIEW"
          : "FAILED";
    const runStatus: RunFinalQaResult["runStatus"] =
      status === "APPROVED" ? "ready" : status === "HUMAN_REVIEW" ? "human_review" : "failed";
    const resultJson = JSON.stringify(evaluation);
    const framesJson = JSON.stringify({
      frameCount: input.frames.length,
      timestampsMs: input.frames.map((frame) => frame.timestampMs),
    });
    const attempt = await tx.qaAttempt.create({
      data: {
        finalVideoId: input.context.final.id,
        assetType: FINAL_ASSET_TYPE,
        attemptNumber: input.context.final.attempt,
        rubricVersion: FINAL_RUBRIC_VERSION,
        providerModel: input.providerModel,
        framesJson,
        resultJson,
        decision: evaluation.decision,
        overallScore: evaluation.score ?? 0,
        hasHardFailure: evaluation.decision !== "APPROVE",
      },
      select: { id: true },
    });
    const finalUpdated = await tx.finalVideoAsset.updateMany({
      where: {
        id: input.context.final.id,
        contentRunId: input.context.final.contentRunId,
        status: "QA_RUNNING",
        finalQaStatus: "QA_RUNNING",
        voiceoverScript: input.context.final.voiceoverScript,
        voiceoverProvider: input.context.final.voiceoverProvider,
        voiceoverVoiceId: input.context.final.voiceoverVoiceId,
        voiceoverModel: input.context.final.voiceoverModel,
        audioStorageBucket: input.context.final.audioStorageBucket,
        audioStorageKey: input.context.final.audioStorageKey,
        audioContentType: input.context.final.audioContentType,
        audioBytes: input.context.final.audioBytes,
        audioSha256: input.context.final.audioSha256,
        audioDurationSeconds: input.context.final.audioDurationSeconds,
        assemblyManifestJson: input.context.final.assemblyManifestJson,
        finalStorageBucket: input.context.final.finalStorageBucket,
        finalStorageKey: input.context.final.finalStorageKey,
        finalContentType: input.context.final.finalContentType,
        finalBytes: input.context.final.finalBytes,
        finalSha256: input.context.final.finalSha256,
        finalDurationSeconds: input.context.final.finalDurationSeconds,
        finalWidth: input.context.final.finalWidth,
        finalHeight: input.context.final.finalHeight,
        finalVideoCodec: input.context.final.finalVideoCodec,
        finalAudioCodec: input.context.final.finalAudioCodec,
        mediaValidationPassed: true,
        mediaValidatedAt: input.context.final.mediaValidatedAt,
        contentRun: { status: "qa_running", product: { batch: { workspaceId: input.workspaceId } } },
      },
      data: {
        status,
        finalQaStatus: status,
        finalQaScore: evaluation.score,
        finalQaVerdict: evaluation.verdict,
        finalQaEvaluatedAt: input.evaluatedAt,
        mediaValidationJson: input.mediaValidationJson,
        ...(status === "FAILED"
          ? { failureCode: "FINAL_QA_INFRASTRUCTURE_FAILURE", failureJson: JSON.stringify({ code: "FINAL_QA_INFRASTRUCTURE_FAILURE" }), failedAt: input.evaluatedAt }
          : {}),
      },
    });
    if (finalUpdated.count !== 1) {
      throw new FinalQaOrchestratorError("FINAL_QA_CONFLICT", "Final QA completion lost its exact status CAS");
    }
    const runUpdated = await tx.contentRun.updateMany({
      where: {
        id: input.context.final.contentRunId,
        status: "qa_running",
        product: { batch: { workspaceId: input.workspaceId } },
      },
      data: {
        status: runStatus,
        ...(runStatus === "ready" ? { completedAt: input.evaluatedAt } : {}),
      },
    });
    if (runUpdated.count !== 1) {
      throw new FinalQaOrchestratorError("FINAL_QA_CONFLICT", "Content run changed before final QA commit");
    }
    return {
      attemptId: attempt.id,
      contentRunId: input.context.final.contentRunId,
      finalVideoId: input.context.final.id,
      decision: evaluation.decision,
      finalQaStatus: status,
      score: evaluation.score,
      verdict: evaluation.verdict,
      runStatus,
      providerModel: input.providerModel,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function runFinalQa(
  actor: RunFinalQaActor,
  command: RunFinalQaCommand,
  dependencies: RunFinalQaDependencies,
): Promise<RunFinalQaResult> {
  const workspaceId = nonEmpty(actor?.workspaceId, "workspaceId");
  const contentRunId = nonEmpty(command?.contentRunId, "contentRunId");
  const finalVideoId = nonEmpty(command?.finalVideoId, "finalVideoId");
  const prisma = dependencies.prisma ?? db;
  const storage = dependencies.storage ?? createObjectStorageFromEnv();
  const context = await loadContext(prisma, workspaceId, contentRunId, finalVideoId);
  const replay = await terminalReplay(prisma, context);
  if (replay) return replay;
  await acquireLock(prisma, workspaceId, contentRunId, finalVideoId);

  let read: Awaited<ReturnType<ObjectStorage["get"]>> = {
    body: new Uint8Array(),
    contentType: undefined,
    bytes: 0,
    metadata: {},
  };
  let validation: FinalMediaValidationResult = { passed: true, failures: [] };
  let frames: ExtractedFrame[] = [];
  let providerModel = dependencies.visualProvider.identifier;
  try {
    if (!context.final.finalStorageKey) {
      validation = { passed: false, failures: [{ code: "OBJECT_BYTES_MISMATCH", message: "Final object key is missing." }] };
      return await persistTerminal(prisma, {
        workspaceId,
        context,
        evaluation: deterministicReview(validation),
        mediaValidationJson: JSON.stringify(validation),
        frames,
        evaluatedAt: dependencies.now?.() ?? new Date(),
        providerModel: "deterministic",
      });
    }
    read = await storage.get(context.final.finalStorageKey);
    const integrity = integrityValidation(context.final, storage, read);
    let manifest: AssemblyManifest;
    try {
      manifest = AssemblyManifestSchema.parse(JSON.parse(context.final.assemblyManifestJson ?? ""));
    } catch {
      validation = mergeValidation(integrity, {
        passed: false,
        failures: [{ code: "MANIFEST_INVALID", message: "Persisted assembly manifest is invalid or was tampered with." }],
      });
      return await persistTerminal(prisma, {
        workspaceId,
        context,
        evaluation: deterministicReview(validation),
        mediaValidationJson: validationJson(validation, context.final, read),
        frames,
        evaluatedAt: dependencies.now?.() ?? new Date(),
        providerModel: "deterministic",
      });
    }
    if (!integrity.passed) {
      return await persistTerminal(prisma, {
        workspaceId,
        context,
        evaluation: deterministicReview(integrity),
        mediaValidationJson: validationJson(integrity, context.final, read),
        frames,
        evaluatedAt: dependencies.now?.() ?? new Date(),
        providerModel: "deterministic",
      });
    }

    const probe = await (dependencies.probeMedia ?? defaultProbeMedia)(read.body);
    const analysis = await (dependencies.analyzeAudio ?? defaultAnalyzeAudio)(read.body, probe.durationSeconds);
    const persistedInvariant = persistedInvariantValidation(context.final, manifest);
    if (!persistedInvariant.passed) {
      return await persistTerminal(prisma, {
        workspaceId,
        context,
        evaluation: deterministicReview(persistedInvariant),
        mediaValidationJson: validationJson(persistedInvariant, context.final, read, probe, analysis),
        frames,
        evaluatedAt: dependencies.now?.() ?? new Date(),
        providerModel: "deterministic",
      });
    }
    const sources = await loadSources(prisma, contentRunId, manifest, context.final);
    validation = validateFinalMedia({ manifest, probe, analysis, sources, limits: VALIDATION_LIMITS });
    frames = await (dependencies.extractFrames ?? defaultExtractFrames)(read.body, probe.durationSeconds);
    const deterministicSummary = JSON.stringify({
      passed: validation.passed,
      failures: validation.failures,
      analysis,
    });
    const provider = await dependencies.visualProvider.evaluateFinal({
      rubric: FINAL_RUBRIC,
      systemPrompt: buildFinalQaSystemPrompt(FINAL_RUBRIC),
      userText: buildFinalQaUserText({
        productName: context.productName,
        market: context.market,
        expectedClipOrder: manifest.clips.map((clip) => clip.slotId),
        frameTimestampsMs: frames.map((frame) => frame.timestampMs),
        deterministicSummary,
      }),
      frames,
    });
    providerModel = provider.providerModel;
    const evaluation = decideFinalQa({
      deterministic: validation,
      visual: provider.result,
      providerModel: provider.providerModel,
      elapsedMs: provider.elapsedMs,
    });
    return await persistTerminal(prisma, {
      workspaceId,
      context,
      evaluation,
      mediaValidationJson: validationJson(validation, context.final, read, probe, analysis),
      frames,
      evaluatedAt: dependencies.now?.() ?? new Date(),
      providerModel,
    });
  } catch (error) {
    if (error instanceof FinalQaOrchestratorError) throw error;
    const stageCode =
      read.body.byteLength === 0
        ? "OBJECT_STORAGE_FAILURE"
        : frames.length === 0
          ? "MEDIA_ANALYSIS_FAILURE"
          : "VISUAL_PROVIDER_FAILURE";
    const evaluation = infrastructureEvaluation(stageCode);
    return persistTerminal(prisma, {
      workspaceId,
      context,
      evaluation,
      mediaValidationJson: validationJson(validation, context.final, read),
      frames,
      evaluatedAt: dependencies.now?.() ?? new Date(),
      providerModel,
    });
  }
}

async function withTempMedia<T>(bytes: Uint8Array, work: (path: string, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "final-qa-"));
  const path = join(dir, "final.mp4");
  try {
    await writeFile(path, bytes);
    return await work(path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function defaultProbeMedia(bytes: Uint8Array): Promise<FinalMediaProbe> {
  return withTempMedia(bytes, async (path) => {
    const result = await probeMedia(path);
    return {
      formatName: result.formatName ?? "",
      durationSeconds: result.durationSeconds,
      streams: [
        {
          type: "video" as const,
          codecName: result.video.codec,
          width: result.video.width,
          height: result.video.height,
          averageFrameRate: result.video.fps ?? 0,
        },
        ...(result.audio
          ? [{ type: "audio" as const, codecName: result.audio.codec, durationSeconds: result.durationSeconds, channels: result.audio.channels ?? 0 }]
          : []),
      ],
    };
  });
}

function parseAudioAnalysis(stderr: string, durationSeconds: number): FinalAudioAnalysis {
  const silenceStarts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  const silenceEnds = [...stderr.matchAll(/silence_end:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  const peakPairs = [...stderr.matchAll(/Peak level dB:\s*(-?inf|[-+0-9.]+)[\s\S]*?Peak count:\s*([0-9.]+)/gi)];
  const clippedSampleCount = peakPairs.reduce((maximum, match) => {
    const peakDb = match[1].toLowerCase() === "-inf" ? Number.NEGATIVE_INFINITY : Number(match[1]);
    const peakCount = Number(match[2]);
    return Number.isFinite(peakDb) && peakDb >= -0.01 && Number.isFinite(peakCount)
      ? Math.max(maximum, peakCount)
      : maximum;
  }, 0);
  const leadingSilenceSeconds = silenceStarts[0] === 0 && silenceEnds[0] !== undefined ? silenceEnds[0] : 0;
  const lastStart = silenceStarts.at(-1);
  const lastEnd = silenceEnds.at(-1);
  const trailingSilenceSeconds =
    lastStart !== undefined &&
    lastStart < durationSeconds &&
    lastEnd !== undefined &&
    lastEnd >= durationSeconds - 0.01
      ? durationSeconds - lastStart
      : 0;
  return { leadingSilenceSeconds, trailingSilenceSeconds, clippedSampleCount };
}

async function defaultAnalyzeAudio(bytes: Uint8Array, durationSeconds: number): Promise<FinalAudioAnalysis> {
  return withTempMedia(bytes, async (path) => {
    const result = await runFfmpeg({
      binary: process.env.FFMPEG_PATH ?? "ffmpeg",
      args: ["-v", "info", "-i", path, "-af", "silencedetect=noise=-50dB:d=0.05,astats=metadata=1:reset=0", "-f", "null", "-"],
      timeoutMs: 60_000,
    });
    return parseAudioAnalysis(result.stderr, durationSeconds);
  });
}

async function defaultExtractFrames(bytes: Uint8Array, durationSeconds: number): Promise<ExtractedFrame[]> {
  return withTempMedia(bytes, async (path, dir) => {
    const framesDir = join(dir, "frames");
    await mkdir(framesDir, { recursive: true });
    const timestamps = computeSampleTimestamps(durationSeconds, DEFAULT_FRAME_SAMPLING);
    const frames: ExtractedFrame[] = [];
    for (const [index, timestamp] of timestamps.entries()) {
      const output = join(framesDir, `${String(index).padStart(3, "0")}.jpg`);
      await runFfmpeg({
        binary: process.env.FFMPEG_PATH ?? "ffmpeg",
        args: ["-y", "-v", "error", "-ss", String(timestamp), "-i", path, "-frames:v", "1", "-vf", "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease", "-q:v", "3", output],
        timeoutMs: 30_000,
      });
      frames.push({
        timestampMs: Math.round(timestamp * 1000),
        data: (await readFile(output)).toString("base64"),
        mediaType: "image/jpeg",
      });
    }
    return frames;
  });
}

export const __finalQaInternals = { parseAudioAnalysis };
