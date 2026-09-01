import type { AssemblyManifest } from "@/lib/content-runs/types";

export interface FinalMediaProbe {
  formatName: string;
  durationSeconds: number;
  streams: ReadonlyArray<
    | {
        type: "video";
        codecName: string;
        width: number;
        height: number;
        averageFrameRate: string | number;
      }
    | {
        type: "audio";
        codecName: string;
        durationSeconds: number;
        channels: number;
      }
  >;
}

export interface FinalAudioAnalysis {
  leadingSilenceSeconds: number;
  trailingSilenceSeconds: number;
  clippedSampleCount: number;
}

export interface FinalMediaSourceEvidence {
  clips: ReadonlyArray<{
    order: number;
    slotId: string;
    assetId: string;
    sha256: string;
  }>;
  audio: { assetId: string; sha256: string };
}

export interface FinalMediaValidationLimits {
  durationToleranceSeconds: number;
  fpsTolerance: number;
  maxLeadingSilenceSeconds: number;
  maxTrailingSilenceSeconds: number;
  maxClippedSampleCount: number;
}

export type FinalMediaValidationFailureCode =
  | "OBJECT_BYTES_MISMATCH"
  | "OBJECT_HASH_MISMATCH"
  | "MANIFEST_INVALID"
  | "CONTAINER_NOT_MP4"
  | "VIDEO_STREAM_INVALID"
  | "AUDIO_STREAM_INVALID"
  | "DIMENSIONS_MISMATCH"
  | "FPS_MISMATCH"
  | "DURATION_MISMATCH"
  | "LEADING_SILENCE_EXCESSIVE"
  | "TRAILING_SILENCE_EXCESSIVE"
  | "AUDIO_CLIPPING"
  | "CLIP_COUNT_MISMATCH"
  | "CLIP_SOURCE_MISMATCH"
  | "AUDIO_SOURCE_MISMATCH";

export interface FinalMediaValidationResult {
  passed: boolean;
  failures: ReadonlyArray<{ code: FinalMediaValidationFailureCode; message: string }>;
}

export interface FinalMediaValidationInput {
  manifest: AssemblyManifest;
  probe: FinalMediaProbe;
  analysis: FinalAudioAnalysis;
  sources: FinalMediaSourceEvidence;
  limits: FinalMediaValidationLimits;
}

function parseFrameRate(value: string | number): number {
  if (typeof value === "number") return value;
  const [numerator, denominator = "1"] = value.split("/");
  return Number(numerator) / Number(denominator);
}

export function validateFinalMedia(input: FinalMediaValidationInput): FinalMediaValidationResult {
  const failures: Array<{ code: FinalMediaValidationFailureCode; message: string }> = [];
  const fail = (code: FinalMediaValidationFailureCode, message: string) => {
    failures.push({ code, message });
  };

  const formats = input.probe.formatName.toLowerCase().split(",").map((value) => value.trim());
  if (!formats.includes("mp4")) {
    fail("CONTAINER_NOT_MP4", `Expected MP4 container; probed ${input.probe.formatName || "unknown"}.`);
  }

  const video = input.probe.streams.find((stream) => stream.type === "video");
  if (!video || !["h264", "avc1"].includes(video.codecName.toLowerCase())) {
    fail("VIDEO_STREAM_INVALID", "A nonempty H.264-compatible video stream is required.");
  }

  const audio = input.probe.streams.find((stream) => stream.type === "audio");
  if (
    !audio ||
    !["aac", "mp4a"].includes(audio.codecName.toLowerCase()) ||
    !Number.isFinite(audio.durationSeconds) ||
    audio.durationSeconds <= 0 ||
    !Number.isInteger(audio.channels) ||
    audio.channels <= 0
  ) {
    fail("AUDIO_STREAM_INVALID", "A nonempty AAC audio stream is required.");
  }

  if (video) {
    if (
      video.width !== 1080 ||
      video.height !== 1920 ||
      input.manifest.output.width !== 1080 ||
      input.manifest.output.height !== 1920
    ) {
      fail(
        "DIMENSIONS_MISMATCH",
        `Expected canonical 1080x1920 portrait output; manifest is ${input.manifest.output.width}x${input.manifest.output.height} and probe is ${video.width}x${video.height}.`,
      );
    }
    const probedFps = parseFrameRate(video.averageFrameRate);
    if (
      !Number.isFinite(probedFps) ||
      Math.abs(probedFps - input.manifest.output.fps) > input.limits.fpsTolerance
    ) {
      fail("FPS_MISMATCH", `Expected ${input.manifest.output.fps} fps; probed ${String(video.averageFrameRate)}.`);
    }
  }

  if (
    !Number.isFinite(input.probe.durationSeconds) ||
    Math.abs(input.probe.durationSeconds - input.manifest.output.expectedDurationSeconds) >
      input.limits.durationToleranceSeconds
  ) {
    fail(
      "DURATION_MISMATCH",
      `Expected ${input.manifest.output.expectedDurationSeconds}s within ±${input.limits.durationToleranceSeconds}s; probed ${input.probe.durationSeconds}s.`,
    );
  }

  if (input.analysis.leadingSilenceSeconds > input.limits.maxLeadingSilenceSeconds) {
    fail("LEADING_SILENCE_EXCESSIVE", "Leading silence exceeds the configured maximum.");
  }
  if (input.analysis.trailingSilenceSeconds > input.limits.maxTrailingSilenceSeconds) {
    fail("TRAILING_SILENCE_EXCESSIVE", "Trailing silence exceeds the configured maximum.");
  }
  if (input.analysis.clippedSampleCount > input.limits.maxClippedSampleCount) {
    fail("AUDIO_CLIPPING", "Clipped audio samples exceed the configured maximum.");
  }

  if (input.sources.clips.length !== input.manifest.clips.length) {
    fail(
      "CLIP_COUNT_MISMATCH",
      `Expected exactly ${input.manifest.clips.length} clips; received ${input.sources.clips.length}.`,
    );
  } else {
    const mismatch = input.manifest.clips.some((expected, index) => {
      const actual = input.sources.clips[index];
      return (
        actual.order !== expected.order ||
        actual.slotId !== expected.slotId ||
        actual.assetId !== expected.assetId ||
        actual.sha256 !== expected.assetSha256
      );
    });
    if (mismatch) {
      fail("CLIP_SOURCE_MISMATCH", "Clip order, identity, or hash does not exactly match the assembly manifest.");
    }
  }

  if (
    input.sources.audio.assetId !== input.manifest.audio.assetId ||
    input.sources.audio.sha256 !== input.manifest.audio.assetSha256
  ) {
    fail("AUDIO_SOURCE_MISMATCH", "Audio identity or hash does not match the assembly manifest.");
  }

  return { passed: failures.length === 0, failures };
}
