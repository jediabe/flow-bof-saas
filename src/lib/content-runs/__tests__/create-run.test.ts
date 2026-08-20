import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const runs = new Map<string, Record<string, unknown>>();
  const state: {
    product: Record<string, unknown>;
    settings: Record<string, unknown> | null;
    nextRun: number;
  } = {
    product: {},
    settings: null,
    nextRun: 1,
  };

  const client: any = {};
  Object.assign(client, {
    product: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const product = state.product as {
          id?: string;
          batch?: { workspaceId?: string };
        };
        const batchWhere = where.batch as { workspaceId?: string } | undefined;
        if (
          product.id !== where.id ||
          product.batch?.workspaceId !== batchWhere?.workspaceId
        ) {
          return null;
        }
        return structuredClone(state.product);
      }),
    },
    workspaceSettings: {
      findUnique: vi.fn(async () =>
        state.settings ? structuredClone(state.settings) : null,
      ),
    },
    contentRun: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const key = where.productId_idempotencyKey as {
          productId: string;
          idempotencyKey: string;
        };
        return runs.get(`${key.productId}:${key.idempotencyKey}`) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const run = {
          id: `run-${state.nextRun++}`,
          status: "created",
          completedAt: null,
          createdAt: new Date("2026-08-19T12:00:00.000Z"),
          updatedAt: new Date("2026-08-19T12:00:00.000Z"),
          ...data,
        };
        runs.set(`${data.productId}:${data.idempotencyKey}`, run);
        return run;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  });

  return { client, runs, state };
});

vi.mock("@/lib/db", () => ({ db: database.client }));

import { createStyle1Run } from "../create-run";

function eligibleProduct() {
  return {
    id: "product-1",
    productName: "Portable Blender",
    category: "kitchen",
    reviewStatus: "approved",
    deletedAt: null,
    market: null,
    discountPercent: 20,
    discountType: "sale",
    batch: { id: "batch-1", workspaceId: "workspace-1", market: "uk" },
    images: [
      {
        id: "reference-1",
        role: "primary",
        url: "/uploads/reference-1.jpg",
        pathLocal: null,
        source: "upload",
        width: 1080,
        height: 1920,
        bytes: 12345,
        createdAt: new Date("2026-08-18T12:00:00.000Z"),
      },
    ],
  };
}

beforeEach(() => {
  database.runs.clear();
  database.state.nextRun = 1;
  database.state.product = eligibleProduct();
  database.state.settings = {
    workspaceId: "workspace-1",
    flowEmail: "operator@example.test",
    flowImageModel: "nano-banana-pro",
    flowVideoModel: "veo-3.1-lite-low-priority",
  };
  vi.clearAllMocks();
});

describe("createStyle1Run", () => {
  it("creates an approved eligible product run with four frozen prompts and effective models", async () => {
    const run = await createStyle1Run({
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-1",
    });

    expect(run.status).toBe("created");
    expect(run.style).toBe("style1");
    expect(run.market).toBe("uk");

    const snapshot = JSON.parse(run.promptSnapshotJson!);
    expect(snapshot.objective).toBe("create_style1_piece");
    expect(snapshot.specVersion).toBe("managed-style1-v1");
    expect(snapshot.modelSnapshot).toEqual({
      imageModel: "nano-banana-pro",
      videoModel: "veo-3.1-lite-low-priority",
    });
    expect(Object.keys(snapshot.prompts)).toEqual([
      "scene_1_store_image",
      "scene_1_store_video",
      "scene_2_home_image",
      "scene_2_home_video",
    ]);
    expect(snapshot.product.references).toEqual([
      expect.objectContaining({
        id: "reference-1",
        role: "primary",
        url: "/uploads/reference-1.jpg",
        bytes: 12345,
      }),
    ]);
    expect(database.client.$transaction).toHaveBeenCalledTimes(1);
    expect(database.client.contentRun.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-approved", { reviewStatus: "needs_review" }, null, "PRODUCT_NOT_APPROVED"],
    ["deleted", { deletedAt: new Date("2026-08-19T00:00:00.000Z") }, null, "PRODUCT_DELETED"],
    ["cross-workspace", { batch: { id: "batch-1", workspaceId: "workspace-2", market: "uk" } }, null, "PRODUCT_NOT_FOUND"],
    ["missing-reference", { images: [] }, null, "PRIMARY_REFERENCE_REQUIRED"],
    ["missing-Flow-account", {}, { flowEmail: "   " }, "FLOW_ACCOUNT_REQUIRED"],
    ["invalid-image-model", {}, { flowImageModel: "caller-selected-model" }, "INVALID_FLOW_MODEL"],
    ["invalid-video-model", {}, { flowVideoModel: "caller-selected-model" }, "INVALID_FLOW_MODEL"],
  ])("rejects %s products without creating a run", async (_label, productPatch, settingsPatch, code) => {
    database.state.product = { ...eligibleProduct(), ...productPatch };
    if (settingsPatch) {
      database.state.settings = { ...database.state.settings, ...settingsPatch };
    }

    const promise = createStyle1Run({
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-invalid",
    });

    await expect(promise).rejects.toMatchObject({
      name: "ContentRunCreationError",
      code,
    });
    expect(database.client.contentRun.create).not.toHaveBeenCalled();
  });

  it("uses application model defaults when a legacy settings row has no values", async () => {
    database.state.settings = {
      workspaceId: "workspace-1",
      flowEmail: "operator@example.test",
      flowImageModel: null,
      flowVideoModel: null,
    };

    const run = await createStyle1Run({
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-defaults",
    });

    expect(JSON.parse(run.promptSnapshotJson!).modelSnapshot).toEqual({
      imageModel: "nano-banana-pro",
      videoModel: "veo-3.1-lite-low-priority",
    });
  });

  it("freezes an allowed deterministic workspace video default when no override is supplied", async () => {
    database.state.settings = {
      ...database.state.settings,
      flowVideoModel: "veo-3.1-quality",
    };

    const run = await createStyle1Run({
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-workspace-video-model",
    });

    expect(JSON.parse(run.promptSnapshotJson!).modelSnapshot.videoModel).toBe(
      "veo-3.1-quality",
    );
  });

  it.each([
    "veo-3.1-lite-low-priority",
    "veo-3.1-lite",
    "veo-3.1-fast",
    "veo-3.1-quality",
  ] as const)("freezes the explicit human video model override %s", async (videoModel) => {
    const run = await createStyle1Run({
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: `objective-${videoModel}`,
      videoModel,
    });

    expect(JSON.parse(run.promptSnapshotJson!).modelSnapshot.videoModel).toBe(videoModel);
  });

  it.each(["omni-flash", "custom-model", "", " veo-3.1-lite "])(
    "rejects invalid explicit video model override %j before creating a run",
    async (videoModel) => {
      await expect(
        createStyle1Run({
          workspaceId: "workspace-1",
          productId: "product-1",
          idempotencyKey: "objective-invalid-override",
          videoModel: videoModel as never,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_FLOW_MODEL",
        details: { field: "videoModel" },
      });
      expect(database.client.$transaction).not.toHaveBeenCalled();
      expect(database.client.product.findFirst).not.toHaveBeenCalled();
      expect(database.client.contentRun.create).not.toHaveBeenCalled();
    },
  );

  it("binds an idempotency key to the first frozen explicit model", async () => {
    const base = {
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-model-bound",
    };
    const original = await createStyle1Run({ ...base, videoModel: "veo-3.1-fast" });
    const replay = await createStyle1Run({ ...base, videoModel: "veo-3.1-quality" });

    expect(replay).toBe(original);
    expect(JSON.parse(replay.promptSnapshotJson!).modelSnapshot.videoModel).toBe(
      "veo-3.1-fast",
    );
    expect(database.client.contentRun.create).toHaveBeenCalledTimes(1);
  });

  it("returns the same frozen run for the same idempotency key", async () => {
    const input = {
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-repeat",
    };
    const original = await createStyle1Run(input);

    database.state.product = {
      ...eligibleProduct(),
      productName: "Mutated after commit",
      category: "tech",
      discountPercent: 90,
      deletedAt: new Date("2026-08-19T13:00:00.000Z"),
    };
    database.state.settings = {
      workspaceId: "workspace-1",
      flowEmail: null,
      flowImageModel: "invalid-after-commit",
      flowVideoModel: "invalid-after-commit",
    };

    const replay = await createStyle1Run(input);

    expect(replay).toBe(original);
    expect(replay.promptSnapshotJson).toBe(original.promptSnapshotJson);
    expect(JSON.parse(replay.promptSnapshotJson!).product.name).toBe("Portable Blender");
    expect(database.client.contentRun.create).toHaveBeenCalledTimes(1);
    expect(database.client.product.findFirst).toHaveBeenCalledTimes(2);
  });

  it("does not disclose an idempotent run across workspace boundaries", async () => {
    const input = {
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-private",
    };
    await createStyle1Run(input);
    database.state.product = {
      ...eligibleProduct(),
      batch: { id: "batch-1", workspaceId: "workspace-2", market: "uk" },
    };

    await expect(
      createStyle1Run({ ...input, workspaceId: "workspace-2-unrelated" }),
    ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
  });

  it("creates a new frozen objective for a different idempotency key", async () => {
    const first = await createStyle1Run({
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-a",
    });
    database.state.product = {
      ...eligibleProduct(),
      productName: "Portable Blender v2",
      category: "tech",
    };

    const second = await createStyle1Run({
      workspaceId: "workspace-1",
      productId: "product-1",
      idempotencyKey: "objective-b",
    });

    expect(second.id).not.toBe(first.id);
    expect(JSON.parse(second.promptSnapshotJson!).product.name).toBe("Portable Blender v2");
    expect(database.client.contentRun.create).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid compiler context before creating a run", async () => {
    database.state.product = { ...eligibleProduct(), category: "unsupported-category" };

    await expect(
      createStyle1Run({
        workspaceId: "workspace-1",
        productId: "product-1",
        idempotencyKey: "objective-invalid-context",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PRODUCT_CONTEXT" });
    expect(database.client.contentRun.create).not.toHaveBeenCalled();
  });
});
