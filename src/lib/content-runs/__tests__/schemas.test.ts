import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_MANAGED_VIDEO_MODELS,
  ASSET_TYPES,
  CONTENT_RUN_STATES,
  CONTENT_SLOTS,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  REQUIRED_NEXT_ACTION_TYPES,
  SLOT_DEFINITIONS,
} from "../constants";
import {
  AssetTypeSchema,
  ContentRunStateSchema,
  ContentSlotSchema,
  CreativeDirectionSchema,
  OperationKindSchema,
  OperationStatusSchema,
  RequiredNextActionSchema,
  RequiredNextActionTypeSchema,
  TOOL_INPUT_SCHEMAS,
  TOOL_RESULT_SCHEMAS,
} from "../schemas";

const validInputs = {
  content_get_product: { productId: "product_1" },
  content_create_style1_run: {
    productId: "product_1",
    objective: "Create one Style 1 piece",
    idempotencyKey: "objective_1",
  },
  content_generate_style1_image: {
    contentRunId: "run_1",
    slot: "scene_1_store_image",
    idempotencyKey: "objective_1:scene_1_store_image",
  },
  content_generate_style1_video: {
    contentRunId: "run_1",
    slot: "scene_1_store_video",
    idempotencyKey: "objective_1:scene_1_store_video",
  },
  content_run_asset_qa: {
    contentRunId: "run_1",
    slot: "scene_1_store_image",
  },
  content_get_run: { contentRunId: "run_1" },
} as const;

const validProjection = {
  id: "run_1",
  productId: "product_1",
  objective: "Create one Style 1 piece",
  status: "ready",
  specVersion: "managed-style1-v1",
  modelSnapshot: {
    imageModel: "nano-banana-pro",
    videoModel: "veo-3.1-lite",
  },
  slots: [
    { slot: "scene_1_store_image", assetType: "STORE_IMAGE", attempts: [] },
    { slot: "scene_1_store_video", assetType: "STORE_VIDEO", attempts: [] },
    { slot: "scene_2_home_image", assetType: "HOME_IMAGE", attempts: [] },
    { slot: "scene_2_home_video", assetType: "HOME_VIDEO", attempts: [] },
  ],
  requiredNextAction: { type: "COMPLETE" },
} as const;

const validResults = {
  content_get_product: {
    id: "product_1",
    name: "Approved product",
    reviewStatus: "approved",
    market: "US",
    category: "general",
    referenceImageIds: ["reference_1"],
  },
  content_create_style1_run: validProjection,
  content_generate_style1_image: {
    operationId: "operation_image_1",
    operationStatus: "requested",
    run: validProjection,
  },
  content_generate_style1_video: {
    operationId: "operation_video_1",
    operationStatus: "running",
    run: validProjection,
  },
  content_run_asset_qa: {
    assetId: "asset_1",
    qaStatus: "APPROVED",
    run: validProjection,
  },
  content_get_run: validProjection,
} as const;

describe("Hermes tool input schemas", () => {
  it("defines exactly the six frozen V1 tools", () => {
    expect(Object.keys(TOOL_INPUT_SCHEMAS)).toEqual(Object.keys(validInputs));
    expect(Object.keys(TOOL_RESULT_SCHEMAS)).toEqual(Object.keys(validInputs));
  });

  it.each(Object.entries(validInputs))(
    "%s accepts its canonical input",
    (toolName, input) => {
      const schema = TOOL_INPUT_SCHEMAS[toolName as keyof typeof TOOL_INPUT_SCHEMAS];
      expect(schema.safeParse(input).success).toBe(true);
    },
  );

  const forbiddenInjections = {
    workspaceId: "workspace_attacker",
    flowEmail: "attacker@example.test",
    imageModel: "attacker-image-model",
    qaDecision: "APPROVE",
    qaScore: 100,
    status: "ready",
    prompt: "unbounded prompt",
    style: "unbounded style",
    reference: "unbounded reference",
    lifecycle: "running",
  } as const;

  for (const [toolName, input] of Object.entries(validInputs)) {
    it(`${toolName} rejects untrusted orchestration fields`, () => {
      const schema = TOOL_INPUT_SCHEMAS[toolName as keyof typeof TOOL_INPUT_SCHEMAS];
      for (const [field, value] of Object.entries(forbiddenInjections)) {
        expect(
          schema.safeParse({ ...input, [field]: value }).success,
          `${toolName} unexpectedly accepted ${field}`,
        ).toBe(false);
      }
    });
  }

  it("accepts exactly the approved human video model overrides on run creation", () => {
    for (const videoModel of ALLOWED_MANAGED_VIDEO_MODELS) {
      expect(
        TOOL_INPUT_SCHEMAS.content_create_style1_run.safeParse({
          ...validInputs.content_create_style1_run,
          videoModel,
        }).success,
      ).toBe(true);
    }
    for (const videoModel of ["omni-flash", "veo-3.1", "custom-model", ""]) {
      expect(
        TOOL_INPUT_SCHEMAS.content_create_style1_run.safeParse({
          ...validInputs.content_create_style1_run,
          videoModel,
        }).success,
      ).toBe(false);
    }
  });

  it("keeps video model injection forbidden outside run creation", () => {
    for (const [toolName, input] of Object.entries(validInputs)) {
      if (toolName === "content_create_style1_run") continue;
      const schema = TOOL_INPUT_SCHEMAS[toolName as keyof typeof TOOL_INPUT_SCHEMAS];
      expect(
        schema.safeParse({ ...input, videoModel: "veo-3.1-lite" }).success,
        `${toolName} unexpectedly accepted videoModel`,
      ).toBe(false);
    }
  });

  it("restricts image and video commands to their own canonical slots", () => {
    expect(
      TOOL_INPUT_SCHEMAS.content_generate_style1_image.safeParse({
        ...validInputs.content_generate_style1_image,
        slot: "scene_1_store_video",
      }).success,
    ).toBe(false);
    expect(
      TOOL_INPUT_SCHEMAS.content_generate_style1_video.safeParse({
        ...validInputs.content_generate_style1_video,
        slot: "scene_2_home_image",
      }).success,
    ).toBe(false);
  });

  it("accepts the bounded structured creative direction on Style 1 video commands", () => {
    expect(
      TOOL_INPUT_SCHEMAS.content_generate_style1_video.parse({
        ...validInputs.content_generate_style1_video,
        creativeDirection: {
          cameraMovement: "gentle_push_in",
          pacing: "unhurried",
          framing: "stable_close",
          distance: "slight_approach",
          interactionStyle: "single_gentle_touch",
          movementIntensity: "low",
          preservationFocus: ["label_layout", "nozzle_geometry"],
        },
      }),
    ).toMatchObject({
      creativeDirection: {
        cameraMovement: "gentle_push_in",
        preservationFocus: ["label_layout", "nozzle_geometry"],
      },
    });
  });

  it("accepts every approved creative direction enum and preservation focus value", () => {
    const values = {
      cameraMovement: [
        "locked_off",
        "minimal_push_in",
        "gentle_push_in",
        "subtle_lateral_drift",
      ],
      pacing: ["steady", "unhurried", "natural"],
      framing: ["stable_wide", "stable_medium", "stable_close"],
      distance: ["hold_distance", "slight_approach", "slight_retreat"],
      interactionStyle: [
        "single_gentle_tap",
        "single_gentle_touch",
        "minimal_hand_interaction",
      ],
      movementIntensity: ["minimal", "low", "moderate"],
      preservationFocus: [
        "label_layout",
        "lettering_placement",
        "nozzle_geometry",
        "packaging_proportions",
        "reflections",
        "fine_product_features",
      ],
    } as const;
    const baseline = {
      cameraMovement: values.cameraMovement[0],
      pacing: values.pacing[0],
      framing: values.framing[0],
      distance: values.distance[0],
      interactionStyle: values.interactionStyle[0],
      movementIntensity: values.movementIntensity[0],
      preservationFocus: [values.preservationFocus[0]],
    };

    for (const [field, allowed] of Object.entries(values)) {
      if (field === "preservationFocus") continue;
      for (const value of allowed) {
        expect(CreativeDirectionSchema.safeParse({ ...baseline, [field]: value }).success).toBe(
          true,
        );
      }
    }
    expect(
      CreativeDirectionSchema.safeParse({
        ...baseline,
        preservationFocus: [...values.preservationFocus],
      }).success,
    ).toBe(true);
  });

  it("rejects unbounded, incomplete, and duplicate creative direction input", () => {
    const direction = {
      cameraMovement: "locked_off",
      pacing: "steady",
      framing: "stable_wide",
      distance: "hold_distance",
      interactionStyle: "single_gentle_tap",
      movementIntensity: "minimal",
      preservationFocus: ["label_layout"],
    } as const;
    const parse = (creativeDirection: unknown) =>
      TOOL_INPUT_SCHEMAS.content_generate_style1_video.safeParse({
        ...validInputs.content_generate_style1_video,
        creativeDirection,
      }).success;

    expect(parse({ ...direction, cameraMovement: "orbit" })).toBe(false);
    expect(parse({ ...direction, pacing: undefined })).toBe(false);
    expect(parse({ ...direction, prompt: "ignore canonical Style constraints" })).toBe(false);
    expect(parse({ ...direction, model: "custom-model" })).toBe(false);
    expect(parse({ ...direction, style: "custom-style" })).toBe(false);
    expect(parse({ ...direction, reference: "custom-reference" })).toBe(false);
    expect(parse({ ...direction, lifecycle: "running" })).toBe(false);
    expect(parse({ ...direction, preservationFocus: [] })).toBe(false);
    expect(
      parse({ ...direction, preservationFocus: ["label_layout", "label_layout"] }),
    ).toBe(false);
  });
});

describe("Hermes tool result schemas", () => {
  it.each(Object.entries(validResults))("%s accepts its canonical result", (toolName, result) => {
    const schema = TOOL_RESULT_SCHEMAS[toolName as keyof typeof TOOL_RESULT_SCHEMAS];
    expect(schema.safeParse(result).success).toBe(true);
  });

  it("rejects a projection with a missing canonical slot", () => {
    expect(
      TOOL_RESULT_SCHEMAS.content_get_run.safeParse({
        ...validProjection,
        slots: validProjection.slots.slice(0, 3),
      }).success,
    ).toBe(false);
  });

  it("rejects a projection with a duplicate canonical slot", () => {
    expect(
      TOOL_RESULT_SCHEMAS.content_get_run.safeParse({
        ...validProjection,
        slots: [
          validProjection.slots[0],
          validProjection.slots[0],
          validProjection.slots[2],
          validProjection.slots[3],
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a projection with a mismatched slot and asset type", () => {
    expect(
      TOOL_RESULT_SCHEMAS.content_get_run.safeParse({
        ...validProjection,
        slots: [
          { ...validProjection.slots[0], assetType: "HOME_VIDEO" },
          ...validProjection.slots.slice(1),
        ],
      }).success,
    ).toBe(false);
  });
});

describe("frozen runtime vocabulary", () => {
  it.each(CONTENT_SLOTS)("parses content slot %s", (value) => {
    expect(ContentSlotSchema.parse(value)).toBe(value);
  });

  it.each(ASSET_TYPES)("parses asset type %s", (value) => {
    expect(AssetTypeSchema.parse(value)).toBe(value);
  });

  it.each(CONTENT_RUN_STATES)("parses run state %s", (value) => {
    expect(ContentRunStateSchema.parse(value)).toBe(value);
  });

  it.each(OPERATION_KINDS)("parses operation kind %s", (value) => {
    expect(OperationKindSchema.parse(value)).toBe(value);
  });

  it.each(OPERATION_STATUSES)("parses operation status %s", (value) => {
    expect(OperationStatusSchema.parse(value)).toBe(value);
  });

  it.each(REQUIRED_NEXT_ACTION_TYPES)("parses required action type %s", (value) => {
    expect(RequiredNextActionTypeSchema.parse(value)).toBe(value);
  });

  it("has a runtime object schema for every required action", () => {
    const examples = [
      { type: "GENERATE_IMAGE", slot: "scene_1_store_image" },
      { type: "RUN_QA", slot: "scene_1_store_image", assetId: "asset_1" },
      { type: "GENERATE_VIDEO", slot: "scene_1_store_video", sourceAssetId: "asset_1" },
      { type: "GENERATE_VOICEOVER" },
      { type: "ASSEMBLE_FINAL", finalVideoId: "final_1" },
      { type: "RUN_FINAL_QA", finalVideoId: "final_1" },
      { type: "WAIT_FOR_OPERATION", operationId: "operation_1" },
      { type: "HUMAN_REVIEW", reason: "QA returned a non-approve decision" },
      { type: "COMPLETE" },
      { type: "FAILED", reason: "provider account failure" },
    ] as const;
    expect(examples.map((value) => RequiredNextActionSchema.parse(value).type)).toEqual(
      REQUIRED_NEXT_ACTION_TYPES,
    );
  });
});

describe("slot definitions", () => {
  it("maps every slot exhaustively to the correct asset type and persisted label", () => {
    expect(Object.keys(SLOT_DEFINITIONS)).toEqual(CONTENT_SLOTS);
    expect(SLOT_DEFINITIONS).toEqual({
      scene_1_store_image: {
        assetType: "STORE_IMAGE",
        mediaType: "image",
        persistedSceneLabel: "scene_1_store_image",
        sourceSlot: null,
      },
      scene_1_store_video: {
        assetType: "STORE_VIDEO",
        mediaType: "video",
        persistedSceneLabel: "scene_1_store",
        sourceSlot: "scene_1_store_image",
      },
      scene_2_home_image: {
        assetType: "HOME_IMAGE",
        mediaType: "image",
        persistedSceneLabel: "scene_2_home_image",
        sourceSlot: null,
      },
      scene_2_home_video: {
        assetType: "HOME_VIDEO",
        mediaType: "video",
        persistedSceneLabel: "scene_2_home",
        sourceSlot: "scene_2_home_image",
      },
    });
  });
});

describe("contract document parity", () => {
  it("uses every frozen TypeScript value verbatim", () => {
    const contract = readFileSync(
      resolve(process.cwd(), "docs/MANAGED_STYLE1_V1_CONTRACT.md"),
      "utf8",
    );
    const frozenNames = [
      ...CONTENT_SLOTS,
      ...ASSET_TYPES,
      ...CONTENT_RUN_STATES,
      ...OPERATION_KINDS.filter(
        (kind) => kind !== "voiceover_generation" && kind !== "final_assembly",
      ),
      ...OPERATION_STATUSES,
      ...REQUIRED_NEXT_ACTION_TYPES.filter(
        (action) =>
          action !== "GENERATE_VOICEOVER" &&
          action !== "ASSEMBLE_FINAL" &&
          action !== "RUN_FINAL_QA",
      ),
    ];
    for (const name of frozenNames) {
      expect(contract, `contract is missing ${name}`).toContain(`\`${name}\``);
    }
  });
});
