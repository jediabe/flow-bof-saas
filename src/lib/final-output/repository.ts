import { randomUUID } from "node:crypto";
import { Prisma, type FinalVideoAsset, type PrismaClient } from "@prisma/client";

import { compileStyleManifest } from "@/lib/content-styles/registry";
import { StyleManifestSchema } from "@/lib/content-styles/schemas";
import type { StyleManifest } from "@/lib/content-styles/types";
import { SLOT_DEFINITIONS } from "@/lib/content-runs/constants";
import { AssemblyManifestSchema } from "@/lib/content-runs/schemas";
import type {
  FinalOutputScope,
  FinalQaDecision,
  FrozenVoiceover,
  PersistedAudioMetadata,
  PersistedFinalMp4Metadata,
  TerminalFinalOutputFailure,
} from "./types";

export class FinalOutputRepositoryError extends Error {
  constructor(
    readonly code:
      | "FINAL_OUTPUT_NOT_FOUND"
      | "FINAL_OUTPUT_WORKSPACE_MISMATCH"
      | "FINAL_OUTPUT_IDEMPOTENCY_CONFLICT"
      | "FINAL_OUTPUT_STAGE_CONFLICT"
      | "FINAL_OUTPUT_INVALID_METADATA",
    message: string,
  ) {
    super(message);
    this.name = "FinalOutputRepositoryError";
  }
}

export interface FinalOutputRepository {
  reserve(scope: FinalOutputScope, voiceover: FrozenVoiceover): Promise<FinalVideoAsset>;
  find(scope: FinalOutputScope): Promise<FinalVideoAsset | null>;
  persistVoiceover(
    scope: FinalOutputScope,
    finalVideoId: string,
    metadata: PersistedAudioMetadata,
  ): Promise<FinalVideoAsset>;
  persistAssemblyManifest(
    scope: FinalOutputScope,
    finalVideoId: string,
    manifest: unknown,
  ): Promise<FinalVideoAsset>;
  persistFinalMp4(
    scope: FinalOutputScope,
    finalVideoId: string,
    metadata: PersistedFinalMp4Metadata,
  ): Promise<FinalVideoAsset>;
  startFinalQa(scope: FinalOutputScope, finalVideoId: string): Promise<FinalVideoAsset>;
  completeFinalQa(
    scope: FinalOutputScope,
    finalVideoId: string,
    decision: FinalQaDecision,
  ): Promise<FinalVideoAsset>;
  recordTerminalFailure(
    scope: FinalOutputScope,
    finalVideoId: string,
    failure: TerminalFinalOutputFailure,
  ): Promise<FinalVideoAsset>;
}

function knownPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function uniqueConstraintError(error: unknown): boolean {
  if (knownPrismaError(error, "P2002")) return true;
  if (!knownPrismaError(error, "P2010")) return false;
  const databaseCode = String(
    (error as Prisma.PrismaClientKnownRequestError).meta?.code ?? "",
  );
  return databaseCode === "2067" || databaseCode === "23505";
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

async function loadFrozenStyleManifest(
  prisma: PrismaClient,
  scope: FinalOutputScope,
): Promise<StyleManifest> {
  const run = await prisma.contentRun.findFirst({
    where: {
      id: scope.contentRunId,
      product: { batch: { workspaceId: scope.workspaceId } },
    },
    select: { style: true, promptSnapshotJson: true },
  });
  if (!run) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_WORKSPACE_MISMATCH",
      "Content run does not belong to this workspace",
    );
  }
  try {
    const snapshot = JSON.parse(run.promptSnapshotJson ?? "") as Record<string, unknown>;
    const specVersion = typeof snapshot.specVersion === "string" ? snapshot.specVersion : "";
    const snapshotStyle = typeof snapshot.style === "string" ? snapshot.style : run.style;
    if (snapshotStyle !== run.style) throw new Error("style mismatch");
    const frozen = snapshot.styleManifest
      ? StyleManifestSchema.parse(snapshot.styleManifest)
      : compileStyleManifest(
          run.style,
          specVersion,
          typeof snapshot.variant === "string"
            ? snapshot.variant
            : run.style === "style1"
              ? "store_discovery"
              : "",
        );
    if (frozen.styleId !== run.style || frozen.version !== specVersion) {
      throw new Error("manifest identity mismatch");
    }
    return frozen;
  } catch {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_STAGE_CONFLICT",
      "Content run does not have an approved frozen style policy",
    );
  }
}

function assertAssemblyPolicy(
  manifest: ReturnType<typeof AssemblyManifestSchema.parse>,
  policy: StyleManifest,
): void {
  const actual = {
    clips: manifest.clips.map(
      ({ order, slotId, trimStartSeconds, trimEndSeconds, durationSeconds, nativeAudioMode }) => ({
        order,
        slotId,
        trimStartSeconds,
        trimEndSeconds,
        durationSeconds,
        nativeAudioMode,
      }),
    ),
    output: manifest.output,
  };
  const expected = {
    clips: policy.assembly.clips,
    output: {
      width: policy.assembly.output.width,
      height: policy.assembly.output.height,
      fps: policy.assembly.output.fps,
      voiceoverGainDb: policy.assembly.output.audioMix.voiceoverGainDb,
      nativeAudioGainDb: policy.assembly.output.audioMix.nativeAudioGainDb,
      duckingThresholdDb: policy.assembly.output.audioMix.duckingThresholdDb,
      expectedDurationSeconds: policy.assembly.output.finalDurationSeconds,
    },
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_STAGE_CONFLICT",
      "Assembly manifest does not match the run's frozen style policy",
    );
  }
}

function assertFinalMp4Policy(
  mp4: PersistedFinalMp4Metadata,
  policy: StyleManifest,
): void {
  if (
    mp4.durationSeconds !== policy.assembly.output.finalDurationSeconds ||
    mp4.width !== policy.assembly.output.width ||
    mp4.height !== policy.assembly.output.height ||
    mp4.videoCodec !== policy.finalOutput.videoCodec ||
    mp4.audioCodec !== policy.finalOutput.audioCodec
  ) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_STAGE_CONFLICT",
      "Final MP4 metadata does not match the run's frozen output policy",
    );
  }
}

function safeToken(value: string, field: string, max = 1024): string {
  if (!value || value !== value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      `${field} must be a non-empty safe token`,
    );
  }
  return value;
}

function nonEmptyText(value: string, field: string, max: number): string {
  if (!value.trim() || value !== value.trim() || value.length > max || /[\u0000\u007f]/.test(value)) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      `${field} must be non-empty bounded text`,
    );
  }
  return value;
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      `${field} must be positive`,
    );
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      `${field} must be a positive integer`,
    );
  }
  return value;
}

function sha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      "sha256 must be a lowercase SHA-256 digest",
    );
  }
  return value;
}

function validateVoiceover(input: FrozenVoiceover): FrozenVoiceover {
  if (input.provider !== "elevenlabs") {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      "Unsupported frozen voiceover provider",
    );
  }
  return {
    script: nonEmptyText(input.script, "script", 10_000),
    provider: input.provider,
    voiceId: safeToken(input.voiceId, "voiceId", 200),
    model: safeToken(input.model, "model", 200),
  };
}

function validateAudio(input: PersistedAudioMetadata): PersistedAudioMetadata {
  if (input.contentType !== "audio/mpeg" && input.contentType !== "audio/wav") {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      "Unsupported voiceover content type",
    );
  }
  return {
    bucket: safeToken(input.bucket, "bucket", 200),
    key: safeToken(input.key, "key"),
    contentType: input.contentType,
    bytes: positiveInteger(input.bytes, "bytes"),
    sha256: sha256(input.sha256),
    durationSeconds: positive(input.durationSeconds, "durationSeconds"),
  };
}

function validateMp4(input: PersistedFinalMp4Metadata): PersistedFinalMp4Metadata {
  if (input.contentType !== "video/mp4" || !(input.mediaValidatedAt instanceof Date) || Number.isNaN(input.mediaValidatedAt.valueOf())) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      "Final MP4 requires successful hash and media probe metadata",
    );
  }
  return {
    bucket: safeToken(input.bucket, "bucket", 200),
    key: safeToken(input.key, "key"),
    contentType: input.contentType,
    bytes: positiveInteger(input.bytes, "bytes"),
    sha256: sha256(input.sha256),
    durationSeconds: positive(input.durationSeconds, "durationSeconds"),
    width: positiveInteger(input.width, "width"),
    height: positiveInteger(input.height, "height"),
    videoCodec: safeToken(input.videoCodec, "videoCodec", 80),
    audioCodec: safeToken(input.audioCodec, "audioCodec", 80),
    mediaValidatedAt: input.mediaValidatedAt,
  };
}

function validateFinalQaDecision(input: FinalQaDecision): FinalQaDecision {
  if (!(["APPROVED", "HUMAN_REVIEW", "FAILED"] as string[]).includes(input.status)) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      "Final QA decision status is invalid",
    );
  }
  if (
    input.score !== null &&
    (!Number.isInteger(input.score) || input.score < 0 || input.score > 100)
  ) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      "Final QA score must be an integer from 0 to 100",
    );
  }
  if (!(input.evaluatedAt instanceof Date) || Number.isNaN(input.evaluatedAt.valueOf())) {
    throw new FinalOutputRepositoryError(
      "FINAL_OUTPUT_INVALID_METADATA",
      "Final QA evaluated timestamp must be a valid date",
    );
  }
  return { ...input, verdict: nonEmptyText(input.verdict, "verdict", 5000) };
}

function sameVoiceover(row: FinalVideoAsset, voiceover: FrozenVoiceover): boolean {
  return (
    row.voiceoverScript === voiceover.script &&
    row.voiceoverProvider === voiceover.provider &&
    row.voiceoverVoiceId === voiceover.voiceId &&
    row.voiceoverModel === voiceover.model
  );
}

function sameAudio(row: FinalVideoAsset, audio: PersistedAudioMetadata): boolean {
  return (
    row.audioStorageBucket === audio.bucket &&
    row.audioStorageKey === audio.key &&
    row.audioContentType === audio.contentType &&
    row.audioBytes === audio.bytes &&
    row.audioSha256 === audio.sha256 &&
    row.audioDurationSeconds === audio.durationSeconds
  );
}

function sameMp4(row: FinalVideoAsset, mp4: PersistedFinalMp4Metadata): boolean {
  return (
    row.finalStorageBucket === mp4.bucket &&
    row.finalStorageKey === mp4.key &&
    row.finalContentType === mp4.contentType &&
    row.finalBytes === mp4.bytes &&
    row.finalSha256 === mp4.sha256 &&
    row.finalDurationSeconds === mp4.durationSeconds &&
    row.finalWidth === mp4.width &&
    row.finalHeight === mp4.height &&
    row.finalVideoCodec === mp4.videoCodec &&
    row.finalAudioCodec === mp4.audioCodec &&
    row.mediaValidationPassed === true &&
    row.mediaValidatedAt?.valueOf() === mp4.mediaValidatedAt.valueOf()
  );
}

export function createFinalOutputRepository(prisma: PrismaClient): FinalOutputRepository {
  async function find(scope: FinalOutputScope): Promise<FinalVideoAsset | null> {
    const row = await prisma.finalVideoAsset.findFirst({
      where: {
        contentRunId: scope.contentRunId,
        contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
      },
    });
    if (row) return row;

    const exists = await prisma.contentRun.count({ where: { id: scope.contentRunId } });
    if (exists) {
      throw new FinalOutputRepositoryError(
        "FINAL_OUTPUT_WORKSPACE_MISMATCH",
        "Content run does not belong to this workspace",
      );
    }
    return null;
  }

  async function required(scope: FinalOutputScope, finalVideoId: string): Promise<FinalVideoAsset> {
    const row = await find(scope);
    if (!row || row.id !== finalVideoId) {
      throw new FinalOutputRepositoryError(
        "FINAL_OUTPUT_NOT_FOUND",
        "Final output was not found in this workspace and run",
      );
    }
    return row;
  }

  async function afterCas(
    scope: FinalOutputScope,
    finalVideoId: string,
    count: number,
  ): Promise<FinalVideoAsset> {
    const row = await required(scope, finalVideoId);
    if (count !== 1) return row;
    return row;
  }

  return {
    find,

    async reserve(scope, input) {
      const voiceover = validateVoiceover(input);
      const finalVideoId = randomUUID();
      let inserted = 0;
      try {
        inserted = await prisma.$executeRaw`
          INSERT INTO "FinalVideoAsset" (
            "id", "contentRunId", "voiceoverScript", "voiceoverProvider",
            "voiceoverVoiceId", "voiceoverModel"
          )
          SELECT
            ${finalVideoId}, run."id", ${voiceover.script}, ${voiceover.provider},
            ${voiceover.voiceId}, ${voiceover.model}
          FROM "ContentRun" AS run
          INNER JOIN "Product" AS product ON product."id" = run."productId"
          INNER JOIN "Batch" AS batch ON batch."id" = product."batchId"
          WHERE run."id" = ${scope.contentRunId}
            AND batch."workspaceId" = ${scope.workspaceId}
        `;
      } catch (error) {
        if (!uniqueConstraintError(error)) throw error;
      }

      if (inserted === 1) {
        return required(scope, finalVideoId);
      }

      const existing = await find(scope);
      if (!existing) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_NOT_FOUND",
          "Content run was not found in this workspace",
        );
      }
      if (!sameVoiceover(existing, voiceover)) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_IDEMPOTENCY_CONFLICT",
          "Final output is already reserved with different frozen voiceover configuration",
        );
      }
      return existing;
    },

    async persistVoiceover(scope, finalVideoId, input) {
      const audio = validateAudio(input);
      const current = await required(scope, finalVideoId);
      if (sameAudio(current, audio)) return current;
      if (current.status !== "PENDING" || current.audioStorageKey !== null) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          "Persisted voiceover metadata cannot be overwritten",
        );
      }
      const result = await prisma.finalVideoAsset.updateMany({
        where: {
          id: finalVideoId,
          contentRunId: scope.contentRunId,
          contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
          status: "PENDING",
          audioStorageKey: null,
        },
        data: {
          audioStorageBucket: audio.bucket,
          audioStorageKey: audio.key,
          audioContentType: audio.contentType,
          audioBytes: audio.bytes,
          audioSha256: audio.sha256,
          audioDurationSeconds: audio.durationSeconds,
          status: "VOICEOVER_READY",
        },
      });
      const row = await afterCas(scope, finalVideoId, result.count);
      if (!sameAudio(row, audio)) {
        throw new FinalOutputRepositoryError("FINAL_OUTPUT_STAGE_CONFLICT", "Voiceover persistence conflict");
      }
      return row;
    },

    async persistAssemblyManifest(scope, finalVideoId, input) {
      const manifest = AssemblyManifestSchema.parse(input);
      const json = canonicalJson(manifest);
      const current = await required(scope, finalVideoId);
      const frozenStyle = await loadFrozenStyleManifest(prisma, scope);
      assertAssemblyPolicy(manifest, frozenStyle);
      if (
        manifest.audio.assetSha256 !== current.audioSha256 ||
        manifest.audio.durationSeconds !== current.audioDurationSeconds
      ) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          "Assembly manifest audio provenance does not match the persisted voiceover",
        );
      }
      const persistedSources = await prisma.flowGeneratedVideo.findMany({
        where: {
          id: { in: manifest.clips.map((clip) => clip.assetId) },
          contentRunId: scope.contentRunId,
          qaStatus: "APPROVED",
        },
        select: { id: true, storageSha256: true, sceneLabel: true },
      });
      const sourcesById = new Map(
        persistedSources.map((source) => [source.id, source]),
      );
      if (
        persistedSources.length !== manifest.clips.length ||
        manifest.clips.some((clip) => {
          const source = sourcesById.get(clip.assetId);
          const expectedSceneLabel =
            clip.slotId in SLOT_DEFINITIONS
              ? SLOT_DEFINITIONS[clip.slotId as keyof typeof SLOT_DEFINITIONS]
                  .persistedSceneLabel
              : clip.slotId;
          return (
            source?.storageSha256 !== clip.assetSha256 ||
            source.sceneLabel !== expectedSceneLabel
          );
        })
      ) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          "Assembly manifest source provenance is not approved for this run",
        );
      }
      if (current.assemblyManifestJson === json) return current;
      if (current.status !== "VOICEOVER_READY" || !current.audioSha256 || current.assemblyManifestJson !== null) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          current.audioSha256
            ? "Assembly manifest cannot be overwritten"
            : "Voiceover must be persisted before the assembly manifest",
        );
      }
      const result = await prisma.finalVideoAsset.updateMany({
        where: {
          id: finalVideoId,
          contentRunId: scope.contentRunId,
          contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
          status: "VOICEOVER_READY",
          assemblyManifestJson: null,
        },
        data: { assemblyManifestJson: json, status: "ASSEMBLING" },
      });
      const row = await afterCas(scope, finalVideoId, result.count);
      if (row.assemblyManifestJson !== json) {
        throw new FinalOutputRepositoryError("FINAL_OUTPUT_STAGE_CONFLICT", "Assembly manifest persistence conflict");
      }
      return row;
    },

    async persistFinalMp4(scope, finalVideoId, input) {
      const mp4 = validateMp4(input);
      const frozenStyle = await loadFrozenStyleManifest(prisma, scope);
      assertFinalMp4Policy(mp4, frozenStyle);
      const current = await required(scope, finalVideoId);
      if (sameMp4(current, mp4)) return current;
      if (
        current.status !== "ASSEMBLING" ||
        !current.audioSha256 ||
        !current.assemblyManifestJson ||
        current.finalStorageKey !== null
      ) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          "Voiceover and assembly manifest are required before final MP4 persistence",
        );
      }
      const result = await prisma.finalVideoAsset.updateMany({
        where: {
          id: finalVideoId,
          contentRunId: scope.contentRunId,
          contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
          status: "ASSEMBLING",
          finalStorageKey: null,
        },
        data: {
          finalStorageBucket: mp4.bucket,
          finalStorageKey: mp4.key,
          finalContentType: mp4.contentType,
          finalBytes: mp4.bytes,
          finalSha256: mp4.sha256,
          finalDurationSeconds: mp4.durationSeconds,
          finalWidth: mp4.width,
          finalHeight: mp4.height,
          finalVideoCodec: mp4.videoCodec,
          finalAudioCodec: mp4.audioCodec,
          mediaValidationPassed: true,
          mediaValidatedAt: mp4.mediaValidatedAt,
          status: "MEDIA_VALIDATED",
        },
      });
      const row = await afterCas(scope, finalVideoId, result.count);
      if (!sameMp4(row, mp4)) {
        throw new FinalOutputRepositoryError("FINAL_OUTPUT_STAGE_CONFLICT", "Final MP4 persistence conflict");
      }
      return row;
    },

    async startFinalQa(scope, finalVideoId) {
      const current = await required(scope, finalVideoId);
      if (current.status === "QA_RUNNING" && current.finalQaStatus === "QA_RUNNING") return current;
      if (current.status !== "MEDIA_VALIDATED" || current.mediaValidationPassed !== true) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          "A validated final MP4 is required before final QA",
        );
      }
      const result = await prisma.finalVideoAsset.updateMany({
        where: {
          id: finalVideoId,
          contentRunId: scope.contentRunId,
          contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
          status: "MEDIA_VALIDATED",
        },
        data: { status: "QA_RUNNING", finalQaStatus: "QA_RUNNING" },
      });
      const row = await afterCas(scope, finalVideoId, result.count);
      if (row.status !== "QA_RUNNING") {
        throw new FinalOutputRepositoryError("FINAL_OUTPUT_STAGE_CONFLICT", "Final QA start conflict");
      }
      return row;
    },

    async completeFinalQa(scope, finalVideoId, input) {
      const decision = validateFinalQaDecision(input);
      const current = await required(scope, finalVideoId);
      if (
        current.status === decision.status &&
        current.finalQaStatus === decision.status &&
        current.finalQaScore === decision.score &&
        current.finalQaVerdict === decision.verdict &&
        current.finalQaEvaluatedAt?.valueOf() === decision.evaluatedAt.valueOf()
      ) {
        return current;
      }
      if (current.status !== "QA_RUNNING" || current.finalQaStatus !== "QA_RUNNING") {
        throw new FinalOutputRepositoryError("FINAL_OUTPUT_STAGE_CONFLICT", "Final QA is not running");
      }
      const verdict = decision.verdict;
      const result = await prisma.finalVideoAsset.updateMany({
        where: {
          id: finalVideoId,
          contentRunId: scope.contentRunId,
          contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
          status: "QA_RUNNING",
          finalQaStatus: "QA_RUNNING",
        },
        data: {
          status: decision.status,
          finalQaStatus: decision.status,
          finalQaScore: decision.score,
          finalQaVerdict: verdict,
          finalQaEvaluatedAt: decision.evaluatedAt,
        },
      });
      const row = await afterCas(scope, finalVideoId, result.count);
      if (
        row.status !== decision.status ||
        row.finalQaStatus !== decision.status ||
        row.finalQaScore !== decision.score ||
        row.finalQaVerdict !== verdict ||
        row.finalQaEvaluatedAt?.valueOf() !== decision.evaluatedAt.valueOf()
      ) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          "Final QA CAS conflict: a different decision won the transition",
        );
      }
      return row;
    },

    async recordTerminalFailure(scope, finalVideoId, failure) {
      const current = await required(scope, finalVideoId);
      const code = safeToken(failure.code, "failure code", 200);
      if (
        !(failure.failedAt instanceof Date) ||
        Number.isNaN(failure.failedAt.valueOf())
      ) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_INVALID_METADATA",
          "Failure timestamp must be a valid date",
        );
      }
      const failureJson = canonicalJson(failure.details ?? null);
      if (
        current.status === "FAILED" &&
        current.failureCode === code &&
        current.failureJson === failureJson &&
        current.failedAt?.valueOf() === failure.failedAt.valueOf()
      ) {
        return current;
      }
      if (["APPROVED", "HUMAN_REVIEW", "FAILED"].includes(current.status)) {
        throw new FinalOutputRepositoryError("FINAL_OUTPUT_STAGE_CONFLICT", "Terminal final output cannot fail again");
      }
      const result = await prisma.finalVideoAsset.updateMany({
        where: {
          id: finalVideoId,
          contentRunId: scope.contentRunId,
          contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
          status: current.status,
        },
        data: {
          status: "FAILED",
          finalQaStatus: current.finalQaStatus === "APPROVED" ? "FAILED" : current.finalQaStatus,
          failureCode: code,
          failureJson,
          failedAt: failure.failedAt,
        },
      });
      const row = await afterCas(scope, finalVideoId, result.count);
      if (
        row.status !== "FAILED" ||
        row.failureCode !== code ||
        row.failureJson !== failureJson ||
        row.failedAt?.valueOf() !== failure.failedAt.valueOf()
      ) {
        throw new FinalOutputRepositoryError(
          "FINAL_OUTPUT_STAGE_CONFLICT",
          "Terminal failure CAS conflict: a different failure won the transition",
        );
      }
      return row;
    },
  };
}
