import { z } from "zod";
import { createHash } from "node:crypto";
import { buildElevenLabsScript, type Style1Kit } from "@/lib/ai/style1";
import { compileStyle1Plan } from "@/lib/content-runs/style1-plan";
import { buildClipPromptsPure } from "../../../apex-mcp/src/tools/style2/chain";
import { PRODUCT_FORMS, type ProductForm } from "../../../apex-mcp/src/tools/style2/chain";
import { PRODUCT_TYPES, type ProductType } from "../../../apex-mcp/src/tools/style2/menus";
import { rollScenePure } from "../../../apex-mcp/src/tools/style2/scene";
import { validateCopyPure, type Market } from "../../../apex-mcp/src/tools/style2/copy";
import { compileStyleManifest } from "./registry";
import { StyleManifestSchema } from "./schemas";
import type { StyleManifest } from "./types";

const NonemptyStringSchema = z.string().trim().min(1);
const NullableNonemptyStringSchema = NonemptyStringSchema.nullable();
const ReferenceTypeSchema = z.enum(["avatar", "garment", "product"]);

const CompiledVoiceoverSchema = z
  .object({
    scriptCompilerId: z.enum(["style1.elevenlabs-script.v1", "style2.validated-copy-script.v1"]),
    validationProfileId: z.enum(["style1.voiceover.v1", "style2.voiceover-70-75-words.v1"]),
    script: NonemptyStringSchema.max(10_000),
    wordCount: z.number().int().nonnegative().max(2_000),
    selection: z
      .object({
        part1: z
          .object({
            mode: z.enum(["explicit", "fallback_first_option"]),
            optionIndex: z.number().int().nonnegative(),
            text: NonemptyStringSchema,
          })
          .strict()
          .optional(),
        part2: z
          .object({
            mode: z.enum(["explicit", "fallback_first_option"]),
            optionIndex: z.number().int().nonnegative(),
            text: NonemptyStringSchema,
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

const PromptSlotSchema = z
  .object({
    slotId: NonemptyStringSchema,
    mediaType: z.enum(["image", "video"]),
    promptCompilerId: NonemptyStringSchema,
    prompt: NonemptyStringSchema,
    dependsOnSlotId: NullableNonemptyStringSchema,
    requiredReferences: z.array(ReferenceTypeSchema),
    providerRequestDurationSeconds: z.number().positive().nullable(),
    trimToSeconds: z.number().positive().nullable(),
    engine: z.enum(["nano", "veo"]).optional(),
  })
  .strict();

const CompiledStyle1PlanSchema = z
  .object({
    kind: z.literal("style1_store_discovery"),
    product: z
      .object({
        name: NonemptyStringSchema,
        market: z.enum(["UK", "US"]),
        category: NonemptyStringSchema,
        productReferenceImageId: NonemptyStringSchema,
      })
      .strict(),
    promptSlots: z.array(PromptSlotSchema).length(4),
  })
  .strict();

const CompiledStyle2PlanSchema = z
  .object({
    kind: z.literal("style2_mof_avatar"),
    variant: z.enum(["handheld", "large_countertop", "worn"]),
    scene: z
      .object({
        seed: z.number().int(),
        productType: z.enum(PRODUCT_TYPES),
        room: NonemptyStringSchema,
        sceneHash: z.string().regex(/^[0-9a-f]{12}$/),
        collision: z.boolean(),
        rolls: z.record(z.string(), z.string()),
        prompt: NonemptyStringSchema,
        notes: z.array(z.string()),
      })
      .strict(),
    product: z
      .object({
        name: NonemptyStringSchema,
        type: z.enum(PRODUCT_TYPES),
        form: z.enum(PRODUCT_FORMS),
        count: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        demoArea: NonemptyStringSchema,
      })
      .strict(),
    references: z
      .object({
        characterReferenceId: NonemptyStringSchema,
        garmentReferenceId: NullableNonemptyStringSchema,
        productReferenceId: NullableNonemptyStringSchema,
      })
      .strict(),
    copy: z
      .object({
        market: z.enum(["UK", "US"]),
        hookText: NonemptyStringSchema,
        benefitText: NonemptyStringSchema,
        ctaText: NonemptyStringSchema,
        validationPassed: z.literal(true),
      })
      .strict(),
    steps: z.array(PromptSlotSchema).min(6).max(7),
    notes: z.array(z.string()),
  })
  .strict();

export const CompiledContentStyleSchema = z
  .object({
    styleId: z.enum(["style1", "style2"]),
    version: z.enum(["managed-style1-v1", "managed-style2-v1"]),
    variant: z.enum(["store_discovery", "handheld", "large_countertop", "worn"]),
    manifest: StyleManifestSchema,
    plan: z.union([CompiledStyle1PlanSchema, CompiledStyle2PlanSchema]),
    voiceover: CompiledVoiceoverSchema,
  })
  .strict();

export type CompiledContentStyle = z.infer<typeof CompiledContentStyleSchema>;

type Style1CompileInput = {
  styleId: "style1";
  version: "managed-style1-v1";
  variant: "store_discovery";
  productReferenceImageId: string;
  style1Kit: Style1Kit;
  chosenPart1?: string | null;
  chosenPart2?: string | null;
};

type Style2CopyInput = {
  market: Market;
  hook_text: string;
  benefit_text: string;
  cta_text: string;
  voiceover: string;
  scarcity_is_true?: boolean;
};

type Style2CompileInput = {
  styleId: "style2";
  version: "managed-style2-v1";
  variant: "handheld" | "large_countertop" | "worn";
  productName: string;
  productType: ProductType;
  productForm: ProductForm;
  productCount: 1 | 2 | 3;
  characterReferenceId: string;
  garmentReferenceId?: string | null;
  productReferenceId?: string | null;
  seed?: number;
  recentSceneHashes?: readonly string[];
  copy: Style2CopyInput;
};

export type CompileContentStyleInput = Style1CompileInput | Style2CompileInput;

export function compileContentStyle(input: CompileContentStyleInput | Record<string, unknown>): CompiledContentStyle {
  if (input.styleId === "style1") return compileStyle1Content(input as Style1CompileInput);
  if (input.styleId === "style2") return compileStyle2Content(input as Style2CompileInput);
  throw new Error(`Unsupported managed content style: ${String(input.styleId ?? "unknown")}`);
}

function compileStyle1Content(input: Style1CompileInput): CompiledContentStyle {
  const manifest = compileStyleManifest("style1", input.version, input.variant);
  const kit = input.style1Kit;
  const style1Plan = compileStyle1Plan({
    productName: kit.productName,
    market: kit.market,
    category: kit.category,
    productReferenceImageId: input.productReferenceImageId,
  });
  const part1 = selectStyle1Part(kit.copy.part1Options, input.chosenPart1 ?? null, "part1");
  const part2 = selectStyle1Part(kit.copy.part2Options, input.chosenPart2 ?? null, "part2");
  const script = buildElevenLabsScript(kit, part1.text, part2.text);
  if (!script.trim()) throw new Error("Style 1 voiceover script is empty");

  return parseCompiled({
    styleId: "style1",
    version: "managed-style1-v1",
    variant: "store_discovery",
    manifest,
    plan: {
      kind: "style1_store_discovery",
      product: {
        name: style1Plan.context.productName,
        market: style1Plan.context.market,
        category: style1Plan.context.category,
        productReferenceImageId: style1Plan.context.productReferenceImageId,
      },
      promptSlots: style1Plan.slots.map((slot) => ({
        slotId: slot.slot,
        mediaType: slot.mediaType,
        promptCompilerId: manifest.slots.find((manifestSlot) => manifestSlot.id === slot.slot)?.promptCompilerId,
        prompt: slot.prompt,
        dependsOnSlotId: slot.dependencies[0] ?? null,
        requiredReferences: slot.mediaType === "image" ? ["product"] : [],
        providerRequestDurationSeconds: slot.mediaType === "video" ? slot.generation.durationSeconds : null,
        trimToSeconds: slot.mediaType === "video" ? slot.generation.durationSeconds : null,
      })),
    },
    voiceover: {
      scriptCompilerId: manifest.voiceover.scriptCompilerId,
      validationProfileId: manifest.voiceover.validationProfileId,
      script,
      wordCount: countWords(script),
      selection: { part1, part2 },
    },
  });
}

function selectStyle1Part(
  options: readonly string[],
  chosen: string | null,
  partName: "part1" | "part2",
): { mode: "explicit" | "fallback_first_option"; optionIndex: number; text: string } {
  const normalizedOptions = options.map((option) => option.trim()).filter(Boolean);
  if (normalizedOptions.length === 0) throw new Error(`Style 1 ${partName} has no voiceover options`);
  if (!chosen?.trim()) {
    return { mode: "fallback_first_option", optionIndex: 0, text: normalizedOptions[0] };
  }
  const normalizedChosen = chosen.trim();
  const optionIndex = normalizedOptions.indexOf(normalizedChosen);
  if (optionIndex === -1) {
    throw new Error(`Style 1 ${partName} choice is not one of the frozen kit options`);
  }
  return { mode: "explicit", optionIndex, text: normalizedChosen };
}

function compileStyle2Content(input: Style2CompileInput): CompiledContentStyle {
  const manifest = compileStyleManifest("style2", input.version, input.variant);
  const productName = requireTrimmed(input.productName, "Style 2 product name is required");
  const characterReferenceId = requireTrimmed(
    input.characterReferenceId,
    "Style 2 requires a registered character reference before provider spend",
  );
  const garmentReferenceId = trimOptional(input.garmentReferenceId ?? null);
  const productReferenceId = trimOptional(input.productReferenceId ?? null);
  requireStyle2ManifestReferences(manifest, { garmentReferenceId, productReferenceId });
  if (input.variant !== "worn" && input.productForm === "worn") {
    throw new Error("Style 2 productForm=worn must use the worn variant");
  }
  if (input.variant === "large_countertop" && input.productForm !== "large_countertop") {
    throw new Error("Style 2 large_countertop variant requires productForm=large_countertop");
  }
  if (input.variant === "handheld" && (input.productForm === "large_countertop" || input.productForm === "worn")) {
    throw new Error("Style 2 handheld variant requires a handheld product form");
  }
  const copy = sanitizeStyle2Copy(input.copy);

  const scene = rollScenePure({
    product_type: input.productType,
    seed: input.seed ?? deterministicStyle2Seed(input, copy),
    recent_scene_hashes: input.recentSceneHashes ?? [],
  });
  const chain = buildClipPromptsPure({
    scene_prompt: scene.scene_prompt,
    product_name: productName,
    product_form: input.productForm,
    product_count: input.productCount,
    duration_strategy: "generate_8_and_trim",
  });
  if (chain.chain_kind !== chainKindForVariant(input.variant)) {
    throw new Error(`Style 2 ${input.variant} inputs compiled to ${chain.chain_kind} chain`);
  }
  const copyValidation = validateCopyPure(copy);
  if (!copyValidation.passed) {
    const summary = copyValidation.violations.map((violation) => violation.rule).join(", ");
    throw new Error(`Style 2 copy validation failed: ${summary}`);
  }
  const stepsById = new Map(chain.steps.map((step) => [step.id, step]));

  return parseCompiled({
    styleId: "style2",
    version: "managed-style2-v1",
    variant: input.variant,
    manifest,
    plan: {
      kind: "style2_mof_avatar",
      variant: input.variant,
      scene: {
        seed: scene.seed,
        productType: scene.product_type,
        room: scene.room,
        sceneHash: scene.scene_hash,
        collision: scene.collision,
        rolls: scene.rolls,
        prompt: scene.scene_prompt,
        notes: scene.notes,
      },
      product: {
        name: productName,
        type: input.productType,
        form: input.productForm,
        count: input.productCount,
        demoArea: chain.demo_area,
      },
      references: {
        characterReferenceId,
        garmentReferenceId,
        productReferenceId,
      },
      copy: {
        market: copy.market,
        hookText: copy.hook_text.trim(),
        benefitText: copy.benefit_text.trim(),
        ctaText: copy.cta_text.trim(),
        validationPassed: true,
      },
      steps: manifest.slots.map((slot) => {
        const step = stepsById.get(slot.id);
        if (!step) throw new Error(`Style 2 chain is missing manifest slot ${slot.id}`);
        return {
          slotId: slot.id,
          mediaType: slot.mediaType,
          promptCompilerId: slot.promptCompilerId,
          prompt: step.prompt,
          dependsOnSlotId: step.continues_from,
          requiredReferences: slot.attachmentPolicy.requiredReferences,
          providerRequestDurationSeconds: step.engine === "veo" ? step.request_duration_seconds : null,
          trimToSeconds: step.trim_to_seconds,
          engine: step.engine,
        };
      }),
      notes: chain.notes,
    },
    voiceover: {
      scriptCompilerId: manifest.voiceover.scriptCompilerId,
      validationProfileId: manifest.voiceover.validationProfileId,
      script: copy.voiceover.trim(),
      wordCount: copyValidation.voiceover_word_count,
      selection: {},
    },
  });
}

function chainKindForVariant(variant: "handheld" | "large_countertop" | "worn") {
  if (variant === "large_countertop") return "countertop";
  return variant;
}

function requireStyle2ManifestReferences(
  manifest: StyleManifest,
  references: { garmentReferenceId: string | null; productReferenceId: string | null },
): void {
  const requiredReferences = new Set(
    manifest.slots.flatMap((slot) => slot.attachmentPolicy.requiredReferences),
  );
  if (requiredReferences.has("garment") && !references.garmentReferenceId) {
    throw new Error("Style 2 worn requires a garment reference before provider spend");
  }
  if (requiredReferences.has("product") && !references.productReferenceId) {
    throw new Error("Style 2 requires a product reference before provider spend");
  }
}

function sanitizeStyle2Copy(copy: Style2CopyInput): Style2CopyInput {
  return {
    market: copy.market,
    hook_text: copy.hook_text,
    benefit_text: copy.benefit_text,
    cta_text: copy.cta_text,
    voiceover: copy.voiceover,
    scarcity_is_true: copy.scarcity_is_true === true,
  };
}

function deterministicStyle2Seed(input: Style2CompileInput, copy: Style2CopyInput): number {
  const seedMaterial = stableJson({
    styleId: input.styleId,
    version: input.version,
    variant: input.variant,
    productName: input.productName,
    productType: input.productType,
    productForm: input.productForm,
    productCount: input.productCount,
    characterReferenceId: input.characterReferenceId,
    garmentReferenceId: input.garmentReferenceId ?? null,
    productReferenceId: input.productReferenceId ?? null,
    copy,
  });
  return createHash("sha256").update(seedMaterial).digest().readUInt32BE(0);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireTrimmed(value: string, message: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(message);
  return trimmed;
}

function trimOptional(value: string | null): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function countWords(text: string): number {
  return text
    .replace(/…/g, " ")
    .replace(/\.\.\./g, " ")
    .replace(/[\p{Extended_Pictographic}]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function parseCompiled(value: unknown): CompiledContentStyle {
  const parsed = CompiledContentStyleSchema.parse(value);
  assertManifestMatchesPlan(parsed.manifest, parsed.plan);
  return deepFreeze(parsed);
}

function assertManifestMatchesPlan(
  manifest: StyleManifest,
  plan: z.infer<typeof CompiledStyle1PlanSchema> | z.infer<typeof CompiledStyle2PlanSchema>,
): void {
  const promptSlots = plan.kind === "style1_store_discovery" ? plan.promptSlots : plan.steps;
  const slotsById = new Map(manifest.slots.map((slot) => [slot.id, slot]));
  for (const promptSlot of promptSlots) {
    const manifestSlot = slotsById.get(promptSlot.slotId);
    if (!manifestSlot || manifestSlot.promptCompilerId !== promptSlot.promptCompilerId) {
      throw new Error(`Compiled prompt slot ${promptSlot.slotId} does not match the frozen manifest`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
