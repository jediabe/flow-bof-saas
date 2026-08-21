import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  product: { findFirst: vi.fn() },
  contentRun: { findFirst: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ db: database }));

import { getApprovedProduct, getManagedRunView } from "../queries";

const actor = { workspaceId: "workspace_a", actorType: "service" as const, actorId: "hermes-test" };

describe("Hermes managed content queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.product.findFirst.mockResolvedValue(null);
    database.contentRun.findFirst.mockResolvedValue(null);
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
});
