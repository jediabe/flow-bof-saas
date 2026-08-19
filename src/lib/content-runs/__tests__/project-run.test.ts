import { describe, expect, it } from "vitest";
import { projectContentRun, type ProjectContentRunInput } from "../project-run";
import { ContentRunProjectionSchema } from "../schemas";

const snapshot = JSON.stringify({
  objective: "Create one managed Style 1 asset",
  specVersion: "managed-style1-v1",
  modelSnapshot: { imageModel: "nano-banana-pro", videoModel: "veo-3.1-lite" },
});

function baseInput(
  overrides: Partial<ProjectContentRunInput> = {},
): ProjectContentRunInput {
  return {
    run: {
      id: "run-1",
      productId: "product-1",
      status: "generating",
      promptSnapshotJson: snapshot,
    },
    images: [],
    videos: [],
    operations: [],
    ...overrides,
  };
}

function image(
  id: string,
  sceneLabel: "scene_1_store_image" | "scene_2_home_image",
  qaStatus: string,
  contentRunId: string | null = "run-1",
) {
  return {
    id,
    contentRunId,
    sceneLabel,
    attemptNumber: 1,
    qaStatus,
    qaScore: qaStatus === "APPROVED" ? 95 : null,
    qaVerdictJson:
      qaStatus === "APPROVED"
        ? JSON.stringify({
            overallScore: 95,
            checks: [{ name: "PRODUCT_PRESENT", passed: true, score: 95 }],
            issues: [],
            hasHardFailure: false,
          })
        : null,
  };
}

function video(
  id: string,
  sceneLabel: "scene_1_store" | "scene_2_home",
  qaStatus: string,
  contentRunId: string | null = "run-1",
) {
  return {
    id,
    contentRunId,
    sceneLabel,
    attemptNumber: 1,
    qaStatus,
    qaScore: qaStatus === "APPROVED" ? 94 : null,
    qaVerdictJson: null,
  };
}

describe("projectContentRun", () => {
  it("starts with the store image", () => {
    const projection = projectContentRun(baseInput());

    expect(projection.requiredNextAction).toEqual({
      type: "GENERATE_IMAGE",
      slot: "scene_1_store_image",
    });
    expect(projection.slots).toHaveLength(4);
    expect(ContentRunProjectionSchema.parse(projection)).toEqual(projection);
  });

  it("always sends a persisted NOT_QA_CHECKED managed asset to QA", () => {
    const projection = projectContentRun(
      baseInput({
        images: [image("home-image", "scene_2_home_image", "NOT_QA_CHECKED")],
      }),
    );

    expect(projection.requiredNextAction).toEqual({
      type: "RUN_QA",
      slot: "scene_2_home_image",
      assetId: "home-image",
    });
  });

  it("keeps an out-of-order QA_RUNNING asset ahead of generation", () => {
    const projection = projectContentRun(
      baseInput({
        images: [image("home-image", "scene_2_home_image", "QA_RUNNING")],
      }),
    );

    expect(projection.requiredNextAction).toEqual({
      type: "RUN_QA",
      slot: "scene_2_home_image",
      assetId: "home-image",
    });
  });

  it("does not expose legacy assets without this contentRunId", () => {
    const projection = projectContentRun(
      baseInput({
        images: [
          image("legacy", "scene_1_store_image", "NOT_QA_CHECKED", null),
          image("other-run", "scene_2_home_image", "APPROVED", "run-2"),
        ],
      }),
    );

    expect(projection.slots.every((slot) => slot.attempts.length === 0)).toBe(true);
    expect(projection.requiredNextAction).toEqual({
      type: "GENERATE_IMAGE",
      slot: "scene_1_store_image",
    });
  });

  it("does not make store video next until store image is approved", () => {
    const pending = projectContentRun(
      baseInput({
        images: [image("store-image", "scene_1_store_image", "QA_RUNNING")],
      }),
    );
    expect(pending.requiredNextAction).toEqual({
      type: "RUN_QA",
      slot: "scene_1_store_image",
      assetId: "store-image",
    });

    const approved = projectContentRun(
      baseInput({
        images: [image("store-image", "scene_1_store_image", "APPROVED")],
      }),
    );
    expect(approved.requiredNextAction).toEqual({
      type: "GENERATE_VIDEO",
      slot: "scene_1_store_video",
      sourceAssetId: "store-image",
    });
    expect(approved.slots[0].attempts[0].latestQa).toEqual({
      decision: "APPROVE",
      score: 95,
    });
  });

  it("applies the same source-image approval rule to the home video", () => {
    const prior = {
      images: [image("store-image", "scene_1_store_image", "APPROVED")],
      videos: [video("store-video", "scene_1_store", "APPROVED")],
    };
    const pending = projectContentRun(
      baseInput({
        ...prior,
        images: [
          ...prior.images,
          image("home-image", "scene_2_home_image", "QA_RUNNING"),
        ],
      }),
    );
    expect(pending.requiredNextAction.type).not.toBe("GENERATE_VIDEO");

    const approved = projectContentRun(
      baseInput({
        ...prior,
        images: [
          ...prior.images,
          image("home-image", "scene_2_home_image", "APPROVED"),
        ],
      }),
    );
    expect(approved.requiredNextAction).toEqual({
      type: "GENERATE_VIDEO",
      slot: "scene_2_home_video",
      sourceAssetId: "home-image",
    });
  });

  it("derives ready only when all four selected assets are approved", () => {
    const complete = baseInput({
      run: { ...baseInput().run, status: "qa_running" },
      images: [
        image("store-image", "scene_1_store_image", "APPROVED"),
        image("home-image", "scene_2_home_image", "APPROVED"),
      ],
      videos: [
        video("store-video", "scene_1_store", "APPROVED"),
        video("home-video", "scene_2_home", "APPROVED"),
      ],
    });
    expect(projectContentRun(complete)).toMatchObject({
      status: "ready",
      requiredNextAction: { type: "COMPLETE" },
    });
    expect(
      projectContentRun({
        ...complete,
        run: { ...complete.run, status: "ready" },
        operations: [
          {
            id: "stale-failure",
            contentRunId: "run-1",
            kind: "image_generation",
            sceneLabel: "scene_1_store_image",
            status: "failed",
            errorJson: JSON.stringify({ code: "OLD_FAILURE" }),
          },
        ],
      }),
    ).toMatchObject({ status: "ready", requiredNextAction: { type: "COMPLETE" } });

    const invalidPersistedReady = projectContentRun(
      baseInput({ run: { ...baseInput().run, status: "ready" } }),
    );
    expect(invalidPersistedReady.status).not.toBe("ready");
    expect(invalidPersistedReady.requiredNextAction.type).toBe("FAILED");
  });

  it.each(["REGEN_NEEDED", "REGEN_IN_FLIGHT", "HUMAN_REVIEW"])(
    "maps %s to human review without a dependent action",
    (qaStatus) => {
      const projection = projectContentRun(
        baseInput({
          images: [image("store-image", "scene_1_store_image", qaStatus)],
        }),
      );

      expect(projection.status).toBe("human_review");
      expect(projection.requiredNextAction).toMatchObject({ type: "HUMAN_REVIEW" });
      expect(["GENERATE_IMAGE", "GENERATE_VIDEO"]).not.toContain(
        projection.requiredNextAction.type,
      );
    },
  );

  it("waits for an active provider operation", () => {
    const projection = projectContentRun(
      baseInput({
        operations: [
          {
            id: "operation-1",
            contentRunId: "run-1",
            kind: "video_generation",
            sceneLabel: "scene_1_store",
            status: "running",
            providerJobId: "job-1",
          },
        ],
      }),
    );

    expect(projection.activeOperation).toMatchObject({ id: "operation-1" });
    expect(projection.requiredNextAction).toEqual({
      type: "WAIT_FOR_OPERATION",
      operationId: "operation-1",
    });
  });

  it("fails closed on invalid operation vocabulary", () => {
    const projection = projectContentRun(
      baseInput({
        operations: [
          {
            id: "operation-1",
            contentRunId: "run-1",
            kind: "repair_generation",
            sceneLabel: "scene_1_store_image",
            status: "running",
          },
        ],
      }),
    );

    expect(projection.status).toBe("failed");
    expect(JSON.parse(projection.terminalReason!)).toEqual({
      code: "INVALID_OPERATION_RECORD",
      operationId: "operation-1",
    });
  });

  it("projects a failed operation with a structured terminal reason", () => {
    const projection = projectContentRun(
      baseInput({
        operations: [
          {
            id: "operation-1",
            contentRunId: "run-1",
            kind: "image_generation",
            sceneLabel: "scene_1_store_image",
            status: "failed",
            errorJson: JSON.stringify({
              code: "PROVIDER_REJECTED",
              retryable: false,
              message: "Authorization: Bearer provider-secret",
              upstreamPayload: { account: "private@example.test" },
            }),
          },
        ],
      }),
    );

    expect(projection.status).toBe("failed");
    expect(projection.requiredNextAction.type).toBe("FAILED");
    expect(JSON.parse(projection.terminalReason!)).toEqual({
      code: "PROVIDER_REJECTED",
      retryable: false,
    });
  });
});
