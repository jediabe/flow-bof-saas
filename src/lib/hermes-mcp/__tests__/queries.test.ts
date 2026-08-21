import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  product: { findFirst: vi.fn() },
  contentRun: { findFirst: vi.fn() },
  contentOperation: { findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: database }));

import { getApprovedProduct, getGenerationReplayOperation, getManagedRunView } from "../queries";

const actor = { workspaceId: "workspace_a", actorType: "service" as const, actorId: "hermes-test" };

describe("Hermes managed content queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.product.findFirst.mockResolvedValue(null);
    database.contentRun.findFirst.mockResolvedValue(null);
    database.contentOperation.findFirst.mockResolvedValue(null);
  });

  it("scopes product lookup to approved non-deleted rows in the actor workspace", async () => {
    await expect(getApprovedProduct(actor, "product_other")).rejects.toMatchObject({
      code: "PRODUCT_NOT_FOUND",
      status: 404,
    });
    expect(database.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "product_other",
        deletedAt: null,
        reviewStatus: "approved",
        batch: { workspaceId: "workspace_a" },
      },
    }));
  });

  it("returns the same opaque 404 for a missing or cross-workspace run", async () => {
    await expect(getManagedRunView(actor, "run_other")).rejects.toMatchObject({
      code: "CONTENT_RUN_NOT_FOUND",
      status: 404,
    });
    expect(database.contentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "run_other",
        product: { batch: { workspaceId: "workspace_a" } },
      },
    }));
  });

  it("resolves replay only through the exact active operation in the actor workspace and run", async () => {
    await expect(getGenerationReplayOperation(actor, "run_1", "op_1")).resolves.toBeNull();

    expect(database.contentOperation.findFirst).toHaveBeenCalledWith({
      where: {
        id: "op_1",
        workspaceId: "workspace_a",
        contentRunId: "run_1",
        status: { in: ["requested", "running"] },
        contentRun: { product: { batch: { workspaceId: "workspace_a" } } },
      },
      select: {
        id: true,
        workspaceId: true,
        contentRunId: true,
        kind: true,
        sceneLabel: true,
        status: true,
        idempotencyKey: true,
      },
    });
  });
});
