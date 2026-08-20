import type { ManagedVideoModel } from "@/lib/content-runs/constants";

export const CONTENT_GENERATION_ERROR_CODES = [
  "WORKSPACE_PROVIDER_BUSY",
  "IDEMPOTENCY_CONFLICT",
  "CREATIVE_ATTEMPT_EXHAUSTED",
  "OPERATION_NOT_FOUND",
  "OPERATION_TERMINAL",
  "CONTENT_RUN_WORKSPACE_MISMATCH",
  "PROVIDER_JOB_ALREADY_ACCEPTED",
  "PROVIDER_VIDEO_START_PERSISTENCE_FAILED",
  "PROVIDER_ATTEMPT_STALE",
  "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
  "PROVIDER_ATTEMPT_AUDIT_INVALID",
  "PROVIDER_ATTEMPT_LIMIT_REACHED",
  "AUDIO_RETRY_NOT_ALLOWED",
  "TECHNICAL_RETRY_EXHAUSTED",
] as const;

export type ContentGenerationErrorCode =
  (typeof CONTENT_GENERATION_ERROR_CODES)[number];

export class ContentGenerationError extends Error {
  readonly name = "ContentGenerationError";

  constructor(
    readonly code: ContentGenerationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ContentOperationKind = "image_generation" | "video_generation";
export type ContentOperationStatus =
  | "requested"
  | "running"
  | "succeeded"
  | "failed";

export interface VideoCreativeDirection {
  cameraMovement:
    | "locked_off"
    | "minimal_push_in"
    | "gentle_push_in"
    | "subtle_lateral_drift";
  pacing: "steady" | "unhurried" | "natural";
  framing: "stable_wide" | "stable_medium" | "stable_close";
  distance: "hold_distance" | "slight_approach" | "slight_retreat";
  interactionStyle:
    | "single_gentle_tap"
    | "single_gentle_touch"
    | "minimal_hand_interaction";
  movementIntensity: "minimal" | "low" | "moderate";
  preservationFocus: Array<
    | "label_layout"
    | "lettering_placement"
    | "nozzle_geometry"
    | "packaging_proportions"
    | "reflections"
    | "fine_product_features"
  >;
}

export interface ContentOperationRecord {
  id: string;
  workspaceId: string;
  contentRunId: string;
  kind: ContentOperationKind;
  sceneLabel: string;
  status: ContentOperationStatus;
  idempotencyKey: string;
  provider: string;
  providerJobId: string | null;
  providerAttemptNumber: number;
  providerAttemptsJson: string;
  technicalAttemptCount: number;
  creativeDirectionJson: string | null;
  resultJson: string | null;
  errorJson: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AcceptedProviderAttemptFailureKind = "audio_generation" | "provider";

export interface AcceptedProviderAttemptAudit {
  attemptNumber: number;
  providerJobId: string;
  model: ManagedVideoModel;
  transportAttemptCount: number;
  status: "running" | "succeeded" | "failed";
  failureKind: AcceptedProviderAttemptFailureKind | null;
  errorCode: string | null;
  acceptedAt: string;
  completedAt: string | null;
}

export interface RecordAcceptedVideoStartInput {
  attemptNumber: number;
  providerJobId: string;
  model: ManagedVideoModel;
  sourceImageId: string;
  sourceImageMediaGenerationId: string;
  audioRetryStartToken?: string;
}

export type TerminalizeProviderAttemptInput =
  | {
      attemptNumber: number;
      providerJobId: string;
      status: "succeeded";
      failureKind?: null;
      errorCode?: null;
    }
  | {
      attemptNumber: number;
      providerJobId: string;
      status: "failed";
      failureKind: AcceptedProviderAttemptFailureKind;
      errorCode?: string | null;
    };

export interface PrepareAudioRetryInput {
  attemptNumber: number;
  providerJobId: string;
}

interface CreateOperationBaseInput {
  workspaceId: string;
  contentRunId: string;
  sceneLabel: string;
  idempotencyKey: string;
  provider?: string;
}

export type CreateOperationInput = CreateOperationBaseInput &
  (
    | { kind: "image_generation"; creativeDirection?: never }
    | { kind: "video_generation"; creativeDirection?: VideoCreativeDirection }
  );

export interface OperationScope {
  workspaceId: string;
  operationId: string;
}

export interface WorkspaceProviderLockRecord {
  workspaceId: string;
  operationId: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export interface ProviderFailureClassification {
  classification: "technical-retryable" | "terminal-nontechnical";
  acceptedProviderIdentity: boolean;
}
