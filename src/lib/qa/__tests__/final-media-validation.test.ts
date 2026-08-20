import { describe, expect, it } from "vitest";
import { validateFinalMedia } from "../final-media-validation";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_AUDIO = "c".repeat(64);

const manifest = {
  version: "assembly-manifest-v1" as const,
  clips: [
    {
      order: 0,
      slotId: "clip-1",
      assetId: "asset-1",
      assetSha256: SHA_A,
      approvalStatus: "APPROVED" as const,
      trimStartSeconds: 0,
      trimEndSeconds: 4,
      durationSeconds: 4,
      nativeAudioMode: "mute" as const,
    },
    {
      order: 1,
      slotId: "clip-2",
      assetId: "asset-2",
      assetSha256: SHA_B,
      approvalStatus: "APPROVED" as const,
      trimStartSeconds: 0,
      trimEndSeconds: 6,
      durationSeconds: 6,
      nativeAudioMode: "duck" as const,
    },
  ],
  audio: { assetId: "audio-1", assetSha256: SHA_AUDIO, durationSeconds: 10 },
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
};

function validInput() {
  return {
    manifest: structuredClone(manifest),
    probe: {
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      durationSeconds: 10.04,
      streams: [
        { type: "video" as const, codecName: "h264", width: 1080, height: 1920, averageFrameRate: "30/1" },
        { type: "audio" as const, codecName: "aac", durationSeconds: 10.04, channels: 2 },
      ],
    },
    analysis: { leadingSilenceSeconds: 0.1, trailingSilenceSeconds: 0.2, clippedSampleCount: 0 },
    sources: {
      clips: [
        { order: 0, slotId: "clip-1", assetId: "asset-1", sha256: SHA_A },
        { order: 1, slotId: "clip-2", assetId: "asset-2", sha256: SHA_B },
      ],
      audio: { assetId: "audio-1", sha256: SHA_AUDIO },
    },
    limits: {
      durationToleranceSeconds: 0.1,
      fpsTolerance: 0.01,
      maxLeadingSilenceSeconds: 0.5,
      maxTrailingSilenceSeconds: 0.5,
      maxClippedSampleCount: 0,
    },
  };
}

describe("validateFinalMedia", () => {
  it("accepts a conforming portrait MP4 whose exact ordered sources match the manifest", () => {
    expect(validateFinalMedia(validInput())).toEqual({ passed: true, failures: [] });
  });

  it("requires canonical 1080x1920 output even when probe and manifest drift together", () => {
    const input = validInput();
    input.manifest.output.width = 720;
    input.manifest.output.height = 1280;
    input.probe.streams[0] = { ...input.probe.streams[0], width: 720, height: 1280 } as never;
    expect(validateFinalMedia(input).failures.map((failure) => failure.code)).toContain(
      "DIMENSIONS_MISMATCH",
    );
  });

  it.each([
    ["CONTAINER_NOT_MP4", (input: ReturnType<typeof validInput>) => (input.probe.formatName = "matroska,webm")],
    ["VIDEO_STREAM_INVALID", (input: ReturnType<typeof validInput>) => (input.probe.streams[0] = { ...input.probe.streams[0], codecName: "vp9" } as never)],
    ["AUDIO_STREAM_INVALID", (input: ReturnType<typeof validInput>) => (input.probe.streams[1] = { ...input.probe.streams[1], codecName: "opus" } as never)],
    ["AUDIO_STREAM_INVALID", (input: ReturnType<typeof validInput>) => (input.probe.streams[1] = { ...input.probe.streams[1], durationSeconds: 0 } as never)],
    ["DIMENSIONS_MISMATCH", (input: ReturnType<typeof validInput>) => (input.probe.streams[0] = { ...input.probe.streams[0], width: 1920, height: 1080 } as never)],
    ["FPS_MISMATCH", (input: ReturnType<typeof validInput>) => (input.probe.streams[0] = { ...input.probe.streams[0], averageFrameRate: "24/1" } as never)],
    ["DURATION_MISMATCH", (input: ReturnType<typeof validInput>) => (input.probe.durationSeconds = 10.2)],
    ["LEADING_SILENCE_EXCESSIVE", (input: ReturnType<typeof validInput>) => (input.analysis.leadingSilenceSeconds = 0.51)],
    ["TRAILING_SILENCE_EXCESSIVE", (input: ReturnType<typeof validInput>) => (input.analysis.trailingSilenceSeconds = 0.51)],
    ["AUDIO_CLIPPING", (input: ReturnType<typeof validInput>) => (input.analysis.clippedSampleCount = 1)],
    ["CLIP_COUNT_MISMATCH", (input: ReturnType<typeof validInput>) => input.sources.clips.pop()],
    ["CLIP_SOURCE_MISMATCH", (input: ReturnType<typeof validInput>) => (input.sources.clips[1].sha256 = SHA_A)],
    ["CLIP_SOURCE_MISMATCH", (input: ReturnType<typeof validInput>) => input.sources.clips.reverse()],
    ["AUDIO_SOURCE_MISMATCH", (input: ReturnType<typeof validInput>) => (input.sources.audio.sha256 = SHA_A)],
  ])("fails closed with %s", (code, mutate) => {
    const input = structuredClone(validInput());
    mutate(input);
    const result = validateFinalMedia(input);
    expect(result.passed).toBe(false);
    expect(result.failures.map((failure) => failure.code)).toContain(code);
  });

  it("reports every deterministic violation in one evaluation", () => {
    const input = validInput();
    input.probe.formatName = "webm";
    input.analysis.leadingSilenceSeconds = 2;
    input.sources.audio.sha256 = SHA_A;
    expect(validateFinalMedia(input).failures.map((failure) => failure.code)).toEqual([
      "CONTAINER_NOT_MP4",
      "LEADING_SILENCE_EXCESSIVE",
      "AUDIO_SOURCE_MISMATCH",
    ]);
  });
});
