import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ContentGenerationError,
  type WorkspaceProviderLockRecord,
} from "./types";

export interface AcquireWorkspaceProviderLockInput {
  workspaceId: string;
  operationId: string;
  ttlMs: number;
  now?: Date;
}

export interface ReleaseWorkspaceProviderLockInput {
  workspaceId: string;
  operationId: string;
}

export interface ProviderLockRepository {
  acquire(
    input: AcquireWorkspaceProviderLockInput,
  ): Promise<WorkspaceProviderLockRecord>;
  release(input: ReleaseWorkspaceProviderLockInput): Promise<boolean>;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function validateAcquireInput(input: AcquireWorkspaceProviderLockInput): void {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new RangeError("Provider lock ttlMs must be a positive safe integer");
  }
}

function busyError(active: {
  operationId: string;
  operation: { contentRunId: string };
  expiresAt: Date;
}): ContentGenerationError {
  return new ContentGenerationError(
    "WORKSPACE_PROVIDER_BUSY",
    "Another provider generation operation is active in this workspace",
    {
      operationId: active.operationId,
      contentRunId: active.operation.contentRunId,
      expiresAt: active.expiresAt.toISOString(),
    },
  );
}

export function createProviderLockRepository(
  prisma: PrismaClient,
): ProviderLockRepository {
  async function currentBusyError(
    workspaceId: string,
  ): Promise<ContentGenerationError> {
    const active = await prisma.workspaceProviderLock.findUnique({
      where: { workspaceId },
      include: { operation: { select: { contentRunId: true } } },
    });
    if (!active) {
      return new ContentGenerationError(
        "WORKSPACE_PROVIDER_BUSY",
        "A concurrent provider generation operation acquired this workspace",
      );
    }
    return busyError(active);
  }

  return {
    async acquire(input): Promise<WorkspaceProviderLockRecord> {
      validateAcquireInput(input);
      const operation = await prisma.contentOperation.findFirst({
        where: {
          id: input.operationId,
          workspaceId: input.workspaceId,
          status: { in: ["requested", "running"] },
        },
        select: { id: true },
      });
      if (!operation) {
        throw new ContentGenerationError(
          "OPERATION_NOT_FOUND",
          "An active content operation was not found in this workspace",
          { operationId: input.operationId },
        );
      }
      const now = input.now ?? new Date();
      const expiresAt = new Date(now.getTime() + input.ttlMs);

      try {
        return await prisma.workspaceProviderLock.create({
          data: {
            workspaceId: input.workspaceId,
            operationId: input.operationId,
            acquiredAt: now,
            expiresAt,
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }

      try {
        return await prisma.$transaction(async (tx) => {
          const active = await tx.workspaceProviderLock.findUnique({
            where: { workspaceId: input.workspaceId },
            include: {
              operation: {
                select: { contentRunId: true, status: true },
              },
            },
          });

          if (!active) {
            return tx.workspaceProviderLock.create({
              data: {
                workspaceId: input.workspaceId,
                operationId: input.operationId,
                acquiredAt: now,
                expiresAt,
              },
            });
          }

          if (active.expiresAt.getTime() >= now.getTime()) {
            throw busyError(active);
          }

          const removed = await tx.workspaceProviderLock.deleteMany({
            where: {
              workspaceId: input.workspaceId,
              operationId: active.operationId,
              expiresAt: { lt: now },
            },
          });
          if (removed.count !== 1) {
            throw busyError(active);
          }

          await tx.contentOperation.update({
            where: { id: active.operationId },
            data: {
              ...(active.operation.status === "requested" ||
              active.operation.status === "running"
                ? { status: "failed", completedAt: now }
                : {}),
              errorJson: JSON.stringify({
                code: "EXPIRED_PROVIDER_LOCK_RECOVERED",
                recoveredAt: now.toISOString(),
                recoveredByOperationId: input.operationId,
              }),
            },
          });

          return tx.workspaceProviderLock.create({
            data: {
              workspaceId: input.workspaceId,
              operationId: input.operationId,
              acquiredAt: now,
              expiresAt,
            },
          });
        });
      } catch (error) {
        if (error instanceof ContentGenerationError) throw error;
        if (isUniqueConstraintError(error)) {
          throw await currentBusyError(input.workspaceId);
        }
        throw error;
      }
    },

    async release(input): Promise<boolean> {
      const removed = await prisma.workspaceProviderLock.deleteMany({
        where: {
          workspaceId: input.workspaceId,
          operationId: input.operationId,
        },
      });
      return removed.count === 1;
    },
  };
}

/** Acquire and always release a workspace provider lock around one work unit. */
export async function withWorkspaceProviderLock<T>(
  repository: ProviderLockRepository,
  lock: AcquireWorkspaceProviderLockInput,
  work: () => Promise<T>,
): Promise<T> {
  await repository.acquire(lock);
  try {
    return await work();
  } finally {
    await repository.release({
      workspaceId: lock.workspaceId,
      operationId: lock.operationId,
    });
  }
}
