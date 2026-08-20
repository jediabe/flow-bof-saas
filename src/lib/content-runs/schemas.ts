import { z } from "zod";
import {
  ALLOWED_MANAGED_VIDEO_MODELS,
  ASSET_TYPES,
  CONTENT_RUN_STATES,
  CONTENT_SLOTS,
  IMAGE_SLOTS,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  PERSISTED_SCENE_LABELS,
  QA_DECISIONS,
  QA_STATUSES,
  REQUIRED_NEXT_ACTION_TYPES,
  SLOT_DEFINITIONS,
  VIDEO_SLOTS,
} from "./constants";

const IdSchema = z.string().trim().min(1).max(200);
const IdempotencyKeySchema = z.string().trim().min(1).max(200);

export const ContentSlotSchema = z.enum(CONTENT_SLOTS);
export const ImageSlotSchema = z.enum(IMAGE_SLOTS);
export const VideoSlotSchema = z.enum(VIDEO_SLOTS);
export const AssetTypeSchema = z.enum(ASSET_TYPES);
export const PersistedSceneLabelSchema = z.enum(PERSISTED_SCENE_LABELS);
export const ContentRunStateSchema = z.enum(CONTENT_RUN_STATES);
export const RequiredNextActionTypeSchema = z.enum(REQUIRED_NEXT_ACTION_TYPES);
export const OperationKindSchema = z.enum(OPERATION_KINDS);
export const OperationStatusSchema = z.enum(OPERATION_STATUSES);
export const QaStatusSchema = z.enum(QA_STATUSES);
export const QaDecisionSchema = z.enum(QA_DECISIONS);

export const RequiredNextActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("GENERATE_IMAGE"), slot: ImageSlotSchema }).strict(),
  z
    .object({ type: z.literal("RUN_QA"), slot: ContentSlotSchema, assetId: IdSchema })
    .strict(),
  z
    .object({
      type: z.literal("GENERATE_VIDEO"),
      slot: VideoSlotSchema,
      sourceAssetId: IdSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("WAIT_FOR_OPERATION"), operationId: IdSchema })
    .strict(),
  z
    .object({ type: z.literal("HUMAN_REVIEW"), reason: z.string().trim().min(1) })
    .strict(),
  z.object({ type: z.literal("COMPLETE") }).strict(),
  z.object({ type: z.literal("FAILED"), reason: z.string().trim().min(1) }).strict(),
]);

export const ContentGetProductInputSchema = z.object({ productId: IdSchema }).strict();
export const ContentCreateStyle1RunInputSchema = z
  .object({
    productId: IdSchema,
    objective: z.string().trim().min(1).max(1000),
    idempotencyKey: IdempotencyKeySchema,
    videoModel: z.enum(ALLOWED_MANAGED_VIDEO_MODELS).optional(),
  })
  .strict();
export const ContentGenerateStyle1ImageInputSchema = z
  .object({
    contentRunId: IdSchema,
    slot: ImageSlotSchema,
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict();
export const CreativeDirectionSchema = z
  .object({
    cameraMovement: z.enum([
      "locked_off",
      "minimal_push_in",
      "gentle_push_in",
      "subtle_lateral_drift",
    ]),
    pacing: z.enum(["steady", "unhurried", "natural"]),
    framing: z.enum(["stable_wide", "stable_medium", "stable_close"]),
    distance: z.enum(["hold_distance", "slight_approach", "slight_retreat"]),
    interactionStyle: z.enum([
      "single_gentle_tap",
      "single_gentle_touch",
      "minimal_hand_interaction",
    ]),
    movementIntensity: z.enum(["minimal", "low", "moderate"]),
    preservationFocus: z
      .array(
        z.enum([
          "label_layout",
          "lettering_placement",
          "nozzle_geometry",
          "packaging_proportions",
          "reflections",
          "fine_product_features",
        ]),
      )
      .min(1)
      .max(6)
      .refine((values) => new Set(values).size === values.length, {
        message: "preservationFocus values must be unique",
      }),
  })
  .strict();
export const ContentGenerateStyle1VideoInputSchema = z
  .object({
    contentRunId: IdSchema,
    slot: VideoSlotSchema,
    idempotencyKey: IdempotencyKeySchema,
    creativeDirection: CreativeDirectionSchema.optional(),
  })
  .strict();
export const ContentRunAssetQaInputSchema = z
  .object({ contentRunId: IdSchema, slot: ContentSlotSchema })
  .strict();
export const ContentGetRunInputSchema = z.object({ contentRunId: IdSchema }).strict();

const ProductResultSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    reviewStatus: z.literal("approved"),
    market: z.string().trim().min(1),
    category: z.string().trim().min(1),
    referenceImageIds: z.array(IdSchema).min(1),
  })
  .strict();

const QaSummarySchema = z
  .object({
    decision: QaDecisionSchema,
    score: z.number().int().min(0).max(100),
    summary: z.string().optional(),
  })
  .strict();

const AssetAttemptSchema = z
  .object({
    assetId: IdSchema,
    attempt: z.number().int().positive(),
    qaStatus: QaStatusSchema,
    selected: z.boolean(),
    previewUrl: z.string().url().optional(),
    latestQa: QaSummarySchema.optional(),
  })
  .strict();

const createSlotRecordSchema = <
  TSlot extends (typeof CONTENT_SLOTS)[number],
  TAssetType extends (typeof ASSET_TYPES)[number],
>(
  slot: TSlot,
  assetType: TAssetType,
) =>
  z
    .object({
      slot: z.literal(slot),
      assetType: z.literal(assetType),
      selectedAssetId: IdSchema.optional(),
      attempts: z.array(AssetAttemptSchema),
    })
    .strict();

const CanonicalSlotRecordsSchema = z.tuple([
  createSlotRecordSchema(
    "scene_1_store_image",
    SLOT_DEFINITIONS.scene_1_store_image.assetType,
  ),
  createSlotRecordSchema(
    "scene_1_store_video",
    SLOT_DEFINITIONS.scene_1_store_video.assetType,
  ),
  createSlotRecordSchema(
    "scene_2_home_image",
    SLOT_DEFINITIONS.scene_2_home_image.assetType,
  ),
  createSlotRecordSchema(
    "scene_2_home_video",
    SLOT_DEFINITIONS.scene_2_home_video.assetType,
  ),
]);

const ActiveOperationSchema = z
  .object({
    id: IdSchema,
    kind: OperationKindSchema,
    status: z.enum(["requested", "running"]),
    slot: ContentSlotSchema,
    providerJobId: IdSchema.optional(),
  })
  .strict();

export const ContentRunProjectionSchema = z
  .object({
    id: IdSchema,
    productId: IdSchema,
    objective: z.string().trim().min(1),
    status: ContentRunStateSchema,
    specVersion: z.string().trim().min(1),
    modelSnapshot: z
      .object({ imageModel: z.string().min(1), videoModel: z.string().min(1) })
      .strict(),
    slots: CanonicalSlotRecordsSchema,
    activeOperation: ActiveOperationSchema.optional(),
    requiredNextAction: RequiredNextActionSchema,
    terminalReason: z.string().trim().min(1).optional(),
  })
  .strict();

const OperationCommandResultSchema = z
  .object({
    operationId: IdSchema,
    operationStatus: OperationStatusSchema,
    run: ContentRunProjectionSchema,
  })
  .strict();

const QaCommandResultSchema = z
  .object({
    assetId: IdSchema,
    qaStatus: QaStatusSchema,
    run: ContentRunProjectionSchema,
  })
  .strict();

export const TOOL_INPUT_SCHEMAS = {
  content_get_product: ContentGetProductInputSchema,
  content_create_style1_run: ContentCreateStyle1RunInputSchema,
  content_generate_style1_image: ContentGenerateStyle1ImageInputSchema,
  content_generate_style1_video: ContentGenerateStyle1VideoInputSchema,
  content_run_asset_qa: ContentRunAssetQaInputSchema,
  content_get_run: ContentGetRunInputSchema,
} as const;

export const TOOL_RESULT_SCHEMAS = {
  content_get_product: ProductResultSchema,
  content_create_style1_run: ContentRunProjectionSchema,
  content_generate_style1_image: OperationCommandResultSchema,
  content_generate_style1_video: OperationCommandResultSchema,
  content_run_asset_qa: QaCommandResultSchema,
  content_get_run: ContentRunProjectionSchema,
} as const;

export type ContentGetProductInput = z.infer<typeof ContentGetProductInputSchema>;
export type ContentCreateStyle1RunInput = z.infer<typeof ContentCreateStyle1RunInputSchema>;
export type ContentGenerateStyle1ImageInput = z.infer<
  typeof ContentGenerateStyle1ImageInputSchema
>;
export type ContentGenerateStyle1VideoInput = z.infer<
  typeof ContentGenerateStyle1VideoInputSchema
>;
export type ContentRunAssetQaInput = z.infer<typeof ContentRunAssetQaInputSchema>;
export type ContentGetRunInput = z.infer<typeof ContentGetRunInputSchema>;
export type ContentRunProjectionResult = z.infer<typeof ContentRunProjectionSchema>;
