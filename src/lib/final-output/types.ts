import type { AssemblyManifest, FinalVideoStatus } from "@/lib/content-runs/types";

export interface QaTargetIds {
  imageId: string | null;
  videoId: string | null;
  finalVideoId: string | null;
}

export type QaTarget =
  | { kind: "image"; id: string }
  | { kind: "video"; id: string }
  | { kind: "finalVideo"; id: string };

export function assertExactlyOneQaTarget(target: QaTargetIds): QaTarget {
  const populated = [
    target.imageId ? ({ kind: "image", id: target.imageId } as const) : null,
    target.videoId ? ({ kind: "video", id: target.videoId } as const) : null,
    target.finalVideoId ? ({ kind: "finalVideo", id: target.finalVideoId } as const) : null,
  ].filter((value): value is QaTarget => value !== null);

  if (populated.length !== 1) {
    throw new TypeError("A QA attempt must target exactly one image, video, or final video");
  }
  return populated[0];
}

export interface FinalOutputScope {
  workspaceId: string;
  contentRunId: string;
}

export interface FrozenVoiceover {
  script: string;
  provider: "elevenlabs";
  voiceId: string;
  model: string;
}

export interface PersistedAudioMetadata {
  bucket: string;
  key: string;
  contentType: "audio/mpeg" | "audio/wav";
  bytes: number;
  sha256: string;
  durationSeconds: number;
}

export interface PersistedFinalMp4Metadata {
  bucket: string;
  key: string;
  contentType: "video/mp4";
  bytes: number;
  sha256: string;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  mediaValidatedAt: Date;
}

export interface FinalQaDecision {
  status: Extract<FinalVideoStatus, "APPROVED" | "HUMAN_REVIEW" | "FAILED">;
  score: number | null;
  verdict: string;
  evaluatedAt: Date;
}

export interface TerminalFinalOutputFailure {
  code: string;
  details?: unknown;
  failedAt: Date;
}

export type { AssemblyManifest };
