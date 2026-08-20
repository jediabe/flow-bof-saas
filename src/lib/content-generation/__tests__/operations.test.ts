import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createOperationRepository } from "../operations";

function withAcceptedStartRace(
  operationId: string,
  racePrisma: PrismaClient,
): PrismaClient {
  return new Proxy(racePrisma, {
    get(target, prop, receiver) {
      if (prop !== "contentOperation") return Reflect.get(target, prop, receiver);
      const delegate = target.contentOperation;
      return new Proxy(delegate, {
        get(contentOperation, delegateProp, delegateReceiver) {
          if (delegateProp !== "updateMany") {
            return Reflect.get(contentOperation, delegateProp, delegateReceiver);
          }
          return async (args: Parameters<typeof delegate.updateMany>[0]) => {
            const data = args.data as
              | { providerJobId?: unknown; resultJson?: unknown }
              | undefined;
            if (data?.providerJobId === "job-raced" && data.resultJson === undefined) {
              const result = await delegate.updateMany(args);
              await target.contentOperation.update({
                where: { id: operationId },
                data: { status: "failed" },
              });
              return result;
            }
            if (data?.providerJobId === "job-raced") {
              await target.contentOperation.update({
                where: { id: operationId },
                data: { status: "failed" },
              });
            }
            return delegate.updateMany(args);
          };
        },
      });
    },
  }) as PrismaClient;
}

const databasePath = resolve(tmpdir(), `operations-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

let workspaceId: string;
let otherWorkspaceId: string;
let contentRunId: string;

beforeAll(() => {
  const prismaCli = fileURLToPath(import.meta.resolve("prisma/build/index.js"));
  execFileSync(
    process.execPath,
    [prismaCli, "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    },
  );
});

beforeEach(async () => {
  await prisma.workspaceProviderLock.deleteMany();
  await prisma.contentOperation.deleteMany();
  await prisma.contentRun.deleteMany();
  await prisma.product.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.user.deleteMany();

  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test` },
  });
  const workspace = await prisma.workspace.create({
    data: { name: "one", ownerId: user.id },
  });
  const otherWorkspace = await prisma.workspace.create({
    data: { name: "two", ownerId: user.id },
  });
  const batch = await prisma.batch.create({
    data: { workspaceId: workspace.id, name: "batch" },
  });
  const product = await prisma.product.create({
    data: { batchId: batch.id, productName: "product" },
  });
  const run = await prisma.contentRun.create({
    data: {
      productId: product.id,
      style: "style1",
      market: "uk",
      idempotencyKey: randomUUID(),
    },
  });

  workspaceId = workspace.id;
  otherWorkspaceId = otherWorkspace.id;
  contentRunId = run.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

describe("content operation repository", () => {
  it("returns the original operation for a repeated idempotency key", async () => {
    const repository = createOperationRepository(prisma);
    const input = {
      workspaceId,
      contentRunId,
      kind: "image_generation" as const,
      sceneLabel: "scene_1_store_image",
      idempotencyKey: "image-one",
    };

    const [first, repeated] = await Promise.all([
      repository.createOrResume(input),
      repository.createOrResume(input),
    ]);

    expect(repeated.id).toBe(first.id);
    expect(first.creativeDirectionJson).toBeNull();
    await expect(
      prisma.contentOperation.count({ where: { workspaceId } }),
    ).resolves.toBe(1);
  });

  it("persists video creative direction as canonical stable JSON", async () => {
    const repository = createOperationRepository(prisma);
    const operation = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "video_generation",
      sceneLabel: "scene_1_store",
      idempotencyKey: "video-direction",
      creativeDirection: {
        preservationFocus: ["reflections", "label_layout"],
        movementIntensity: "low",
        interactionStyle: "single_gentle_touch",
        distance: "slight_approach",
        framing: "stable_close",
        pacing: "unhurried",
        cameraMovement: "gentle_push_in",
      },
    });

    expect(operation.creativeDirectionJson).toBe(
      '{"cameraMovement":"gentle_push_in","pacing":"unhurried","framing":"stable_close","distance":"slight_approach","interactionStyle":"single_gentle_touch","movementIntensity":"low","preservationFocus":["reflections","label_layout"]}',
    );
  });

  it("binds an idempotency key to the canonical video creative direction", async () => {
    const repository = createOperationRepository(prisma);
    const input = {
      workspaceId,
      contentRunId,
      kind: "video_generation" as const,
      sceneLabel: "scene_1_store",
      idempotencyKey: "video-direction-bound",
      creativeDirection: {
        cameraMovement: "locked_off" as const,
        pacing: "steady" as const,
        framing: "stable_wide" as const,
        distance: "hold_distance" as const,
        interactionStyle: "single_gentle_tap" as const,
        movementIntensity: "minimal" as const,
        preservationFocus: ["label_layout" as const],
      },
    };
    const first = await repository.createOrResume(input);

    await expect(repository.createOrResume(input)).resolves.toMatchObject({ id: first.id });
    await expect(
      repository.createOrResume({
        ...input,
        creativeDirection: {
          ...input.creativeDirection,
          cameraMovement: "minimal_push_in",
        },
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects reuse of an idempotency key for a different command", async () => {
    const repository = createOperationRepository(prisma);
    await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "image_generation",
      sceneLabel: "scene_1_store_image",
      idempotencyKey: "shared-key",
    });

    await expect(
      repository.createOrResume({
        workspaceId,
        contentRunId,
        kind: "image_generation",
        sceneLabel: "scene_2_home_image",
        idempotencyKey: "shared-key",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("reserves a slot for one logical creative command before completion", async () => {
    const repository = createOperationRepository(prisma);
    const first = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "image_generation",
      sceneLabel: "scene_1_store_image",
      idempotencyKey: "reserved-attempt",
    });

    await expect(
      repository.createOrResume({
        workspaceId,
        contentRunId,
        kind: "image_generation",
        sceneLabel: "scene_1_store_image",
        idempotencyKey: "different-command",
      }),
    ).rejects.toMatchObject({
      code: "CREATIVE_ATTEMPT_EXHAUSTED",
      details: { operationId: first.id },
    });
  });

  it("rejects a second creative command after a slot succeeds", async () => {
    const repository = createOperationRepository(prisma);
    const first = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "image_generation",
      sceneLabel: "scene_1_store_image",
      idempotencyKey: "first-attempt",
    });
    await repository.succeed(
      { workspaceId, operationId: first.id },
      { assetId: "image-1" },
    );

    await expect(
      repository.createOrResume({
        workspaceId,
        contentRunId,
        kind: "image_generation",
        sceneLabel: "scene_1_store_image",
        idempotencyKey: "second-attempt",
      }),
    ).rejects.toMatchObject({
      code: "CREATIVE_ATTEMPT_EXHAUSTED",
      details: { operationId: first.id },
    });
  });

  it("rejects a run that does not belong to the workspace", async () => {
    const repository = createOperationRepository(prisma);

    await expect(
      repository.createOrResume({
        workspaceId: otherWorkspaceId,
        contentRunId,
        kind: "image_generation",
        sceneLabel: "scene_1_store_image",
        idempotencyKey: "cross-tenant",
      }),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_WORKSPACE_MISMATCH" });
    await expect(prisma.contentOperation.count()).resolves.toBe(0);
  });

  it("preserves the first accepted provider job identity", async () => {
    const repository = createOperationRepository(prisma);
    const operation = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "video_generation",
      sceneLabel: "scene_1_store",
      idempotencyKey: "video-one",
    });

    await expect(
      repository.recordProviderJobId(
        { workspaceId, operationId: operation.id },
        "job-original",
      ),
    ).resolves.toMatchObject({ providerJobId: "job-original" });
    await expect(
      repository.recordProviderJobId(
        { workspaceId, operationId: operation.id },
        "job-original",
      ),
    ).resolves.toMatchObject({ providerJobId: "job-original" });
    await expect(
      repository.recordProviderJobId(
        { workspaceId, operationId: operation.id },
        "job-replacement",
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_JOB_ALREADY_ACCEPTED" });

    await expect(
      prisma.contentOperation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).resolves.toMatchObject({ providerJobId: "job-original" });
  });

  it("persists accepted video provider identity and source lineage atomically", async () => {
    const repository = createOperationRepository(prisma);
    const operation = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "video_generation",
      sceneLabel: "scene_1_store",
      idempotencyKey: "video-atomic-lineage",
    });
    const scope = { workspaceId, operationId: operation.id };
    await repository.markRunning(scope);

    await expect(
      repository.recordAcceptedVideoStart(scope, {
        providerJobId: "job-original",
        sourceImageId: "source-image-1",
        sourceImageMediaGenerationId: "flow-source-image-1",
      }),
    ).resolves.toMatchObject({ providerJobId: "job-original" });

    const persisted = await prisma.contentOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    expect(persisted.providerJobId).toBe("job-original");
    expect(JSON.parse(persisted.resultJson ?? "null")).toEqual({
      sourceImageId: "source-image-1",
      sourceImageMediaGenerationId: "flow-source-image-1",
    });

    await prisma.contentOperation.update({
      where: { id: operation.id },
      data: { providerJobId: null, resultJson: null, status: "failed" },
    });

    await expect(
      repository.recordAcceptedVideoStart(scope, {
        providerJobId: "job-late",
        sourceImageId: "source-image-1",
        sourceImageMediaGenerationId: "flow-source-image-1",
      }),
    ).rejects.toMatchObject({ code: "OPERATION_TERMINAL" });
    await expect(
      prisma.contentOperation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).resolves.toMatchObject({
      status: "failed",
      providerJobId: null,
      resultJson: null,
    });
  });

  it("does not leave accepted provider identity without source lineage when the guarded write races", async () => {
    const baseRepository = createOperationRepository(prisma);
    const operation = await baseRepository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "video_generation",
      sceneLabel: "scene_1_store",
      idempotencyKey: "video-accepted-start-race",
    });
    const scope = { workspaceId, operationId: operation.id };
    await baseRepository.markRunning(scope);
    const racingRepository = createOperationRepository(
      withAcceptedStartRace(operation.id, prisma),
    );

    await expect(
      racingRepository.recordAcceptedVideoStart(scope, {
        providerJobId: "job-raced",
        sourceImageId: "source-image-1",
        sourceImageMediaGenerationId: "flow-source-image-1",
      }),
    ).rejects.toMatchObject({ code: "OPERATION_TERMINAL" });

    const persisted = await prisma.contentOperation.findUniqueOrThrow({
      where: { id: operation.id },
    });
    expect(persisted).toMatchObject({
      status: "failed",
      providerJobId: null,
      resultJson: null,
    });
  });

  it("serializes concurrent different-key reservations for one slot", async () => {
    const repository = createOperationRepository(prisma);
    const results = await Promise.allSettled([
      repository.createOrResume({
        workspaceId,
        contentRunId,
        kind: "image_generation",
        sceneLabel: "scene_2_home_image",
        idempotencyKey: "slot-race-one",
      }),
      repository.createOrResume({
        workspaceId,
        contentRunId,
        kind: "image_generation",
        sceneLabel: "scene_2_home_image",
        idempotencyKey: "slot-race-two",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      prisma.contentOperation.count({
        where: { contentRunId, sceneLabel: "scene_2_home_image" },
      }),
    ).resolves.toBe(1);
  });

  it("includes provider identity in the idempotent command", async () => {
    const repository = createOperationRepository(prisma);
    await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "image_generation",
      sceneLabel: "scene_1_store_image",
      idempotencyKey: "provider-bound",
      provider: "provider-one",
    });

    await expect(
      repository.createOrResume({
        workspaceId,
        contentRunId,
        kind: "image_generation",
        sceneLabel: "scene_1_store_image",
        idempotencyKey: "provider-bound",
        provider: "provider-two",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("scopes operation mutation to the owning workspace", async () => {
    const repository = createOperationRepository(prisma);
    const operation = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "video_generation",
      sceneLabel: "scene_1_store",
      idempotencyKey: "tenant-bound",
    });

    await expect(
      repository.recordProviderJobId(
        { workspaceId: otherWorkspaceId, operationId: operation.id },
        "job-cross-tenant",
      ),
    ).rejects.toMatchObject({ code: "OPERATION_NOT_FOUND" });
  });

  it("fences terminal operations from late stale-worker mutation", async () => {
    const repository = createOperationRepository(prisma);
    const operation = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "video_generation",
      sceneLabel: "scene_1_store",
      idempotencyKey: "stale-worker",
    });
    const scope = { workspaceId, operationId: operation.id };
    await repository.fail(scope, { code: "EXPIRED_PROVIDER_LOCK_RECOVERED" });

    await expect(
      repository.recordProviderJobId(scope, "job-too-late"),
    ).rejects.toMatchObject({ code: "OPERATION_TERMINAL" });
    await expect(
      repository.succeed(scope, { assetId: "late-asset" }),
    ).rejects.toMatchObject({ code: "OPERATION_TERMINAL" });
  });

  it("persists attempt counts and terminal failure details", async () => {
    const repository = createOperationRepository(prisma);
    const operation = await repository.createOrResume({
      workspaceId,
      contentRunId,
      kind: "image_generation",
      sceneLabel: "scene_1_store_image",
      idempotencyKey: "failed-image",
    });

    await repository.recordTechnicalAttempt(
      { workspaceId, operationId: operation.id },
      1,
    );
    const failed = await repository.fail(
      { workspaceId, operationId: operation.id },
      {
        code: "provider_failure",
        message: "content rejected",
      },
    );

    expect(failed).toMatchObject({
      status: "failed",
      technicalAttemptCount: 1,
    });
    expect(JSON.parse(failed.errorJson ?? "null")).toEqual({
      code: "provider_failure",
      message: "content rejected",
    });
    expect(failed.completedAt).toBeInstanceOf(Date);
  });
});
