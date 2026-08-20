import { describe, expect, it } from "vitest";
import { compileStyleManifest } from "@/lib/content-styles/registry";
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
      style: "style1",
      status: "generating",
      promptSnapshotJson: snapshot,
    },
    images: [],
    videos: [],
    operations: [],
    finalVideo: null,
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

function finalVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: "final-1",
    contentRunId: "run-1",
    status: "PENDING",
    audioStorageBucket: null,
    audioStorageKey: null,
    audioContentType: null,
    audioBytes: null,
    audioSha256: null,
    audioDurationSeconds: null,
    assemblyManifestJson: null,
    finalStorageBucket: null,
    finalStorageKey: null,
    finalContentType: null,
    finalBytes: null,
    finalSha256: null,
    finalDurationSeconds: null,
    finalWidth: null,
    finalHeight: null,
    finalVideoCodec: null,
    finalAudioCodec: null,
    mediaValidationPassed: null,
    mediaValidatedAt: null,
    finalQaStatus: "NOT_QA_CHECKED",
    finalQaScore: null,
    finalQaVerdict: null,
    finalQaEvaluatedAt: null,
    failureCode: null,
    failureJson: null,
    ...overrides,
  };
}

describe("projectContentRun", () => {
  it("rejects persisted style disagreement with a frozen managed manifest", () => {
    const styleManifest = compileStyleManifest("style2", "managed-style2-v1", "handheld");
    expect(() =>
      projectContentRun(
        baseInput({
          run: {
            ...baseInput().run,
            style: "style1",
            promptSnapshotJson: JSON.stringify({
              objective: "create_style2_piece",
              style: "style2",
              specVersion: "managed-style2-v1",
              variant: "handheld",
              styleManifest,
              modelSnapshot: {
                imageModel: "nano-banana-pro",
                videoModel: "veo-3.1-lite",
              },
            }),
          },
        }),
      ),
    ).toThrow(/style/i);
  });

  it("rejects persisted Style 1 disagreement with a manifest-less Style 2 snapshot", () => {
    expect(() =>
      projectContentRun(
        baseInput({
          run: {
            ...baseInput().run,
            style: "style1",
            promptSnapshotJson: JSON.stringify({
              objective: "create_style2_piece",
              style: "style2",
              specVersion: "managed-style2-v1",
              variant: "handheld",
              modelSnapshot: {
                imageModel: "nano-banana-pro",
                videoModel: "veo-3.1-lite",
              },
            }),
          },
        }),
      ),
    ).toThrow(/style/i);
  });

  it.each(["handheld", "large_countertop", "worn"] as const)(
    "projects the frozen Style 2 %s topology and advances only after every required slot is approved",
    (variant) => {
      const styleManifest = compileStyleManifest("style2", "managed-style2-v1", variant);
      const style2Snapshot = JSON.stringify({
        objective: "create_style2_piece",
        style: "style2",
        specVersion: "managed-style2-v1",
        variant,
        styleManifest,
        modelSnapshot: { imageModel: "nano-banana-pro", videoModel: "veo-3.1-lite" },
      });
      const assets = styleManifest.slots.map((slot) => ({
        id: `${slot.id}-asset`,
        contentRunId: "run-1",
        sceneLabel: slot.id,
        attemptNumber: 1,
        qaStatus: "APPROVED",
        qaScore: 95,
        qaVerdictJson: null,
      }));
      const approved = projectContentRun(
        baseInput({
          run: {
            ...baseInput().run,
            style: "style2",
            promptSnapshotJson: style2Snapshot,
          },
          images: assets.filter((_, index) => styleManifest.slots[index].mediaType === "image"),
          videos: assets.filter((_, index) => styleManifest.slots[index].mediaType === "video"),
        }),
      );

      expect(approved.slots.map((slot) => slot.slot)).toEqual(
        styleManifest.slots.map((slot) => slot.id),
      );
      expect(approved.requiredNextAction).toEqual({ type: "GENERATE_VOICEOVER" });
      expect(ContentRunProjectionSchema.parse(approved)).toEqual(approved);

      const missingFirst = projectContentRun(
        baseInput({
          run: {
            ...baseInput().run,
            style: "style2",
            promptSnapshotJson: style2Snapshot,
          },
          images: assets
            .slice(1)
            .filter((asset) => styleManifest.slots.find((slot) => slot.id === asset.sceneLabel)?.mediaType === "image"),
          videos: assets
            .slice(1)
            .filter((asset) => styleManifest.slots.find((slot) => slot.id === asset.sceneLabel)?.mediaType === "video"),
        }),
      );
      expect(missingFirst.requiredNextAction).toMatchObject({
        type: styleManifest.slots[0].mediaType === "image" ? "GENERATE_IMAGE" : "GENERATE_VIDEO",
        slot: styleManifest.slots[0].id,
      });
      expect(ContentRunProjectionSchema.parse(missingFirst)).toEqual(missingFirst);
    },
  );

  it("starts with the store image", () => {
    const projection = projectContentRun(baseInput());

    expect(projection.requiredNextAction).toEqual({
      type: "GENERATE_IMAGE",
      slot: "scene_1_store_image",
    });
    expect(projection.slots).toHaveLength(4);
    expect(ContentRunProjectionSchema.parse(projection)).toEqual(projection);
  });

  it("preserves persisted created status while deriving the first action", () => {
    const projection = projectContentRun(
      baseInput({ run: { ...baseInput().run, status: "created" } }),
    );

    expect(projection).toMatchObject({
      status: "created",
      requiredNextAction: {
        type: "GENERATE_IMAGE",
        slot: "scene_1_store_image",
      },
    });
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

  it("derives final-output actions and READY only after all five factors", () => {
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
      status: "generating",
      requiredNextAction: { type: "GENERATE_VOICEOVER" },
    });

    const audioReady = finalVideo({
      status: "VOICEOVER_READY",
      audioStorageBucket: "private-media",
      audioStorageKey: "runs/run-1/voice.mp3",
      audioContentType: "audio/mpeg",
      audioBytes: 1234,
      audioSha256: "a".repeat(64),
      audioDurationSeconds: 10,
    });
    expect(projectContentRun({ ...complete, finalVideo: audioReady })).toMatchObject({
      status: "generating",
      requiredNextAction: { type: "ASSEMBLE_FINAL", finalVideoId: "final-1" },
    });

    const validated = finalVideo({
      ...audioReady,
      status: "MEDIA_VALIDATED",
      assemblyManifestJson: "{}",
      finalStorageBucket: "private-media",
      finalStorageKey: "runs/run-1/final.mp4",
      finalContentType: "video/mp4",
      finalBytes: 4567,
      finalSha256: "b".repeat(64),
      finalDurationSeconds: 10,
      finalWidth: 1080,
      finalHeight: 1920,
      finalVideoCodec: "h264",
      finalAudioCodec: "aac",
      mediaValidationPassed: true,
      mediaValidatedAt: new Date(),
    });
    expect(projectContentRun({ ...complete, finalVideo: validated })).toMatchObject({
      status: "qa_running",
      requiredNextAction: { type: "RUN_FINAL_QA", finalVideoId: "final-1" },
    });

    const approved = finalVideo({
      ...validated,
      status: "APPROVED",
      finalQaStatus: "APPROVED",
      finalQaScore: 95,
      finalQaVerdict: "Approved",
      finalQaEvaluatedAt: new Date(),
    });
    expect(projectContentRun({ ...complete, finalVideo: approved })).toMatchObject({
      status: "ready",
      requiredNextAction: { type: "COMPLETE" },
    });
    expect(
      projectContentRun({
        ...complete,
        run: { ...complete.run, status: "ready" },
        finalVideo: approved,
      }),
    ).toMatchObject({ status: "ready", requiredNextAction: { type: "COMPLETE" } });

    for (const factorMissing of [
      { audioStorageKey: null },
      { finalStorageKey: null },
      { mediaValidationPassed: false },
      { finalQaStatus: "FAILED" },
    ]) {
      const projection = projectContentRun({
        ...complete,
        run: { ...complete.run, status: "ready" },
        finalVideo: finalVideo({ ...approved, ...factorMissing }),
      });
      expect(projection.status).not.toBe("ready");
      expect(projection.requiredNextAction.type).toBe("FAILED");
    }

    const missingApprovedSource = projectContentRun({
      ...complete,
      run: { ...complete.run, status: "ready" },
      videos: [video("store-video", "scene_1_store", "APPROVED")],
      finalVideo: approved,
    });
    expect(missingApprovedSource.status).not.toBe("ready");
    expect(missingApprovedSource.requiredNextAction.type).toBe("FAILED");
  });

  it("maps final human review and infrastructure failure to terminal run actions", () => {
    const complete = baseInput({
      images: [
        image("store-image", "scene_1_store_image", "APPROVED"),
        image("home-image", "scene_2_home_image", "APPROVED"),
      ],
      videos: [
        video("store-video", "scene_1_store", "APPROVED"),
        video("home-video", "scene_2_home", "APPROVED"),
      ],
    });
    expect(
      projectContentRun({
        ...complete,
        finalVideo: finalVideo({ status: "HUMAN_REVIEW", finalQaStatus: "HUMAN_REVIEW" }),
      }),
    ).toMatchObject({ status: "human_review", requiredNextAction: { type: "HUMAN_REVIEW" } });
    expect(
      projectContentRun({
        ...complete,
        finalVideo: finalVideo({ status: "FAILED", failureCode: "FFMPEG_FAILED" }),
      }),
    ).toMatchObject({ status: "failed", requiredNextAction: { type: "FAILED" } });
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
