import { describe, expect, it } from "vitest";
import { FINAL_VIDEO_STATUSES, OPERATION_KINDS, REQUIRED_NEXT_ACTION_TYPES } from "../constants";
import {
  AssemblyManifestSchema,
  FinalVideoAssetSchema,
  RequiredNextActionSchema,
  isFinalReadyInvariantSatisfied,
} from "../schemas";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const validAssemblyManifest = {
  version: "assembly-manifest-v1",
  clips: [
    {
      order: 0,
      slotId: "N1",
      assetId: "asset-1",
      assetSha256: SHA_A,
      approvalStatus: "APPROVED",
      trimStartSeconds: 0,
      trimEndSeconds: 4,
      durationSeconds: 4,
      nativeAudioMode: "mute",
    },
    {
      order: 1,
      slotId: "N3",
      assetId: "asset-2",
      assetSha256: SHA_B,
      approvalStatus: "APPROVED",
      trimStartSeconds: 0,
      trimEndSeconds: 6,
      durationSeconds: 6,
      nativeAudioMode: "duck",
    },
  ],
  audio: {
    assetId: "audio-1",
    assetSha256: SHA_A,
    durationSeconds: 10,
  },
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    voiceoverGainDb: 0,
    nativeAudioGainDb: -18,
    duckingThresholdDb: -24,
    expectedDurationSeconds: 10,
  },
  ffmpegVersion: "7.1.1",
} as const;

describe("final output contract", () => {
  it("exports the required actions and operation kinds without changing transition behavior", () => {
    expect(REQUIRED_NEXT_ACTION_TYPES).toContain("GENERATE_VOICEOVER");
    expect(REQUIRED_NEXT_ACTION_TYPES).toContain("ASSEMBLE_FINAL");
    expect(REQUIRED_NEXT_ACTION_TYPES).toContain("RUN_FINAL_QA");
    expect(OPERATION_KINDS).toContain("voiceover_generation");
    expect(OPERATION_KINDS).toContain("final_assembly");

    expect(RequiredNextActionSchema.parse({ type: "GENERATE_VOICEOVER" })).toEqual({
      type: "GENERATE_VOICEOVER",
    });
    expect(
      RequiredNextActionSchema.parse({ type: "ASSEMBLE_FINAL", finalVideoId: "final-1" }),
    ).toEqual({ type: "ASSEMBLE_FINAL", finalVideoId: "final-1" });
    expect(
      RequiredNextActionSchema.parse({ type: "RUN_FINAL_QA", finalVideoId: "final-1" }),
    ).toEqual({ type: "RUN_FINAL_QA", finalVideoId: "final-1" });
  });

  it("accepts an ordered assembly manifest with approved hashed sources and exact trims", () => {
    expect(AssemblyManifestSchema.parse(validAssemblyManifest)).toEqual(validAssemblyManifest);
  });

  it.each([
    ["duplicate clip", (value: any) => (value.clips[1].assetId = value.clips[0].assetId)],
    ["duplicate slot", (value: any) => (value.clips[1].slotId = value.clips[0].slotId)],
    ["unordered clip", (value: any) => (value.clips[1].order = 3)],
    ["unapproved source", (value: any) => (value.clips[0].approvalStatus = "REJECTED")],
    ["invalid hash", (value: any) => (value.clips[0].assetSha256 = "not-a-hash")],
    ["negative trim", (value: any) => (value.clips[0].trimStartSeconds = -1)],
    ["trim mismatch", (value: any) => (value.clips[0].durationSeconds = 3)],
    ["invalid audio mode", (value: any) => (value.clips[0].nativeAudioMode = "replace")],
    ["invalid dimensions", (value: any) => (value.output.width = 0)],
    ["invalid fps", (value: any) => (value.output.fps = 0)],
    ["invalid mix", (value: any) => (value.output.nativeAudioGainDb = -100)],
    ["duration mismatch", (value: any) => (value.output.expectedDurationSeconds = 9)],
    ["unknown field", (value: any) => (value.providerUrl = "https://attacker.example")],
  ])("rejects %s", (_label, mutate) => {
    const value: any = structuredClone(validAssemblyManifest);
    mutate(value);
    expect(AssemblyManifestSchema.safeParse(value).success).toBe(false);
  });

  it("defines strict FinalVideoAsset lifecycle, persisted media, validation, and QA fields", () => {
    expect(FINAL_VIDEO_STATUSES).toEqual([
      "PENDING",
      "VOICEOVER_READY",
      "ASSEMBLING",
      "ASSEMBLED",
      "MEDIA_VALIDATED",
      "QA_RUNNING",
      "APPROVED",
      "HUMAN_REVIEW",
      "FAILED",
    ]);
    const asset = {
      id: "final-1",
      contentRunId: "run-1",
      attempt: 1,
      status: "APPROVED",
      voiceover: {
        script: "Frozen narration.",
        provider: "elevenlabs",
        voiceId: "voice-1",
        model: "eleven-multilingual-v2",
      },
      audioAsset: {
        bucket: "private-media",
        key: "runs/run-1/voice.mp3",
        contentType: "audio/mpeg",
        bytes: 1234,
        sha256: SHA_A,
        durationSeconds: 10,
      },
      assemblyManifest: validAssemblyManifest,
      finalMp4: {
        bucket: "private-media",
        key: "runs/run-1/final.mp4",
        contentType: "video/mp4",
        bytes: 4567,
        sha256: SHA_B,
        durationSeconds: 10,
        width: 1080,
        height: 1920,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      mediaValidation: { passed: true, validatedAt: "2026-08-20T20:00:00.000Z" },
      finalQa: {
        status: "APPROVED",
        score: 95,
        verdict: "Final audiovisual output approved",
        evaluatedAt: "2026-08-20T20:01:00.000Z",
      },
    } as const;
    expect(FinalVideoAssetSchema.parse(asset)).toEqual(asset);
    expect(FinalVideoAssetSchema.safeParse({ ...asset, workspaceId: "forbidden" }).success).toBe(
      false,
    );
  });

  it("requires every final READY invariant", () => {
    const allTrue = {
      requiredSourceAssetsApproved: true,
      voiceoverPersisted: true,
      finalMp4Persisted: true,
      deterministicMediaValidationPassed: true,
      finalAudiovisualQaApproved: true,
    };
    expect(isFinalReadyInvariantSatisfied(allTrue)).toBe(true);
    for (const key of Object.keys(allTrue)) {
      expect(
        isFinalReadyInvariantSatisfied({ ...allTrue, [key]: false }),
        `${key} must be mandatory`,
      ).toBe(false);
    }
  });
});
