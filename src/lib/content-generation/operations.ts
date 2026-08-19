import {
  Prisma,
  type ContentOperation,
  type PrismaClient,
} from "@prisma/client";

import {
  ContentGenerationError,
  type ContentOperationRecord,
  type CreateOperationInput,
  type OperationScope,
} from "./types";

export interface OperationRepository {
  createOrResume(input: CreateOperationInput): Promise<ContentOperationRecord>;
  findById(scope: OperationScope): Promise<ContentOperationRecord | null>;
  markRunning(scope: OperationScope): Promise<ContentOperationRecord>;
  recordTechnicalAttempt(
    scope: OperationScope,
    attemptNumber: number,
  ): Promise<ContentOperationRecord>;
  recordProviderJobId(
    scope: OperationScope,
    providerJobId: string,
  ): Promise<ContentOperationRecord>;
  succeed(scope: OperationScope, result: unknown): Promise<ContentOperationRecord>;
  fail(scope: OperationScope, error: unknown): Promise<ContentOperationRecord>;
}

function isKnownPrismaError(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    codes.includes(error.code)
  );
}

function asOperation(operation: ContentOperation): ContentOperationRecord {
  if (
    operation.kind !== "image_generation" &&
    operation.kind !== "video_generation"
  ) {
    throw new Error(`Unsupported persisted operation kind: ${operation.kind}`);
  }
  if (
    operation.status !== "requested" &&
    operation.status !== "running" &&
    operation.status !== "succeeded" &&
    operation.status !== "failed"
  ) {
    throw new Error(`Unsupported persisted operation status: ${operation.status}`);
  }
  return operation as ContentOperationRecord;
}

function operationNotFound(scope: OperationScope): ContentGenerationError {
  return new ContentGenerationError(
    "OPERATION_NOT_FOUND",
    "Content operation was not found in this workspace",
    { operationId: scope.operationId },
  );
}

function requiredOperation(
  operation: ContentOperation | null,
  scope: OperationScope,
): ContentOperationRecord {
  if (!operation) throw operationNotFound(scope);
  return asOperation(operation);
}

function assertMutable(operation: ContentOperationRecord): void {
  if (operation.status === "succeeded" || operation.status === "failed") {
    throw new ContentGenerationError(
      "OPERATION_TERMINAL",
      "A terminal content operation cannot be mutated",
      { operationId: operation.id, status: operation.status },
    );
  }
}

function assertSameLogicalCommand(
  existing: ContentOperationRecord,
  input: CreateOperationInput,
): void {
  const provider = input.provider ?? "google_flow_useapi";
  if (
    existing.contentRunId !== input.contentRunId ||
    existing.kind !== input.kind ||
    existing.sceneLabel !== input.sceneLabel ||
    existing.provider !== provider
  ) {
    throw new ContentGenerationError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key is already bound to a different generation command",
      { operationId: existing.id },
    );
  }
}

function stringify(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "null" : json;
}

export function createOperationRepository(
  prisma: PrismaClient,
): OperationRepository {
  async function findScoped(
    scope: OperationScope,
  ): Promise<ContentOperationRecord | null> {
    const operation = await prisma.contentOperation.findFirst({
      where: { id: scope.operationId, workspaceId: scope.workspaceId },
    });
    return operation ? asOperation(operation) : null;
  }

  async function requireScoped(
    scope: OperationScope,
  ): Promise<ContentOperationRecord> {
    return requiredOperation(await findScoped(scope), scope);
  }

  async function createOrResumeTransaction(
    tx: Prisma.TransactionClient,
    input: CreateOperationInput,
  ): Promise<ContentOperationRecord> {
    const existing = await tx.contentOperation.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: input.workspaceId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      const operation = asOperation(existing);
      assertSameLogicalCommand(operation, input);
      return operation;
    }

    const run = await tx.contentRun.findFirst({
      where: {
        id: input.contentRunId,
        product: { batch: { workspaceId: input.workspaceId } },
      },
      select: { id: true },
    });
    if (!run) {
      throw new ContentGenerationError(
        "CONTENT_RUN_WORKSPACE_MISMATCH",
        "The content run does not belong to the authenticated workspace",
        { contentRunId: input.contentRunId },
      );
    }

    const reserved = await tx.contentOperation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contentRunId: input.contentRunId,
        kind: input.kind,
        sceneLabel: input.sceneLabel,
      },
      orderBy: { createdAt: "asc" },
    });
    if (reserved) {
      throw new ContentGenerationError(
        "CREATIVE_ATTEMPT_EXHAUSTED",
        "This managed content slot already has its one creative attempt",
        { operationId: reserved.id, contentRunId: input.contentRunId },
      );
    }

    return asOperation(
      await tx.contentOperation.create({
        data: {
          workspaceId: input.workspaceId,
          contentRunId: input.contentRunId,
          kind: input.kind,
          sceneLabel: input.sceneLabel,
          idempotencyKey: input.idempotencyKey,
          ...(input.provider ? { provider: input.provider } : {}),
        },
      }),
    );
  }

  async function createOrResume(
    input: CreateOperationInput,
  ): Promise<ContentOperationRecord> {
    for (let transactionAttempt = 1; transactionAttempt <= 3; transactionAttempt += 1) {
      try {
        return await prisma.$transaction(
          (tx) => createOrResumeTransaction(tx, input),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 10_000,
          },
        );
      } catch (error) {
        if (isKnownPrismaError(error, "P2002")) {
          const winner = await prisma.contentOperation.findUnique({
            where: {
              workspaceId_idempotencyKey: {
                workspaceId: input.workspaceId,
                idempotencyKey: input.idempotencyKey,
              },
            },
          });
          if (winner) {
            const operation = asOperation(winner);
            assertSameLogicalCommand(operation, input);
            return operation;
          }
        }
        if (
          transactionAttempt < 3 &&
          isKnownPrismaError(error, "P2034", "P2028")
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Unreachable transaction retry state");
  }

  async function persistTerminal(
    scope: OperationScope,
    data: {
      status: "succeeded" | "failed";
      resultJson?: string;
      errorJson?: string | null;
    },
  ): Promise<ContentOperationRecord> {
    const current = await requireScoped(scope);
    assertMutable(current);
    const changed = await prisma.contentOperation.updateMany({
      where: {
        id: scope.operationId,
        workspaceId: scope.workspaceId,
        status: { in: ["requested", "running"] },
      },
      data: { ...data, completedAt: new Date() },
    });
    const persisted = await requireScoped(scope);
    if (changed.count !== 1) assertMutable(persisted);
    return persisted;
  }

  return {
    createOrResume,

    findById: findScoped,

    async markRunning(scope): Promise<ContentOperationRecord> {
      const current = await requireScoped(scope);
      assertMutable(current);
      await prisma.contentOperation.updateMany({
        where: {
          id: scope.operationId,
          workspaceId: scope.workspaceId,
          status: { in: ["requested", "running"] },
        },
        data: {
          status: "running",
          startedAt: current.startedAt ?? new Date(),
        },
      });
      const persisted = await requireScoped(scope);
      assertMutable(persisted);
      return persisted;
    },

    async recordTechnicalAttempt(
      scope,
      attemptNumber,
    ): Promise<ContentOperationRecord> {
      if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 3) {
        throw new RangeError("Technical attempt number must be between 1 and 3");
      }
      const current = await requireScoped(scope);
      assertMutable(current);
      if (attemptNumber < current.technicalAttemptCount) {
        throw new RangeError("Technical attempt count cannot move backwards");
      }
      const changed = await prisma.contentOperation.updateMany({
        where: {
          id: scope.operationId,
          workspaceId: scope.workspaceId,
          status: { in: ["requested", "running"] },
          technicalAttemptCount: { lte: attemptNumber },
        },
        data: { technicalAttemptCount: attemptNumber },
      });
      const persisted = await requireScoped(scope);
      assertMutable(persisted);
      if (changed.count === 0 && persisted.technicalAttemptCount > attemptNumber) {
        throw new RangeError("Technical attempt count cannot move backwards");
      }
      return persisted;
    },

    async recordProviderJobId(
      scope,
      providerJobId,
    ): Promise<ContentOperationRecord> {
      const normalized = providerJobId.trim();
      if (!normalized) throw new TypeError("providerJobId must not be empty");

      const current = await requireScoped(scope);
      assertMutable(current);
      if (current.providerJobId === normalized) return current;
      if (current.providerJobId) {
        throw new ContentGenerationError(
          "PROVIDER_JOB_ALREADY_ACCEPTED",
          "The operation already has an accepted provider job identity",
          { providerJobId: current.providerJobId, operationId: scope.operationId },
        );
      }

      const changed = await prisma.contentOperation.updateMany({
        where: {
          id: scope.operationId,
          workspaceId: scope.workspaceId,
          status: { in: ["requested", "running"] },
          providerJobId: null,
        },
        data: { providerJobId: normalized },
      });
      const persisted = await requireScoped(scope);
      assertMutable(persisted);
      if (changed.count === 1 || persisted.providerJobId === normalized) {
        return persisted;
      }
      throw new ContentGenerationError(
        "PROVIDER_JOB_ALREADY_ACCEPTED",
        "A concurrent call already persisted a provider job identity",
        { providerJobId: persisted.providerJobId, operationId: scope.operationId },
      );
    },

    async succeed(scope, result): Promise<ContentOperationRecord> {
      return persistTerminal(scope, {
        status: "succeeded",
        resultJson: stringify(result),
        errorJson: null,
      });
    },

    async fail(scope, error): Promise<ContentOperationRecord> {
      return persistTerminal(scope, {
        status: "failed",
        errorJson: stringify(error),
      });
    },
  };
}
