import { beforeEach, describe, expect, it, vi } from "vitest";

const { runQaForAsset, qaPersistenceDb } = vi.hoisted(() => ({
  runQaForAsset: vi.fn(),
  qaPersistenceDb: {
    flowGeneratedImage: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    flowGeneratedVideo: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/db", () => ({ db: qaPersistenceDb }));
vi.mock("@/lib/qa/orchestrator", () => ({
  runQaForAsset,
  isPostLockQaFailure: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { qaLockAcquired?: boolean }).qaLockAcquired === true,
}));

import { runManagedQa } from "../run-managed-qa";
import { decide } from "@/lib/qa/decision-engine";
import { acquireQaLock } from "@/lib/qa/persistence";

function frozenSnapshot(): string {
  return JSON.stringify({
    objective: "create_style1_piece",
    specVersion: "managed-style1-v1",
    modelSnapshot: {
      imageModel: "nano-banana-pro",
      videoModel: "veo-3.1-lite",
    },
  });
}

interface FixtureAsset {
  id: string;
  contentRunId: string | null;
  sceneLabel: string;
  attemptNumber: number;
  qaStatus: string;
  qaScore: number | null;
  qaVerdictJson: string | null;
}

interface FixtureRun {
  id: string;
  productId: string;
  style: string;
  status: string;
  promptSnapshotJson: string;
  images: FixtureAsset[];
  videos: FixtureAsset[];
  operations: Array<{
    id: string;
    contentRunId: string;
    kind: string;
    sceneLabel: string;
    status: string;
    providerJobId: string | null;
    errorJson: string | null;
  }>;
}

function createRunFixture(): FixtureRun {
  return {
    id: "run-1",
    productId: "product-1",
    style: "style1",
    status: "qa_running",
    promptSnapshotJson: frozenSnapshot(),
    images: [
      {
        id: "image-1",
        contentRunId: "run-1",
        sceneLabel: "scene_1_store_image",
        attemptNumber: 1,
        qaStatus: "NOT_QA_CHECKED" as string,
        qaScore: null as number | null,
        qaVerdictJson: null as string | null,
      },
    ],
    videos: [],
    operations: [],
  };
}

function createPrisma(
  run = createRunFixture(),
  ownedWorkspaceId = "workspace-1",
) {
  return {
    contentRun: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            id: string;
            product?: { batch?: { workspaceId?: string } };
          };
        }) =>
        where.id === run.id &&
        where.product?.batch?.workspaceId === ownedWorkspaceId
          ? run
          : null,
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
          if (run.status !== where.status) return { count: 0 };
          run.status = data.status;
          return { count: 1 };
        },
      ),
    },
    contentOperation: { create: vi.fn() },
    flowGeneratedImage: { create: vi.fn() },
    flowGeneratedVideo: { create: vi.fn() },
  };
}

const actor = {
  workspaceId: "workspace-1",
  actorType: "service" as const,
  actorId: "hermes-mcp",
};

beforeEach(() => {
  runQaForAsset.mockReset();
  qaPersistenceDb.flowGeneratedImage.updateMany.mockReset();
  qaPersistenceDb.flowGeneratedImage.findUnique.mockReset();
  qaPersistenceDb.flowGeneratedVideo.updateMany.mockReset();
  qaPersistenceDb.flowGeneratedVideo.findUnique.mockReset();
});

describe("runManagedQa", () => {
  it("acquires the managed QA lock only from NOT_QA_CHECKED", async () => {
    qaPersistenceDb.flowGeneratedImage.updateMany.mockResolvedValue({ count: 1 });

    await acquireQaLock({
      assetId: "image-1",
      assetKind: "image",
      expectedStatus: "NOT_QA_CHECKED",
      expectedWorkspaceId: "workspace-1",
      expectedContentRunId: "run-1",
      expectedContentRunStatus: "qa_running",
    });

    expect(qaPersistenceDb.flowGeneratedImage.updateMany).toHaveBeenCalledWith({
      where: {
        id: "image-1",
        qaStatus: "NOT_QA_CHECKED",
        contentRunId: "run-1",
        contentRun: { status: "qa_running" },
        product: { batch: { workspaceId: "workspace-1" } },
      },
      data: { qaStatus: "QA_RUNNING" },
    });
  });

  it.each(["image", "video"] as const)(
    "does not perform an unscoped %s lookup when an ownership-fenced lock fails",
    async (assetKind) => {
      const delegate =
        assetKind === "image"
          ? qaPersistenceDb.flowGeneratedImage
          : qaPersistenceDb.flowGeneratedVideo;
      delegate.updateMany.mockResolvedValue({ count: 0 });
      delegate.findUnique.mockResolvedValue({ qaStatus: "APPROVED" });

      await expect(
        acquireQaLock({
          assetId: `${assetKind}-other-workspace`,
          assetKind,
          expectedStatus: "NOT_QA_CHECKED",
          expectedWorkspaceId: "workspace-1",
          expectedContentRunId: "run-1",
          expectedContentRunStatus: "qa_running",
        }),
      ).rejects.toMatchObject({ code: "qa_already_in_flight" });

      expect(delegate.findUnique).not.toHaveBeenCalled();
    },
  );

  it("revalidates workspace and run ownership inside the existing QA path", async () => {
    const actualOrchestrator = await vi.importActual<
      typeof import("@/lib/qa/orchestrator")
    >("@/lib/qa/orchestrator");
    const provider = {
      identifier: "test:must-not-run",
      evaluate: vi.fn(),
    };
    qaPersistenceDb.flowGeneratedImage.findUnique.mockResolvedValue({
      id: "image-1",
      mediaGenerationId: "media-1",
      sceneLabel: "scene_1_store_image",
      prompt: "frozen prompt",
      attemptNumber: 1,
      contentRunId: "run-other",
      contentRun: {
        id: "run-other",
        style: "style1",
        market: "uk",
      },
      product: {
        id: "product-1",
        productName: "Product",
        category: "kitchen",
        referenceImageUrl: null,
        batch: {
          workspaceId: "workspace-other",
          workspace: {
            settings: { flowEmail: "flow@example.com" },
            owner: { id: "owner-1" },
          },
        },
      },
    });

    await expect(
      actualOrchestrator.runQaForAsset({
        assetId: "image-1",
        assetKind: "image",
        triggeredBy: "auto",
        providerOverride: provider as never,
        expectedContext: {
          workspaceId: "workspace-1",
          contentRunId: "run-1",
          qaStatus: "NOT_QA_CHECKED",
        },
      }),
    ).rejects.toMatchObject({ code: "persistence_failed" });

    expect(qaPersistenceDb.flowGeneratedImage.updateMany).not.toHaveBeenCalled();
    expect(provider.evaluate).not.toHaveBeenCalled();
  });

  it("advances an approved first image to its dependent video action", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    runQaForAsset.mockImplementation(async () => {
      run.images[0].qaStatus = "APPROVED";
      run.images[0].qaScore = 94;
      run.images[0].qaVerdictJson = JSON.stringify({
        decision: "APPROVE",
        overallScore: 94,
      });
      return {
        attemptId: "qa-1",
        assetId: "image-1",
        assetKind: "image",
        decision: "APPROVE",
        qaStatus: "APPROVED",
        overallScore: 94,
        attemptNumber: 1,
        reason: "approved",
        elapsedMs: 5,
        providerModel: "resolved-provider",
      };
    });

    const result = await runManagedQa(
      actor,
      {
        contentRunId: "run-1",
        assetId: "image-1",
        assetKind: "image",
      },
      { prisma: prisma as never },
    );

    expect(result).toMatchObject({
      contentRunId: "run-1",
      assetId: "image-1",
      decision: "APPROVE",
      runStatus: "generating",
      requiredNextAction: {
        type: "GENERATE_VIDEO",
        slot: "scene_1_store_video",
        sourceAssetId: "image-1",
      },
    });
    expect(runQaForAsset).toHaveBeenCalledWith({
      assetId: "image-1",
      assetKind: "image",
      triggeredBy: "auto",
      triggeredByUserId: null,
      configOverride: { MAX_REPAIR_ATTEMPTS: 1 },
      expectedContext: {
        workspaceId: "workspace-1",
        contentRunId: "run-1",
        qaStatus: "NOT_QA_CHECKED",
      },
    });
    expect(prisma.contentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "qa_running",
        product: { batch: { workspaceId: "workspace-1" } },
      },
      data: { status: "generating" },
    });
  });

  it("marks the run failed when evaluator execution fails", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    const evaluatorError = Object.assign(new Error("provider unavailable"), {
      qaLockAcquired: true as const,
    });
    runQaForAsset.mockImplementation(async () => {
      run.images[0].qaStatus = "FAILED";
      run.images[0].qaVerdictJson = JSON.stringify({
        error: { code: "PROVIDER_ERROR", stage: "provider" },
        overallScore: 0,
      });
      throw evaluatorError;
    });

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).rejects.toBe(evaluatorError);

    expect(run.status).toBe("failed");
    expect(prisma.contentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "qa_running",
        product: { batch: { workspaceId: "workspace-1" } },
      },
      data: { status: "failed" },
    });
  });

  it("fails the run and preserves the root error when QA failure persistence also fails", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    const evaluatorError = Object.assign(new Error("provider unavailable"), {
      qaLockAcquired: true as const,
    });
    runQaForAsset.mockRejectedValue(evaluatorError);

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).rejects.toBe(evaluatorError);

    expect(run.status).toBe("failed");
    expect(prisma.contentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "qa_running",
        product: { batch: { workspaceId: "workspace-1" } },
      },
      data: { status: "failed" },
    });
  });

  it("preserves the root QA error when run projection itself fails", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    const concurrencyError = Object.assign(new Error("QA already running"), {
      code: "QA_CONCURRENCY",
    });
    prisma.contentRun.findFirst
      .mockResolvedValueOnce(run)
      .mockRejectedValueOnce(new Error("projection storage unavailable"));
    runQaForAsset.mockRejectedValue(concurrencyError);

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).rejects.toBe(concurrencyError);

    expect(run.status).toBe("qa_running");
  });

  it("preserves a pre-evaluation concurrency failure for a later retry", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    const concurrencyError = Object.assign(new Error("QA already running"), {
      code: "QA_CONCURRENCY",
    });
    runQaForAsset.mockRejectedValue(concurrencyError);

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).rejects.toBe(concurrencyError);

    expect(run.status).toBe("qa_running");
    expect(prisma.contentRun.updateMany).not.toHaveBeenCalled();
  });

  it("returns the valid result when a concurrent caller already projected the same run state", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    runQaForAsset.mockImplementation(async () => {
      run.images[0].qaStatus = "APPROVED";
      run.images[0].qaScore = 94;
      run.images[0].qaVerdictJson = JSON.stringify({
        decision: "APPROVE",
        overallScore: 94,
      });
      // A concurrent managed-QA caller has already projected this identical
      // persisted decision while this caller is returning from the QA path.
      run.status = "generating";
      return {
        attemptId: "qa-winner",
        assetId: "image-1",
        assetKind: "image",
        decision: "APPROVE",
        qaStatus: "APPROVED",
        overallScore: 94,
        attemptNumber: 1,
        reason: "approved",
        elapsedMs: 5,
        providerModel: "resolved-provider",
      };
    });

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).resolves.toMatchObject({
      runStatus: "generating",
      requiredNextAction: { type: "GENERATE_VIDEO" },
    });

    expect(prisma.contentRun.updateMany).not.toHaveBeenCalled();
  });

  it("accepts an identical-target race during the run-status compare-and-swap", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    prisma.contentRun.updateMany.mockImplementationOnce(async () => {
      run.status = "generating";
      return { count: 0 };
    });
    runQaForAsset.mockImplementation(async () => {
      run.images[0].qaStatus = "APPROVED";
      run.images[0].qaScore = 94;
      run.images[0].qaVerdictJson = JSON.stringify({
        decision: "APPROVE",
        overallScore: 94,
      });
      return {
        attemptId: "qa-race",
        assetId: "image-1",
        assetKind: "image",
        decision: "APPROVE",
        qaStatus: "APPROVED",
        overallScore: 94,
        attemptNumber: 1,
        reason: "approved",
        elapsedMs: 5,
        providerModel: "resolved-provider",
      };
    });

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).resolves.toMatchObject({
      runStatus: "generating",
      requiredNextAction: { type: "GENERATE_VIDEO" },
    });
  });

  it("reconciles a persisted QA decision after the first run-status write fails", async () => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    const synchronizationError = new Error("run status storage unavailable");
    prisma.contentRun.updateMany.mockRejectedValueOnce(synchronizationError);
    runQaForAsset.mockImplementation(async () => {
      run.images[0].qaStatus = "APPROVED";
      run.images[0].qaScore = 94;
      run.images[0].qaVerdictJson = JSON.stringify({
        decision: "APPROVE",
        overallScore: 94,
      });
      return {
        attemptId: "qa-persisted",
        assetId: "image-1",
        assetKind: "image",
        decision: "APPROVE",
        qaStatus: "APPROVED",
        overallScore: 94,
        attemptNumber: 1,
        reason: "approved",
        elapsedMs: 5,
        providerModel: "resolved-provider",
      };
    });
    const command = {
      contentRunId: "run-1",
      assetId: "image-1",
      assetKind: "image" as const,
    };

    await expect(
      runManagedQa(actor, command, { prisma: prisma as never }),
    ).rejects.toBe(synchronizationError);
    expect(run.status).toBe("qa_running");

    await expect(
      runManagedQa(actor, command, { prisma: prisma as never }),
    ).resolves.toMatchObject({
      contentRunId: "run-1",
      assetId: "image-1",
      decision: "APPROVE",
      qaStatus: "APPROVED",
      runStatus: "generating",
      requiredNextAction: { type: "GENERATE_VIDEO" },
    });

    expect(runQaForAsset).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("generating");
  });

  it("rejects caller-supplied QA decisions, scores, or provider credentials", async () => {
    const prisma = createPrisma();

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
          decision: "APPROVE",
          overallScore: 100,
          providerCredential: "caller-secret",
        } as never,
        { prisma: prisma as never },
      ),
    ).rejects.toMatchObject({ code: "INVALID_MANAGED_QA_REQUEST" });

    expect(runQaForAsset).not.toHaveBeenCalled();
    expect(prisma.contentRun.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { contentRunId: undefined, assetId: "image-1", assetKind: "image" },
    { contentRunId: "run-1", assetId: 42, assetKind: "image" },
    { contentRunId: "run-1", assetId: "image-1", assetKind: "audio" },
  ])("rejects malformed runtime command values before storage access", async (command) => {
    const prisma = createPrisma();

    await expect(
      runManagedQa(actor, command as never, { prisma: prisma as never }),
    ).rejects.toMatchObject({ code: "INVALID_MANAGED_QA_REQUEST" });

    expect(runQaForAsset).not.toHaveBeenCalled();
    expect(prisma.contentRun.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { style: "style2", objective: "create_style1_piece", specVersion: "managed-style1-v1" },
    { style: "style1", objective: "other_objective", specVersion: "managed-style1-v1" },
    { style: "style1", objective: "create_style1_piece", specVersion: "managed-style1-v2" },
  ])(
    "rejects a non-managed-Style-1-V1 run before QA",
    async ({ style, objective, specVersion }) => {
      const run = createRunFixture();
      run.style = style;
      run.promptSnapshotJson = JSON.stringify({
        objective,
        specVersion,
        modelSnapshot: {
          imageModel: "nano-banana-pro",
          videoModel: "veo-3.1-lite",
        },
      });
      const prisma = createPrisma(run);

      await expect(
        runManagedQa(
          actor,
          {
            contentRunId: "run-1",
            assetId: "image-1",
            assetKind: "image",
          },
          { prisma: prisma as never },
        ),
      ).rejects.toMatchObject({ code: "MANAGED_ASSET_NOT_READY" });

      expect(runQaForAsset).not.toHaveBeenCalled();
      expect(prisma.contentRun.updateMany).not.toHaveBeenCalled();
    },
  );

  it("fails closed for another workspace or another run before QA", async () => {
    const prisma = createPrisma();
    const otherWorkspaceActor = { ...actor, workspaceId: "workspace-2" };

    await expect(
      runManagedQa(
        otherWorkspaceActor,
        {
          contentRunId: "run-1",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_NOT_FOUND" });
    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-other",
          assetId: "image-1",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).rejects.toMatchObject({ code: "CONTENT_RUN_NOT_FOUND" });

    expect(runQaForAsset).not.toHaveBeenCalled();
    expect(prisma.contentRun.updateMany).not.toHaveBeenCalled();
  });

  it("invokes QA only for the persisted asset projected as RUN_QA", async () => {
    const run = createRunFixture();
    run.images.push({
      id: "image-out-of-order",
      contentRunId: "run-1",
      sceneLabel: "scene_2_home_image",
      attemptNumber: 1,
      qaStatus: "NOT_QA_CHECKED",
      qaScore: null,
      qaVerdictJson: null,
    });
    const prisma = createPrisma(run);

    await expect(
      runManagedQa(
        actor,
        {
          contentRunId: "run-1",
          assetId: "image-out-of-order",
          assetKind: "image",
        },
        { prisma: prisma as never },
      ),
    ).rejects.toMatchObject({ code: "MANAGED_ASSET_NOT_READY" });

    expect(runQaForAsset).not.toHaveBeenCalled();
    expect(prisma.contentRun.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      signal: "REGENERATE",
      result: {
        overallScore: 25,
        hasHardFailure: true,
        checks: [
          {
            name: "PRODUCT_PRESENT",
            passed: false,
            score: 0,
            severity: "critical",
          },
        ],
        issues: [
          {
            type: "missing-product",
            severity: "critical",
            description: "Product is absent",
          },
        ],
      },
    },
    {
      signal: "HUMAN_REVIEW",
      result: {
        overallScore: 70,
        hasHardFailure: false,
        checks: [{ name: "PRODUCT_PRESENT", passed: true, score: 80 }],
        issues: [],
      },
    },
  ])("projects a valid $signal evaluator outcome to run HUMAN_REVIEW", async ({ result }) => {
    const run = createRunFixture();
    const prisma = createPrisma(run);
    runQaForAsset.mockImplementation(async (input) => {
      const decision = decide({
        result: result as never,
        attemptNumber: 1,
        config: input.configOverride,
      });
      expect(decision.decision).toBe("HUMAN_REVIEW");
      run.images[0].qaStatus = "HUMAN_REVIEW";
      run.images[0].qaScore = result.overallScore;
      run.images[0].qaVerdictJson = JSON.stringify({
        decision: decision.decision,
        overallScore: result.overallScore,
      });
      return {
        attemptId: "qa-human",
        assetId: "image-1",
        assetKind: "image",
        decision: decision.decision,
        qaStatus: "HUMAN_REVIEW",
        overallScore: result.overallScore,
        attemptNumber: 1,
        reason: decision.reason,
        elapsedMs: 5,
        providerModel: "resolved-provider",
      };
    });

    const resultOutput = await runManagedQa(
      actor,
      {
        contentRunId: "run-1",
        assetId: "image-1",
        assetKind: "image",
      },
      { prisma: prisma as never },
    );

    expect(resultOutput.runStatus).toBe("human_review");
    expect(resultOutput.requiredNextAction.type).toBe("HUMAN_REVIEW");
    expect(prisma.contentOperation.create).not.toHaveBeenCalled();
    expect(prisma.flowGeneratedImage.create).not.toHaveBeenCalled();
    expect(prisma.flowGeneratedVideo.create).not.toHaveBeenCalled();
  });

  it("marks a fully approved four-slot run ready without creating repair work", async () => {
    const run = createRunFixture();
    run.images[0].qaStatus = "APPROVED";
    run.images.push({
      id: "image-2",
      contentRunId: "run-1",
      sceneLabel: "scene_2_home_image",
      attemptNumber: 1,
      qaStatus: "APPROVED",
      qaScore: 90,
      qaVerdictJson: JSON.stringify({ decision: "APPROVE", overallScore: 90 }),
    });
    run.videos.push(
      {
        id: "video-1",
        contentRunId: "run-1",
        sceneLabel: "scene_1_store",
        attemptNumber: 1,
        qaStatus: "APPROVED",
        qaScore: 90,
        qaVerdictJson: JSON.stringify({ decision: "APPROVE", overallScore: 90 }),
      },
      {
        id: "video-2",
        contentRunId: "run-1",
        sceneLabel: "scene_2_home",
        attemptNumber: 1,
        qaStatus: "NOT_QA_CHECKED",
        qaScore: null,
        qaVerdictJson: null,
      },
    );
    const prisma = createPrisma(run);
    runQaForAsset.mockImplementation(async () => {
      run.videos[1].qaStatus = "APPROVED";
      run.videos[1].qaScore = 96;
      run.videos[1].qaVerdictJson = JSON.stringify({
        decision: "APPROVE",
        overallScore: 96,
      });
      return {
        attemptId: "qa-last",
        assetId: "video-2",
        assetKind: "video",
        decision: "APPROVE",
        qaStatus: "APPROVED",
        overallScore: 96,
        attemptNumber: 1,
        reason: "approved",
        elapsedMs: 5,
        providerModel: "resolved-provider",
      };
    });

    const result = await runManagedQa(
      actor,
      {
        contentRunId: "run-1",
        assetId: "video-2",
        assetKind: "video",
      },
      { prisma: prisma as never },
    );

    expect(result).toMatchObject({
      runStatus: "ready",
      requiredNextAction: { type: "COMPLETE" },
    });
    expect(prisma.contentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: "qa_running",
        product: { batch: { workspaceId: "workspace-1" } },
      },
      data: { status: "ready", completedAt: expect.any(Date) },
    });
    expect(prisma.contentOperation.create).not.toHaveBeenCalled();
    expect(prisma.flowGeneratedImage.create).not.toHaveBeenCalled();
    expect(prisma.flowGeneratedVideo.create).not.toHaveBeenCalled();
  });
});
