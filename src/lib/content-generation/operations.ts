import {
  Prisma,
  type ContentOperation,
  type PrismaClient,
} from "@prisma/client";

import {
  ContentGenerationError,
  type AcceptedProviderAttemptAudit,
  type ContentOperationRecord,
  type CreateOperationInput,
  type OperationScope,
  type PrepareAudioRetryInput,
  type RecordAcceptedVideoStartInput,
  type TerminalizeProviderAttemptInput,
  type VideoCreativeDirection,
} from "./types";
import { ALLOWED_MANAGED_VIDEO_MODELS } from "@/lib/content-runs/constants";

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
  recordAcceptedVideoStart(
    scope: OperationScope,
    input: RecordAcceptedVideoStartInput,
  ): Promise<ContentOperationRecord>;
  terminalizeProviderAttempt(
    scope: OperationScope,
    input: TerminalizeProviderAttemptInput,
  ): Promise<ContentOperationRecord>;
  prepareAudioRetry(
    scope: OperationScope,
    input: PrepareAudioRetryInput,
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

function canonicalCreativeDirection(
  direction: VideoCreativeDirection | undefined,
): string | null {
  if (!direction) return null;
  return JSON.stringify({
    cameraMovement: direction.cameraMovement,
    pacing: direction.pacing,
    framing: direction.framing,
    distance: direction.distance,
    interactionStyle: direction.interactionStyle,
    movementIntensity: direction.movementIntensity,
    preservationFocus: direction.preservationFocus,
  });
}

function assertSameLogicalCommand(
  existing: ContentOperationRecord,
  input: CreateOperationInput,
): void {
  const provider = input.provider ?? "google_flow_useapi";
  const creativeDirectionJson = canonicalCreativeDirection(input.creativeDirection);
  if (
    existing.contentRunId !== input.contentRunId ||
    existing.kind !== input.kind ||
    existing.sceneLabel !== input.sceneLabel ||
    existing.provider !== provider ||
    existing.creativeDirectionJson !== creativeDirectionJson
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

const MAX_ACCEPTED_PROVIDER_ATTEMPTS = 4;
const AUDIT_KEYS = [
  "acceptedAt",
  "attemptNumber",
  "completedAt",
  "errorCode",
  "failureKind",
  "model",
  "providerJobId",
  "status",
  "transportAttemptCount",
] as const;

function requiredAuditToken(value: string, field: string, maxLength = 500): string {
  if (
    value !== value.trim() ||
    !value ||
    value.length > maxLength ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    /:\/\//.test(value) ||
    !/^[A-Za-z0-9._:/-]+$/.test(value)
  ) {
    throw new TypeError(`${field} must be a safe non-URL identifier`);
  }
  return value;
}

function safeErrorCode(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value)) {
    throw new TypeError("errorCode must be a safe provider code");
  }
  return value;
}

function requireAttemptNumber(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ACCEPTED_PROVIDER_ATTEMPTS) {
    throw new RangeError(
      `Provider attempt number must be between 1 and ${MAX_ACCEPTED_PROVIDER_ATTEMPTS}`,
    );
  }
  return value;
}

function parseProviderAttempts(operation: ContentOperationRecord): AcceptedProviderAttemptAudit[] {
  let value: unknown;
  try {
    value = JSON.parse(operation.providerAttemptsJson);
  } catch {
    value = null;
  }
  if (!Array.isArray(value)) {
    throw new ContentGenerationError(
      "PROVIDER_ATTEMPT_AUDIT_INVALID",
      "Provider attempt history is not a valid array",
      { operationId: operation.id },
    );
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ContentGenerationError(
        "PROVIDER_ATTEMPT_AUDIT_INVALID",
        "Provider attempt history contains an invalid entry",
        { operationId: operation.id },
      );
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const expectedKeys = [...AUDIT_KEYS].sort();
    const valid =
      keys.length === expectedKeys.length &&
      keys.every((key, index) => key === expectedKeys[index]) &&
      Number.isInteger(record.attemptNumber) &&
      typeof record.providerJobId === "string" &&
      typeof record.model === "string" &&
      Number.isInteger(record.transportAttemptCount) &&
      (record.status === "running" || record.status === "succeeded" || record.status === "failed") &&
      (record.failureKind === null ||
        record.failureKind === "audio_generation" ||
        record.failureKind === "provider") &&
      (record.errorCode === null || typeof record.errorCode === "string") &&
      typeof record.acceptedAt === "string" &&
      (record.completedAt === null || typeof record.completedAt === "string");
    if (!valid) {
      throw new ContentGenerationError(
        "PROVIDER_ATTEMPT_AUDIT_INVALID",
        "Provider attempt history contains an invalid entry",
        { operationId: operation.id },
      );
    }
  }
  return value as AcceptedProviderAttemptAudit[];
}

function staleAttempt(
  scope: OperationScope,
  current: ContentOperationRecord,
): ContentGenerationError {
  return new ContentGenerationError(
    "PROVIDER_ATTEMPT_STALE",
    "The provider attempt identity is stale or no longer current",
    {
      operationId: scope.operationId,
      providerAttemptNumber: current.providerAttemptNumber,
      providerJobId: current.providerJobId,
    },
  );
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
          creativeDirectionJson: canonicalCreativeDirection(input.creativeDirection),
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
      if (current.kind === "video_generation") {
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
          "Video provider identities must use the accepted-attempt audit API",
          { operationId: scope.operationId },
        );
      }
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

    async recordAcceptedVideoStart(scope, input): Promise<ContentOperationRecord> {
      const attemptNumber = requireAttemptNumber(input.attemptNumber);
      const providerJobId = requiredAuditToken(input.providerJobId, "providerJobId");
      const sourceImageId = requiredAuditToken(input.sourceImageId, "sourceImageId");
      const sourceImageMediaGenerationId = requiredAuditToken(
        input.sourceImageMediaGenerationId,
        "sourceImageMediaGenerationId",
      );
      if (!(ALLOWED_MANAGED_VIDEO_MODELS as readonly string[]).includes(input.model)) {
        throw new TypeError("model must be an allowed managed video model");
      }
      const resultJson = stringify({ sourceImageId, sourceImageMediaGenerationId });

      const current = await requireScoped(scope);
      assertMutable(current);
      if (current.kind !== "video_generation" || current.status !== "running") {
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
          "Accepted video attempts require a running video operation",
          { operationId: scope.operationId },
        );
      }
      const history = parseProviderAttempts(current);
      const expectedAttemptNumber =
        current.providerAttemptNumber === 0 ? 1 : current.providerAttemptNumber;
      const last = history.at(-1);
      if (current.providerJobId === providerJobId) {
        if (
          current.providerAttemptNumber === attemptNumber &&
          current.resultJson === resultJson &&
          last?.attemptNumber === attemptNumber &&
          last.providerJobId === providerJobId &&
          last.model === input.model
        ) {
          return current;
        }
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
          "The accepted provider identity conflicts with persisted audit data",
          { operationId: scope.operationId, providerJobId },
        );
      }
      if (current.providerJobId || attemptNumber !== expectedAttemptNumber) {
        throw staleAttempt(scope, current);
      }
      if (current.technicalAttemptCount < 1 || current.technicalAttemptCount > 3) {
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
          "An accepted provider start requires a recorded transport attempt",
          { operationId: scope.operationId },
        );
      }
      if (history.length !== attemptNumber - 1) {
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
          "Provider attempt numbering is not contiguous",
          { operationId: scope.operationId, providerAttemptNumber: attemptNumber },
        );
      }
      if (
        history.length > 0 &&
        (history[0].model !== input.model || current.resultJson !== resultJson)
      ) {
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
          "Provider retry model and source lineage are immutable",
          { operationId: scope.operationId },
        );
      }

      const accepted: AcceptedProviderAttemptAudit = {
        attemptNumber,
        providerJobId,
        model: input.model,
        transportAttemptCount: current.technicalAttemptCount,
        status: "running",
        failureKind: null,
        errorCode: null,
        acceptedAt: new Date().toISOString(),
        completedAt: null,
      };
      const providerAttemptsJson = JSON.stringify([...history, accepted]);
      const changed = await prisma.contentOperation.updateMany({
        where: {
          id: scope.operationId,
          workspaceId: scope.workspaceId,
          kind: "video_generation",
          status: "running",
          providerJobId: null,
          providerAttemptNumber: current.providerAttemptNumber,
          providerAttemptsJson: current.providerAttemptsJson,
          technicalAttemptCount: current.technicalAttemptCount,
        },
        data: {
          providerJobId,
          providerAttemptNumber: attemptNumber,
          providerAttemptsJson,
          resultJson,
        },
      });
      const persisted = await requireScoped(scope);
      assertMutable(persisted);
      if (changed.count === 1) return persisted;
      const persistedHistory = parseProviderAttempts(persisted);
      const persistedLast = persistedHistory.at(-1);
      if (
        persisted.providerJobId === providerJobId &&
        persisted.providerAttemptNumber === attemptNumber &&
        persisted.resultJson === resultJson &&
        persistedLast?.providerJobId === providerJobId &&
        persistedLast.model === input.model
      ) {
        return persisted;
      }
      throw staleAttempt(scope, persisted);
    },

    async terminalizeProviderAttempt(scope, input): Promise<ContentOperationRecord> {
      const attemptNumber = requireAttemptNumber(input.attemptNumber);
      const providerJobId = requiredAuditToken(input.providerJobId, "providerJobId");
      const failureKind = input.status === "failed" ? input.failureKind : null;
      const errorCode = input.status === "failed" ? safeErrorCode(input.errorCode) : null;
      const current = await requireScoped(scope);
      assertMutable(current);
      const history = parseProviderAttempts(current);
      const last = history.at(-1);
      if (
        current.kind !== "video_generation" ||
        current.status !== "running" ||
        current.providerAttemptNumber !== attemptNumber ||
        current.providerJobId !== providerJobId ||
        last?.attemptNumber !== attemptNumber ||
        last.providerJobId !== providerJobId
      ) {
        throw staleAttempt(scope, current);
      }
      if (last.status !== "running") {
        if (
          last.status === input.status &&
          last.failureKind === failureKind &&
          last.errorCode === errorCode
        ) {
          return current;
        }
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_AUDIT_CONFLICT",
          "The provider attempt already has a different terminal audit result",
          { operationId: scope.operationId, providerAttemptNumber: attemptNumber },
        );
      }

      const providerAttemptsJson = JSON.stringify([
        ...history.slice(0, -1),
        {
          ...last,
          status: input.status,
          failureKind,
          errorCode,
          completedAt: new Date().toISOString(),
        },
      ]);
      const changed = await prisma.contentOperation.updateMany({
        where: {
          id: scope.operationId,
          workspaceId: scope.workspaceId,
          kind: "video_generation",
          status: "running",
          providerJobId,
          providerAttemptNumber: attemptNumber,
          providerAttemptsJson: current.providerAttemptsJson,
        },
        data: { providerAttemptsJson },
      });
      const persisted = await requireScoped(scope);
      assertMutable(persisted);
      if (changed.count === 1) return persisted;
      const persistedLast = parseProviderAttempts(persisted).at(-1);
      if (
        persisted.providerJobId === providerJobId &&
        persisted.providerAttemptNumber === attemptNumber &&
        persistedLast?.status === input.status &&
        persistedLast.failureKind === failureKind &&
        persistedLast.errorCode === errorCode
      ) {
        return persisted;
      }
      throw staleAttempt(scope, persisted);
    },

    async prepareAudioRetry(scope, input): Promise<ContentOperationRecord> {
      const attemptNumber = requireAttemptNumber(input.attemptNumber);
      const providerJobId = requiredAuditToken(input.providerJobId, "providerJobId");
      const current = await requireScoped(scope);
      assertMutable(current);
      const history = parseProviderAttempts(current);
      const last = history.at(-1);
      const exactAudioFailure =
        last?.attemptNumber === attemptNumber &&
        last.providerJobId === providerJobId &&
        last.status === "failed" &&
        last.failureKind === "audio_generation";

      if (
        exactAudioFailure &&
        current.providerJobId === null &&
        current.providerAttemptNumber === attemptNumber + 1
      ) {
        return current;
      }
      if (
        current.kind !== "video_generation" ||
        current.status !== "running" ||
        current.providerAttemptNumber !== attemptNumber ||
        current.providerJobId !== providerJobId
      ) {
        throw staleAttempt(scope, current);
      }
      if (attemptNumber >= MAX_ACCEPTED_PROVIDER_ATTEMPTS) {
        throw new ContentGenerationError(
          "PROVIDER_ATTEMPT_LIMIT_REACHED",
          "The managed video operation has exhausted its accepted provider attempts",
          { operationId: scope.operationId, providerAttemptNumber: attemptNumber },
        );
      }
      if (!exactAudioFailure) {
        throw new ContentGenerationError(
          "AUDIO_RETRY_NOT_ALLOWED",
          "Audio retry requires the exact current accepted job to be terminal audio failure",
          { operationId: scope.operationId, providerAttemptNumber: attemptNumber },
        );
      }

      const changed = await prisma.contentOperation.updateMany({
        where: {
          id: scope.operationId,
          workspaceId: scope.workspaceId,
          kind: "video_generation",
          status: "running",
          providerJobId,
          providerAttemptNumber: attemptNumber,
          providerAttemptsJson: current.providerAttemptsJson,
        },
        data: {
          providerJobId: null,
          providerAttemptNumber: attemptNumber + 1,
          technicalAttemptCount: 0,
          completedAt: null,
        },
      });
      const persisted = await requireScoped(scope);
      assertMutable(persisted);
      if (changed.count === 1) return persisted;
      if (
        persisted.providerJobId === null &&
        persisted.providerAttemptNumber === attemptNumber + 1 &&
        persisted.providerAttemptsJson === current.providerAttemptsJson
      ) {
        return persisted;
      }
      throw staleAttempt(scope, persisted);
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
