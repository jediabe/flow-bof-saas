import { z } from "zod";
import {
  ALLOWED_MANAGED_VIDEO_MODELS,
  ASSET_TYPES,
  CONTENT_RUN_STATES,
  CONTENT_SLOTS,
  FINAL_VIDEO_STATUSES,
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
  z.object({ type: z.literal("GENERATE_IMAGE"), slot: IdSchema }).strict(),
  z
    .object({ type: z.literal("RUN_QA"), slot: IdSchema, assetId: IdSchema })
    .strict(),
  z
    .object({
      type: z.literal("GENERATE_VIDEO"),
      slot: IdSchema,
      sourceAssetId: IdSchema.optional(),
    })
    .strict()
    .superRefine((action, context) => {
      if (VIDEO_SLOTS.includes(action.slot as (typeof VIDEO_SLOTS)[number]) && !action.sourceAssetId) {
        context.addIssue({
          code: "custom",
          path: ["sourceAssetId"],
          message: "Style 1 video generation requires an approved source image",
        });
      }
    }),
  z.object({ type: z.literal("GENERATE_VOICEOVER") }).strict(),
  z.object({ type: z.literal("ASSEMBLE_FINAL"), finalVideoId: IdSchema }).strict(),
  z.object({ type: z.literal("RUN_FINAL_QA"), finalVideoId: IdSchema }).strict(),
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

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveSecondsSchema = z.number().finite().positive().max(3600);
const NonnegativeSecondsSchema = z.number().finite().nonnegative().max(3600);

const AssemblyClipSchema = z
  .object({
    order: z.number().int().nonnegative(),
    slotId: IdSchema,
    assetId: IdSchema,
    assetSha256: Sha256Schema,
    approvalStatus: z.literal("APPROVED"),
    trimStartSeconds: NonnegativeSecondsSchema,
    trimEndSeconds: PositiveSecondsSchema,
    durationSeconds: PositiveSecondsSchema,
    nativeAudioMode: z.enum(["duck", "mute", "preserve"]),
  })
  .strict();

export const AssemblyManifestSchema = z
  .object({
    version: z.literal("assembly-manifest-v1"),
    clips: z.array(AssemblyClipSchema).min(1).max(20),
    audio: z
      .object({
        assetId: IdSchema,
        assetSha256: Sha256Schema,
        durationSeconds: PositiveSecondsSchema,
      })
      .strict(),
    output: z
      .object({
        width: z.number().int().min(240).max(4320),
        height: z.number().int().min(240).max(4320),
        fps: z.number().int().min(1).max(120),
        voiceoverGainDb: z.number().finite().min(-60).max(12),
        nativeAudioGainDb: z.number().finite().min(-60).max(12),
        duckingThresholdDb: z.number().finite().min(-60).max(0),
        expectedDurationSeconds: PositiveSecondsSchema,
      })
      .strict(),
    ffmpegVersion: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.+-]+$/),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.clips.some((clip, index) => clip.order !== index)) {
      context.addIssue({ code: "custom", path: ["clips"], message: "clip order must be contiguous" });
    }
    if (new Set(manifest.clips.map((clip) => clip.slotId)).size !== manifest.clips.length) {
      context.addIssue({ code: "custom", path: ["clips"], message: "clip slots must be unique" });
    }
    if (new Set(manifest.clips.map((clip) => clip.assetId)).size !== manifest.clips.length) {
      context.addIssue({ code: "custom", path: ["clips"], message: "clip assets must be unique" });
    }
    for (const [index, clip] of manifest.clips.entries()) {
      if (
        clip.trimEndSeconds <= clip.trimStartSeconds ||
        clip.durationSeconds !== clip.trimEndSeconds - clip.trimStartSeconds
      ) {
        context.addIssue({ code: "custom", path: ["clips", index], message: "invalid trim bounds" });
      }
    }
    const duration = manifest.clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
    if (duration !== manifest.output.expectedDurationSeconds) {
      context.addIssue({
        code: "custom",
        path: ["output", "expectedDurationSeconds"],
        message: "expected duration must equal ordered clip duration",
      });
    }
  });

const PersistedMediaSchema = z
  .object({
    bucket: z.string().trim().min(1).max(200),
    key: z.string().trim().min(1).max(1024),
    contentType: z.string().trim().min(1).max(100),
    bytes: z.number().int().positive(),
    sha256: Sha256Schema,
    durationSeconds: PositiveSecondsSchema,
  })
  .strict();

export const FinalVideoStatusSchema = z.enum(FINAL_VIDEO_STATUSES);
export const FinalVideoAssetSchema = z
  .object({
    id: IdSchema,
    contentRunId: IdSchema,
    attempt: z.number().int().positive(),
    status: FinalVideoStatusSchema,
    voiceover: z
      .object({
        script: z.string().trim().min(1).max(10000),
        provider: z.literal("elevenlabs"),
        voiceId: IdSchema,
        model: IdSchema,
      })
      .strict()
      .nullable()
      .default(null),
    audioAsset: PersistedMediaSchema.extend({ contentType: z.enum(["audio/mpeg", "audio/wav"]) })
      .strict()
      .nullable()
      .default(null),
    assemblyManifest: AssemblyManifestSchema.nullable().default(null),
    finalMp4: PersistedMediaSchema.extend({
      contentType: z.literal("video/mp4"),
      width: z.number().int().min(240).max(4320),
      height: z.number().int().min(240).max(4320),
      videoCodec: z.string().trim().min(1).max(80),
      audioCodec: z.string().trim().min(1).max(80),
    })
      .strict()
      .nullable()
      .default(null),
    mediaValidation: z
      .object({ passed: z.boolean(), validatedAt: z.string().datetime() })
      .strict()
      .nullable()
      .default(null),
    finalQa: z
      .object({
        status: z.enum(["NOT_QA_CHECKED", "QA_RUNNING", "APPROVED", "HUMAN_REVIEW", "FAILED"]),
        score: z.number().int().min(0).max(100).nullable(),
        verdict: z.string().trim().min(1).max(5000).nullable(),
        evaluatedAt: z.string().datetime().nullable(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

export const FinalReadyInvariantSchema = z
  .object({
    requiredSourceAssetsApproved: z.boolean(),
    voiceoverPersisted: z.boolean(),
    finalMp4Persisted: z.boolean(),
    deterministicMediaValidationPassed: z.boolean(),
    finalAudiovisualQaApproved: z.boolean(),
  })
  .strict();

export function isFinalReadyInvariantSatisfied(input: z.input<typeof FinalReadyInvariantSchema>) {
  const invariant = FinalReadyInvariantSchema.parse(input);
  return Object.values(invariant).every((value) => value);
}

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

const ProjectedSlotRecordSchema = z
  .object({
    slot: IdSchema,
    assetType: IdSchema,
    selectedAssetId: IdSchema.optional(),
    attempts: z.array(AssetAttemptSchema),
  })
  .strict();

const ActiveOperationSchema = z
  .object({
    id: IdSchema,
    kind: OperationKindSchema,
    status: z.enum(["requested", "running"]),
    slot: IdSchema,
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
    slots: z.array(ProjectedSlotRecordSchema).min(1).max(20),
    activeOperation: ActiveOperationSchema.optional(),
    requiredNextAction: RequiredNextActionSchema,
    terminalReason: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((projection, context) => {
    const slotIds = projection.slots.map((slot) => slot.slot);
    if (new Set(slotIds).size !== slotIds.length) {
      context.addIssue({
        code: "custom",
        path: ["slots"],
        message: "projected slots must be unique",
      });
    }
    if (projection.specVersion === "managed-style1-v1") {
      const valid =
        projection.slots.length === CONTENT_SLOTS.length &&
        CONTENT_SLOTS.every((slotId, index) => {
          const slot = projection.slots[index];
          return slot?.slot === slotId && slot.assetType === SLOT_DEFINITIONS[slotId].assetType;
        });
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["slots"],
          message: "Style 1 projection must preserve its canonical slot contract",
        });
      }
    }
    if (projection.specVersion === "managed-style2-v1") {
      const expectedIds =
        projection.slots.length === 6
          ? ["N1", "N2", "N3", "N4", "N5", "N6"]
          : ["N1", "N2", "N3", "N4", "N5", "N6", "N7"];
      const valid =
        projection.slots.length === expectedIds.length &&
        expectedIds.every(
          (slotId, index) =>
            projection.slots[index]?.slot === slotId &&
            projection.slots[index]?.assetType === slotId,
        );
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["slots"],
          message: "Style 2 projection must preserve its frozen manifest topology",
        });
      }
    }
  });

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
