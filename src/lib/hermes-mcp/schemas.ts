import { z } from "zod";
import { PRODUCT_FORMS } from "../../../apex-mcp/src/tools/style2/chain";
import { PRODUCT_TYPES } from "../../../apex-mcp/src/tools/style2/menus";
import { ALLOWED_MANAGED_VIDEO_MODELS } from "@/lib/content-runs/constants";
import { CreativeDirectionSchema } from "@/lib/content-runs/schemas";

const IdentifierSchema = z.string().trim().min(1).max(200);
const IdempotencyKeySchema = z.string().trim().min(1).max(200);
const BoundedTextSchema = z.string().trim().min(1).max(2_000);
const BoundedTextListSchema = z.array(BoundedTextSchema).max(20);

const Style1KitSchema = z.object({
  productName: BoundedTextSchema,
  market: z.enum(["UK", "US"]),
  category: BoundedTextSchema,
  copy: z.object({
    part1Options: BoundedTextListSchema.min(1),
    part2Options: BoundedTextListSchema.min(1),
    part3Options: BoundedTextListSchema.min(1),
  }).strict(),
  hashtags: BoundedTextListSchema,
  productDescription: BoundedTextSchema,
  discountPercent: z.number().finite().min(0).max(100).nullable(),
  warnings: BoundedTextListSchema,
}).strict();

export const Style1CompilerInputSchema = z.object({
  styleId: z.literal("style1"),
  version: z.literal("managed-style1-v1"),
  variant: z.literal("store_discovery"),
  productReferenceImageId: IdentifierSchema,
  style1Kit: Style1KitSchema,
  chosenPart1: BoundedTextSchema.nullable().optional(),
  chosenPart2: BoundedTextSchema.nullable().optional(),
}).strict();

const Style2CopySchema = z.object({
  market: z.enum(["UK", "US"]),
  hook_text: BoundedTextSchema,
  benefit_text: BoundedTextSchema,
  cta_text: BoundedTextSchema,
  voiceover: BoundedTextSchema.max(10_000),
  scarcity_is_true: z.boolean().optional(),
}).strict();

export const Style2CompilerInputSchema = z.object({
  styleId: z.literal("style2"),
  version: z.literal("managed-style2-v1"),
  variant: z.enum(["handheld", "large_countertop", "worn"]),
  productName: BoundedTextSchema,
  productType: z.enum(PRODUCT_TYPES),
  productForm: z.enum(PRODUCT_FORMS),
  productCount: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  characterReferenceId: IdentifierSchema,
  garmentReferenceId: IdentifierSchema.nullable().optional(),
  productReferenceId: IdentifierSchema.nullable().optional(),
  seed: z.number().int().safe().optional(),
  recentSceneHashes: z.array(z.string().regex(/^[0-9a-f]{12}$/)).max(100).optional(),
  copy: Style2CopySchema,
}).strict();

export const ContentCreateRunInputSchema = z.object({
  productId: IdentifierSchema,
  style: z.enum(["style1", "style2"]),
  idempotencyKey: IdempotencyKeySchema,
  videoModel: z.enum(ALLOWED_MANAGED_VIDEO_MODELS).optional(),
  compilerInput: z.union([Style1CompilerInputSchema, Style2CompilerInputSchema]),
}).strict().superRefine((input, context) => {
  if (input.style !== input.compilerInput.styleId) {
    context.addIssue({
      code: "custom",
      path: ["compilerInput", "styleId"],
      message: "style must match compilerInput.styleId",
    });
  }
});

export const HERMES_CONTENT_TOOL_SCHEMAS = {
  content_get_product: z.object({ productId: IdentifierSchema }).strict(),
  content_create_run: ContentCreateRunInputSchema,
  content_generate_image: z.object({
    contentRunId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
  }).strict(),
  content_generate_video: z.object({
    contentRunId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
    creativeDirection: CreativeDirectionSchema.optional(),
  }).strict(),
  content_run_qa: z.object({ contentRunId: IdentifierSchema }).strict(),
  content_run_final_output: z.object({
    contentRunId: IdentifierSchema,
    idempotencyKey: IdempotencyKeySchema,
  }).strict(),
  content_get_run: z.object({ contentRunId: IdentifierSchema }).strict(),
} as const;

export const HERMES_CONTENT_TOOL_NAMES = Object.freeze(
  Object.keys(HERMES_CONTENT_TOOL_SCHEMAS),
) as Array<keyof typeof HERMES_CONTENT_TOOL_SCHEMAS>;

export type HermesContentToolName = (typeof HERMES_CONTENT_TOOL_NAMES)[number];
export type ContentCreateRunInput = z.infer<typeof ContentCreateRunInputSchema>;
