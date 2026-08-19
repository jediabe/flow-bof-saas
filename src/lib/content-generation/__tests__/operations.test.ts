import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createOperationRepository } from "../operations";

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
    await expect(
      prisma.contentOperation.count({ where: { workspaceId } }),
    ).resolves.toBe(1);
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
