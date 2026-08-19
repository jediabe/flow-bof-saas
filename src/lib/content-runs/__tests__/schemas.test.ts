import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
    videoModel: "attacker-video-model",
    qaDecision: "APPROVE",
    qaScore: 100,
    status: "ready",
  } as const;

  for (const [toolName, input] of Object.entries(validInputs)) {
    it(`${toolName} rejects workspace, model, QA-decision, and state injection`, () => {
      const schema = TOOL_INPUT_SCHEMAS[toolName as keyof typeof TOOL_INPUT_SCHEMAS];
      for (const [field, value] of Object.entries(forbiddenInjections)) {
        expect(
          schema.safeParse({ ...input, [field]: value }).success,
          `${toolName} unexpectedly accepted ${field}`,
        ).toBe(false);
      }
    });
  }

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
      ...OPERATION_KINDS,
      ...OPERATION_STATUSES,
      ...REQUIRED_NEXT_ACTION_TYPES,
    ];
    for (const name of frozenNames) {
      expect(contract, `contract is missing ${name}`).toContain(`\`${name}\``);
    }
  });
});
