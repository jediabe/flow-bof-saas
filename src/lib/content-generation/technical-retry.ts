import {
  ContentGenerationError,
  type ProviderFailureClassification,
} from "./types";

export const MAX_TECHNICAL_RETRIES = 2;
export const MAX_PROVIDER_TRANSPORT_ATTEMPTS = 1 + MAX_TECHNICAL_RETRIES;

export interface TechnicalRetryOperationState {
  providerJobId: string | null;
  technicalAttemptCount: number;
}

export interface ExecuteWithTechnicalRetriesInput<T> {
  operation: TechnicalRetryOperationState;
  execute: (attemptNumber: number) => Promise<T>;
  /** Persist the total transport-attempt count before each external call. */
  onAttempt?: (attemptNumber: number) => Promise<void> | void;
}

function isProviderFailureClassification(
  error: unknown,
): error is Error & ProviderFailureClassification {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & Partial<ProviderFailureClassification>;
  return (
    (candidate.classification === "technical-retryable" ||
      candidate.classification === "terminal-nontechnical") &&
    typeof candidate.acceptedProviderIdentity === "boolean"
  );
}

export function isSafeTechnicalRetry(error: unknown): boolean {
  return (
    isProviderFailureClassification(error) &&
    error.classification === "technical-retryable" &&
    !error.acceptedProviderIdentity
  );
}

/**
 * Execute a provider start/synchronous generation call using the persisted
 * operation retry budget. A known provider job ID is a hard stop: callers must
 * resume/poll that job instead of invoking this helper again.
 */
export async function executeWithTechnicalRetries<T>(
  input: ExecuteWithTechnicalRetriesInput<T>,
): Promise<T> {
  const { operation, execute, onAttempt } = input;

  if (operation.providerJobId) {
    throw new ContentGenerationError(
      "PROVIDER_JOB_ALREADY_ACCEPTED",
      "The provider already accepted this operation; resume it instead of starting again",
      { providerJobId: operation.providerJobId },
    );
  }

  if (
    !Number.isInteger(operation.technicalAttemptCount) ||
    operation.technicalAttemptCount < 0 ||
    operation.technicalAttemptCount >= MAX_PROVIDER_TRANSPORT_ATTEMPTS
  ) {
    throw new ContentGenerationError(
      "TECHNICAL_RETRY_EXHAUSTED",
      "The safe technical retry budget is exhausted",
      { technicalAttemptCount: operation.technicalAttemptCount },
    );
  }

  let attemptNumber = operation.technicalAttemptCount;
  while (attemptNumber < MAX_PROVIDER_TRANSPORT_ATTEMPTS) {
    attemptNumber += 1;
    await onAttempt?.(attemptNumber);

    try {
      return await execute(attemptNumber);
    } catch (error) {
      const hasAnotherAttempt =
        attemptNumber < MAX_PROVIDER_TRANSPORT_ATTEMPTS;
      if (!hasAnotherAttempt || !isSafeTechnicalRetry(error)) {
        throw error;
      }
    }
  }

  throw new ContentGenerationError(
    "TECHNICAL_RETRY_EXHAUSTED",
    "The safe technical retry budget is exhausted",
    { technicalAttemptCount: attemptNumber },
  );
}
