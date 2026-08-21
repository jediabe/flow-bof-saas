import { describe, expect, it, vi } from "vitest";
import { createHermesContentHandlers, type ManagedRunView } from "../handlers";

const actor = { workspaceId: "workspace_a", actorType: "service" as const, actorId: "hermes-test" };

function runView(action: ManagedRunView["run"]["requiredNextAction"], overrides: Partial<ManagedRunView> = {}): ManagedRunView {
  return {
    style: { id: "style1", version: "managed-style1-v1", variant: "store_discovery" },
    slotMediaTypes: {
      scene_1_store_image: "image",
      scene_1_store_video: "video",
      scene_2_home_image: "image",
      scene_2_home_video: "video",
    },
    run: {
      id: "run_1",
      productId: "product_1",
      objective: "create_style1_piece",
      status: "generating",
      specVersion: "managed-style1-v1",
      modelSnapshot: { imageModel: "nano-banana-pro", videoModel: "veo-3.1-lite" },
      slots: [],
      requiredNextAction: action,
    },
    ...overrides,
  };
}

describe("Hermes managed content handlers", () => {
  it("binds the authenticated workspace and returns frozen style identity when creating a run", async () => {
    const createRun = vi.fn().mockResolvedValue({ id: "run_1" });
    const getRun = vi.fn().mockResolvedValue(runView({ type: "GENERATE_IMAGE", slot: "scene_1_store_image" }));
    const handlers = createHermesContentHandlers(actor, { createRun, getRun });

    const result = await handlers.content_create_run({
      productId: "product_1",
      style: "style1",
      idempotencyKey: "create_1",
      compilerInput: {
        styleId: "style1",
        version: "managed-style1-v1",
        variant: "store_discovery",
        productReferenceImageId: "image_1",
        style1Kit: {
          productName: "Example",
          market: "UK",
          category: "Home/Storage",
          copy: { part1Options: ["Part one"], part2Options: ["Part two"], part3Options: ["Part three"] },
          hashtags: ["#AIGC"],
          productDescription: "Description",
          discountPercent: 20,
          warnings: [],
        },
      },
    });

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace_a",
      productId: "product_1",
      styleId: "style1",
    }));
    expect(result).toMatchObject({
      style: { id: "style1", version: "managed-style1-v1", variant: "store_discovery" },
      nextAction: { type: "GENERATE_IMAGE", slot: "scene_1_store_image" },
    });
  });

  it.each([
    ["style1", "scene_1_store_image"],
    ["style2", "N2"],
  ] as const)("follows the %s manifest image action without provider arguments", async (style, slot) => {
    const generateImage = vi.fn().mockResolvedValue({ operationId: "operation_1" });
    const view = runView({ type: "GENERATE_IMAGE", slot }, style === "style2" ? {
      style: { id: "style2", version: "managed-style2-v1", variant: "handheld" },
      slotMediaTypes: { N1: "video", N2: "image" },
    } : {});
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(view),
      generateImage,
    });

    await handlers.content_generate_image({ contentRunId: "run_1", idempotencyKey: "image_1" });

    expect(generateImage).toHaveBeenCalledWith(actor, {
      contentRunId: "run_1",
      slot,
      idempotencyKey: "image_1",
    });
    expect(JSON.stringify(generateImage.mock.calls)).not.toMatch(/prompt|flowEmail|model|workspaceId.*workspaceId/);
  });

  it("derives the exact QA asset kind and stable asset id from the manifest action", async () => {
    const runQa = vi.fn().mockResolvedValue({ decision: "APPROVE", qaStatus: "APPROVED" });
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView(
        { type: "RUN_QA", slot: "N1", assetId: "asset_stable" },
        {
          style: { id: "style2", version: "managed-style2-v1", variant: "handheld" },
          slotMediaTypes: { N1: "video" },
        },
      )),
      runQa,
    });

    await handlers.content_run_qa({ contentRunId: "run_1" });

    expect(runQa).toHaveBeenCalledWith(actor, {
      contentRunId: "run_1",
      assetId: "asset_stable",
      assetKind: "video",
    });
  });

  it.each([
    [{ type: "WAIT_FOR_OPERATION", operationId: "op_1" }, "WAIT"],
    [{ type: "GENERATE_VOICEOVER" }, "GENERATE_VOICEOVER"],
    [{ type: "ASSEMBLE_FINAL", finalVideoId: "final_1" }, "ASSEMBLE_FINAL"],
    [{ type: "RUN_FINAL_QA", finalVideoId: "final_1" }, "RUN_FINAL_QA"],
    [{ type: "COMPLETE" }, "READY"],
    [{ type: "HUMAN_REVIEW", reason: "qa rejected" }, "HUMAN_REVIEW"],
    [{ type: "FAILED", reason: "pipeline failed" }, "FAILED"],
  ] as const)("maps final manifest action %s to %s and drives at most one phase", async (nextAction, expected) => {
    const runFinalOutput = vi.fn().mockResolvedValue({ phase: expected, status: "ok", finalVideoId: "final_1" });
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView(nextAction as ManagedRunView["run"]["requiredNextAction"])),
      runFinalOutput,
    });

    const result = await handlers.content_run_final_output({ contentRunId: "run_1", idempotencyKey: "final_root" });

    expect(result.action).toBe(expected);
    expect(runFinalOutput).toHaveBeenCalledTimes(
      ["GENERATE_VOICEOVER", "ASSEMBLE_FINAL", "RUN_FINAL_QA"].includes(expected) ? 1 : 0,
    );
  });

  it.each([
    ["ready", "READY"],
    ["human_review", "HUMAN_REVIEW"],
    ["failed", "FAILED"],
  ] as const)("returns terminal action %s after final QA completes", async (status, expectedAction) => {
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView({ type: "RUN_FINAL_QA", finalVideoId: "final_1" })),
      runFinalOutput: vi.fn().mockResolvedValue({
        phase: "RUN_FINAL_QA",
        status,
        finalVideoId: "final_1",
      }),
    });

    const result = await handlers.content_run_final_output({
      contentRunId: "run_1",
      idempotencyKey: "final_root",
    });

    expect(result.action).toBe(expectedAction);
  });

  it("replays a final phase with the same stable idempotency root", async () => {
    const runFinalOutput = vi.fn().mockResolvedValue({
      phase: "ASSEMBLE_FINAL",
      status: "generating",
      finalVideoId: "final_1",
    });
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView({ type: "ASSEMBLE_FINAL", finalVideoId: "final_1" })),
      runFinalOutput,
    });

    const command = { contentRunId: "run_1", idempotencyKey: "final_root" };
    await handlers.content_run_final_output(command);
    await handlers.content_run_final_output(command);

    expect(runFinalOutput).toHaveBeenNthCalledWith(1, actor, {
      contentRunId: "run_1",
      idempotencyRoot: "final_root",
    });
    expect(runFinalOutput).toHaveBeenNthCalledWith(2, actor, {
      contentRunId: "run_1",
      idempotencyRoot: "final_root",
    });
  });

  it("replays and polls the same in-flight video command without changing its real result", async () => {
    const activeOperation = {
      id: "op_video_1",
      kind: "video_generation" as const,
      status: "running" as const,
      slot: "scene_1_store_video" as const,
      providerJobId: "provider_job_1",
    };
    const getGenerationReplayOperation = vi.fn().mockResolvedValue({
      id: activeOperation.id,
      workspaceId: actor.workspaceId,
      contentRunId: "run_1",
      kind: activeOperation.kind,
      sceneLabel: "scene_1_store",
      status: activeOperation.status,
      idempotencyKey: "video_stable_1",
    });
    const realResult = {
      operationId: activeOperation.id,
      operationStatus: "running",
      contentRunId: "run_1",
      slot: activeOperation.slot,
      providerJobId: activeOperation.providerJobId,
      requiredNextAction: { type: "WAIT_FOR_OPERATION", operationId: activeOperation.id },
    };
    const generateVideo = vi.fn().mockResolvedValue(realResult);
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView(
        { type: "WAIT_FOR_OPERATION", operationId: activeOperation.id },
        { run: { ...runView({ type: "WAIT_FOR_OPERATION", operationId: activeOperation.id }).run, activeOperation } },
      )),
      getGenerationReplayOperation,
      generateVideo,
    });

    const result = await handlers.content_generate_video({
      contentRunId: "run_1",
      idempotencyKey: "video_stable_1",
    });

    expect(getGenerationReplayOperation).toHaveBeenCalledWith(actor, "run_1", activeOperation.id);
    expect(generateVideo).toHaveBeenCalledOnce();
    expect(generateVideo).toHaveBeenCalledWith(actor, {
      contentRunId: "run_1",
      idempotencyKey: "video_stable_1",
      slot: "scene_1_store_video",
    });
    expect(result).toBe(realResult);
  });

  it("rejects synchronous image WAIT replay before service work because no safe poll identity is representable", async () => {
    const activeOperation = {
      id: "op_image_1",
      kind: "image_generation" as const,
      status: "running" as const,
      slot: "scene_1_store_image" as const,
    };
    const getGenerationReplayOperation = vi.fn();
    const generateImage = vi.fn();
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView(
        { type: "WAIT_FOR_OPERATION", operationId: activeOperation.id },
        { run: { ...runView({ type: "WAIT_FOR_OPERATION", operationId: activeOperation.id }).run, activeOperation } },
      )),
      getGenerationReplayOperation,
      generateImage,
    });

    await expect(handlers.content_generate_image({
      contentRunId: "run_1",
      idempotencyKey: "image_stable_1",
    })).rejects.toMatchObject({ code: "ACTION_NOT_READY" });

    expect(getGenerationReplayOperation).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it.each([
    ["different key", { idempotencyKey: "other_key" }, "video_stable_1", undefined],
    ["different slot", {}, "video_stable_1", { slot: "scene_2_home_video" }],
    ["different kind", { kind: "image_generation" }, "video_stable_1", undefined],
    ["cross-workspace operation", null, "video_stable_1", undefined],
  ] as const)("rejects WAIT replay for %s before generation", async (_case, operationOverrides, commandKey, activeOverrides) => {
    const activeOperation = {
      id: "op_video_1",
      kind: "video_generation" as const,
      status: "running" as const,
      slot: "scene_1_store_video" as const,
      ...activeOverrides,
    };
    const persistedOperation = operationOverrides === null ? null : {
      id: activeOperation.id,
      workspaceId: actor.workspaceId,
      contentRunId: "run_1",
      kind: "video_generation",
      sceneLabel: "scene_1_store",
      status: "running",
      idempotencyKey: "video_stable_1",
      ...operationOverrides,
    };
    const generateVideo = vi.fn();
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView(
        { type: "WAIT_FOR_OPERATION", operationId: activeOperation.id },
        { run: { ...runView({ type: "WAIT_FOR_OPERATION", operationId: activeOperation.id }).run, activeOperation } },
      )),
      getGenerationReplayOperation: vi.fn().mockResolvedValue(persistedOperation),
      generateVideo,
    });

    await expect(handlers.content_generate_video({
      contentRunId: "run_1",
      idempotencyKey: commandKey,
    })).rejects.toMatchObject({ code: "ACTION_NOT_READY" });
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it("rejects WAIT without a projected active operation before resolving or generating", async () => {
    const getGenerationReplayOperation = vi.fn();
    const generateVideo = vi.fn();
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView({ type: "WAIT_FOR_OPERATION", operationId: "op_missing" })),
      getGenerationReplayOperation,
      generateVideo,
    });

    await expect(handlers.content_generate_video({
      contentRunId: "run_1",
      idempotencyKey: "video_stable_1",
    })).rejects.toMatchObject({ code: "ACTION_NOT_READY" });
    expect(getGenerationReplayOperation).not.toHaveBeenCalled();
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it("rejects a terminal run before replay lookup or generation", async () => {
    const getGenerationReplayOperation = vi.fn();
    const generateVideo = vi.fn();
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView({ type: "FAILED", reason: "terminal" }, {
        run: { ...runView({ type: "FAILED", reason: "terminal" }).run, status: "failed" },
      })),
      getGenerationReplayOperation,
      generateVideo,
    });

    await expect(handlers.content_generate_video({
      contentRunId: "run_1",
      idempotencyKey: "video_stable_1",
    })).rejects.toMatchObject({ code: "ACTION_NOT_READY" });
    expect(getGenerationReplayOperation).not.toHaveBeenCalled();
    expect(generateVideo).not.toHaveBeenCalled();
  });

  it("rejects a tool whose requested phase does not match persisted next action before execution", async () => {
    const generateImage = vi.fn();
    const handlers = createHermesContentHandlers(actor, {
      getRun: vi.fn().mockResolvedValue(runView({ type: "GENERATE_VIDEO", slot: "scene_1_store_video", sourceAssetId: "image_1" })),
      generateImage,
    });

    await expect(handlers.content_generate_image({ contentRunId: "run_1", idempotencyKey: "image_1" }))
      .rejects.toMatchObject({ code: "ACTION_NOT_READY" });
    expect(generateImage).not.toHaveBeenCalled();
  });
});
