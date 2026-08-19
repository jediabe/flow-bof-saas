import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createProviderLockRepository,
  withWorkspaceProviderLock,
} from "../provider-lock";

const databasePath = resolve(tmpdir(), `provider-lock-${randomUUID()}.db`);
const databaseUrl = `file:${databasePath.replaceAll("\\", "/")}`;
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

interface Fixture {
  workspace1: string;
  workspace2: string;
  run1: string;
  run2: string;
  op1: string;
  op2: string;
  op3: string;
}

let fixture: Fixture;

async function seed(): Promise<Fixture> {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test` },
  });
  const workspace1 = await prisma.workspace.create({
    data: { name: "one", ownerId: user.id },
  });
  const workspace2 = await prisma.workspace.create({
    data: { name: "two", ownerId: user.id },
  });
  const batch1 = await prisma.batch.create({
    data: { workspaceId: workspace1.id, name: "batch-one" },
  });
  const batch2 = await prisma.batch.create({
    data: { workspaceId: workspace2.id, name: "batch-two" },
  });
  const product1 = await prisma.product.create({
    data: { batchId: batch1.id, productName: "one" },
  });
  const product2 = await prisma.product.create({
    data: { batchId: batch2.id, productName: "two" },
  });
  const run1 = await prisma.contentRun.create({
    data: {
      productId: product1.id,
      style: "style1",
      market: "uk",
      idempotencyKey: randomUUID(),
    },
  });
  const run2 = await prisma.contentRun.create({
    data: {
      productId: product2.id,
      style: "style1",
      market: "uk",
      idempotencyKey: randomUUID(),
    },
  });
  const [op1, op2, op3] = await Promise.all([
    prisma.contentOperation.create({
      data: {
        workspaceId: workspace1.id,
        contentRunId: run1.id,
        kind: "image_generation",
        sceneLabel: "scene_1_store_image",
        idempotencyKey: randomUUID(),
      },
    }),
    prisma.contentOperation.create({
      data: {
        workspaceId: workspace1.id,
        contentRunId: run1.id,
        kind: "video_generation",
        sceneLabel: "scene_1_store",
        idempotencyKey: randomUUID(),
      },
    }),
    prisma.contentOperation.create({
      data: {
        workspaceId: workspace2.id,
        contentRunId: run2.id,
        kind: "image_generation",
        sceneLabel: "scene_1_store_image",
        idempotencyKey: randomUUID(),
      },
    }),
  ]);
  return {
    workspace1: workspace1.id,
    workspace2: workspace2.id,
    run1: run1.id,
    run2: run2.id,
    op1: op1.id,
    op2: op2.id,
    op3: op3.id,
  };
}

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
  fixture = await seed();
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(databasePath, { force: true });
});

describe("provider workspace lock", () => {
  it("allows only one of two concurrent acquisitions in a workspace", async () => {
    const repository = createProviderLockRepository(prisma);
    const now = new Date("2026-08-19T12:00:00.000Z");

    const results = await Promise.allSettled([
      repository.acquire({
        workspaceId: fixture.workspace1,
        operationId: fixture.op1,
        ttlMs: 60_000,
        now,
      }),
      repository.acquire({
        workspaceId: fixture.workspace1,
        operationId: fixture.op2,
        ttlMs: 60_000,
        now,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        code: "WORKSPACE_PROVIDER_BUSY",
        details: {
          contentRunId: fixture.run1,
        },
      },
    });
  });

  it("allows different workspaces to operate concurrently", async () => {
    const repository = createProviderLockRepository(prisma);

    await expect(
      Promise.all([
        repository.acquire({
          workspaceId: fixture.workspace1,
          operationId: fixture.op1,
          ttlMs: 60_000,
        }),
        repository.acquire({
          workspaceId: fixture.workspace2,
          operationId: fixture.op3,
          ttlMs: 60_000,
        }),
      ]),
    ).resolves.toHaveLength(2);
  });

  it("recovers an expired lock, audits the stale operation, and rejects a live lock", async () => {
    const repository = createProviderLockRepository(prisma);
    const acquiredAt = new Date("2026-08-19T12:00:00.000Z");
    await repository.acquire({
      workspaceId: fixture.workspace1,
      operationId: fixture.op1,
      ttlMs: 1_000,
      now: acquiredAt,
    });

    await expect(
      repository.acquire({
        workspaceId: fixture.workspace1,
        operationId: fixture.op2,
        ttlMs: 60_000,
        now: new Date("2026-08-19T12:00:02.000Z"),
      }),
    ).resolves.toMatchObject({ operationId: fixture.op2 });

    const staleOperation = await prisma.contentOperation.findUniqueOrThrow({
      where: { id: fixture.op1 },
    });
    expect(staleOperation.status).toBe("failed");
    expect(JSON.parse(staleOperation.errorJson ?? "null")).toMatchObject({
      code: "EXPIRED_PROVIDER_LOCK_RECOVERED",
      recoveredByOperationId: fixture.op2,
    });

    const waitingOperation = await prisma.contentOperation.create({
      data: {
        workspaceId: fixture.workspace1,
        contentRunId: fixture.run1,
        kind: "image_generation",
        sceneLabel: "scene_2_home_image",
        idempotencyKey: randomUUID(),
      },
    });
    await expect(
      repository.acquire({
        workspaceId: fixture.workspace1,
        operationId: waitingOperation.id,
        ttlMs: 60_000,
        now: new Date("2026-08-19T12:00:03.000Z"),
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PROVIDER_BUSY" });
  });

  it("rejects an operation that does not belong to the lock workspace", async () => {
    const repository = createProviderLockRepository(prisma);

    await expect(
      repository.acquire({
        workspaceId: fixture.workspace2,
        operationId: fixture.op1,
        ttlMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "OPERATION_NOT_FOUND" });
    await expect(
      prisma.workspaceProviderLock.findUnique({
        where: { workspaceId: fixture.workspace2 },
      }),
    ).resolves.toBeNull();
  });

  it("releases the lock after successful and failed work", async () => {
    const repository = createProviderLockRepository(prisma);

    await expect(
      withWorkspaceProviderLock(
        repository,
        {
          workspaceId: fixture.workspace1,
          operationId: fixture.op1,
          ttlMs: 60_000,
        },
        async () => "done",
      ),
    ).resolves.toBe("done");
    await expect(
      prisma.workspaceProviderLock.findUnique({
        where: { workspaceId: fixture.workspace1 },
      }),
    ).resolves.toBeNull();

    await expect(
      withWorkspaceProviderLock(
        repository,
        {
          workspaceId: fixture.workspace1,
          operationId: fixture.op2,
          ttlMs: 60_000,
        },
        async () => {
          throw new Error("provider failed");
        },
      ),
    ).rejects.toThrow("provider failed");
    await expect(
      prisma.workspaceProviderLock.findUnique({
        where: { workspaceId: fixture.workspace1 },
      }),
    ).resolves.toBeNull();
  });
});
