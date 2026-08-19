export const CONTENT_GENERATION_ERROR_CODES = [
  "WORKSPACE_PROVIDER_BUSY",
  "IDEMPOTENCY_CONFLICT",
  "CREATIVE_ATTEMPT_EXHAUSTED",
  "OPERATION_NOT_FOUND",
  "OPERATION_TERMINAL",
  "CONTENT_RUN_WORKSPACE_MISMATCH",
  "PROVIDER_JOB_ALREADY_ACCEPTED",
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
  technicalAttemptCount: number;
  resultJson: string | null;
  errorJson: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOperationInput {
  workspaceId: string;
  contentRunId: string;
  kind: ContentOperationKind;
  sceneLabel: string;
  idempotencyKey: string;
  provider?: string;
}

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
