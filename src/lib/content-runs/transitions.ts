import { ALLOWED_CONTENT_RUN_TRANSITIONS } from "./constants";
import type { ContentRunState } from "./types";

export class IllegalContentRunTransitionError extends Error {
  readonly code = "ILLEGAL_CONTENT_RUN_TRANSITION" as const;

  constructor(
    readonly from: ContentRunState,
    readonly to: ContentRunState,
  ) {
    super(`ContentRun cannot transition from ${from} to ${to}.`);
    this.name = "IllegalContentRunTransitionError";
  }
}

export class ConcurrentContentRunTransitionError extends Error {
  readonly code = "CONTENT_RUN_STATE_CONFLICT" as const;

  constructor(
    readonly runId: string,
    readonly expectedState: ContentRunState,
  ) {
    super(`ContentRun ${runId} is no longer in expected state ${expectedState}.`);
    this.name = "ConcurrentContentRunTransitionError";
  }
}

export function isContentRunTransitionAllowed(
  from: ContentRunState,
  to: ContentRunState,
): boolean {
  return (ALLOWED_CONTENT_RUN_TRANSITIONS[from] as readonly ContentRunState[]).includes(to);
}

export function assertContentRunTransitionAllowed(
  from: ContentRunState,
  to: ContentRunState,
): void {
  if (!isContentRunTransitionAllowed(from, to)) {
    throw new IllegalContentRunTransitionError(from, to);
  }
}

export interface ContentRunTransitionRepository {
  updateMany(args: {
    where: { id: string; status: ContentRunState };
    data: { status: ContentRunState; completedAt?: Date };
  }): Promise<{ count: number }>;
}

export async function transitionContentRun(
  input: {
    runId: string;
    from: ContentRunState;
    to: ContentRunState;
  },
  repository: ContentRunTransitionRepository,
): Promise<void> {
  // Validate before constructing or issuing the persistence operation. This is
  // the boundary that prevents an illegal caller-controlled state write.
  assertContentRunTransitionAllowed(input.from, input.to);

  const data: { status: ContentRunState; completedAt?: Date } = {
    status: input.to,
  };
  if (input.to === "ready") {
    data.completedAt = new Date();
  }

  const result = await repository.updateMany({
    where: { id: input.runId, status: input.from },
    data,
  });
  if (result.count !== 1) {
    throw new ConcurrentContentRunTransitionError(input.runId, input.from);
  }
}
