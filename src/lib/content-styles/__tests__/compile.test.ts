import { describe, expect, it } from "vitest";
import {
  CompiledContentStyleSchema,
  compileContentStyle,
} from "../compile";

const style1Kit = {
  productName: "Ninja CREAMi Deluxe",
  market: "UK" as const,
  category: "Kitchen/Food",
  copy: {
    part1Options: [
      "WAIT, this Ninja CREAMi deal has twenty percent off and it is actually worth checking before dinner.",
    ],
    part2Options: [
      "It makes quick desserts feel so easy at home, and the orange basket voucher is sitting there today.",
    ],
    part3Options: ["Twenty percent off — tap the basket"],
  },
  hashtags: ["#tiktokshopuk", "#dealdrops", "#tiktokmademebuyit", "#weekendsale", "#AIGC"],
  productDescription: "Countertop ice cream maker for quick home desserts.",
  discountPercent: 20,
  warnings: [],
};

const validStyle2Voiceover = [
  "Okay",
  "this",
  "is",
  "the",
  "kind",
  "of",
  "little",
  "beauty",
  "find",
  "that",
  "makes",
  "getting",
  "ready",
  "feel",
  "way",
  "easier",
  "because",
  "the",
  "texture",
  "glides",
  "on",
  "softly",
  "feels",
  "comfortable",
  "right",
  "away",
  "and",
  "gives",
  "that",
  "fresh",
  "routine",
  "moment",
  "without",
  "making",
  "big",
  "promises",
  "I",
  "like",
  "how",
  "simple",
  "it",
  "is",
  "to",
  "hold",
  "use",
  "and",
  "show",
  "on",
  "camera",
  "so",
  "if",
  "you",
  "want",
  "an",
  "easy",
  "everyday",
  "upgrade",
  "check",
  "the",
  "basket",
  "voucher",
  "while",
  "it",
  "is",
  "still",
  "sitting",
  "there",
  "for",
  "you",
  "today",
].join(" ");

const style2Copy = {
  market: "UK" as const,
  hook_text: "WAIT, the basket voucher is live",
  benefit_text: "Soft glide, easy routine feel",
  cta_text: "Tap the basket voucher today",
  voiceover: validStyle2Voiceover,
};

function compileStyle2(overrides: Record<string, unknown> = {}) {
  return compileContentStyle({
    styleId: "style2",
    version: "managed-style2-v1",
    variant: "handheld",
    productName: "Glow Serum",
    productType: "skincare_beauty_makeup_haircare",
    productForm: "serum",
    productCount: 1,
    characterReferenceId: "avatar_ref_123",
    productReferenceId: "product_ref_123",
    seed: 101,
    recentSceneHashes: [],
    copy: style2Copy,
    ...overrides,
  });
}

function expectStyle2FrozenContract(
  compiled: ReturnType<typeof compileContentStyle>,
  expected: {
    variant: "handheld" | "large_countertop" | "worn";
    form: "serum" | "large_countertop" | "worn";
    demoArea: "cheek" | "counter_result" | "worn_only";
    references: {
      characterReferenceId: string;
      garmentReferenceId: string | null;
      productReferenceId: string | null;
    };
    steps: readonly (readonly [
      string,
      "nano" | "veo",
      string | null,
      number | null,
      number | null,
      readonly ("avatar" | "garment" | "product")[],
    ])[];
  },
) {
  expect(compiled.styleId).toBe("style2");
  expect(compiled.plan.kind).toBe("style2_mof_avatar");
  const plan = compiled.plan as Extract<typeof compiled.plan, { kind: "style2_mof_avatar" }>;
  expect(plan.variant).toBe(expected.variant);
  expect(plan.scene.seed).toBe(101);
  expect(plan.scene.sceneHash).toMatch(/^[0-9a-f]{12}$/);
  expect(plan.product).toEqual({
    name: "Glow Serum",
    type: expected.variant === "worn" ? "clothing_fashion_shoes" : "skincare_beauty_makeup_haircare",
    form: expected.form,
    count: 1,
    demoArea: expected.demoArea,
  });
  expect(plan.references).toEqual(expected.references);
  expect(plan.steps.map((step) => [
    step.slotId,
    step.engine,
    step.dependsOnSlotId,
    step.providerRequestDurationSeconds,
    step.trimToSeconds,
    step.requiredReferences,
  ])).toEqual(expected.steps);
  expect(compiled.voiceover.wordCount).toBe(70);
  expect(CompiledContentStyleSchema.parse(JSON.parse(JSON.stringify(compiled)))).toEqual(compiled);
}

describe("content style compiler", () => {
  it("wraps canonical Style 1 plan and freezes the selected voiceover choices", () => {
    const compiled = compileContentStyle({
      styleId: "style1",
      version: "managed-style1-v1",
      variant: "store_discovery",
      productReferenceImageId: "product_ref_1",
      style1Kit,
      chosenPart1: "WAIT, this Ninja CREAMi deal has twenty percent off and it is actually worth checking before dinner.",
      chosenPart2: "It makes quick desserts feel so easy at home, and the orange basket voucher is sitting there today.",
      ignoredPrompt: "do not persist me",
      model: "attacker-model",
      status: "READY",
    });

    expect(compiled.styleId).toBe("style1");
    expect(compiled.plan.kind).toBe("style1_store_discovery");
    const plan = compiled.plan as Extract<typeof compiled.plan, { kind: "style1_store_discovery" }>;
    expect(plan.promptSlots.map((slot) => slot.slotId)).toEqual([
      "scene_1_store_image",
      "scene_1_store_video",
      "scene_2_home_image",
      "scene_2_home_video",
    ]);
    expect(compiled.voiceover.script).toBe(
      `${style1Kit.copy.part1Options[0]}\n\n${style1Kit.copy.part2Options[0]}`,
    );
    expect(compiled.voiceover.selection).toEqual({
      part1: { mode: "explicit", optionIndex: 0, text: style1Kit.copy.part1Options[0] },
      part2: { mode: "explicit", optionIndex: 0, text: style1Kit.copy.part2Options[0] },
    });
    expect(JSON.stringify(compiled)).not.toContain("ignoredPrompt");
    expect(JSON.stringify(compiled)).not.toContain("attacker-model");
    expect(JSON.stringify(compiled)).not.toContain("READY");
    expect(CompiledContentStyleSchema.parse(JSON.parse(JSON.stringify(compiled)))).toEqual(compiled);
  });

  it("uses deterministic first-option fallback for unchosen Style 1 voiceover parts", () => {
    const compiled = compileContentStyle({
      styleId: "style1",
      version: "managed-style1-v1",
      variant: "store_discovery",
      productReferenceImageId: "product_ref_1",
      style1Kit,
    });

    expect(compiled.voiceover.selection).toEqual({
      part1: { mode: "fallback_first_option", optionIndex: 0, text: style1Kit.copy.part1Options[0] },
      part2: { mode: "fallback_first_option", optionIndex: 0, text: style1Kit.copy.part2Options[0] },
    });
  });

  it("compiles a frozen Style 2 manifest from the shared deterministic scene, chain, and copy rules", () => {
    const compiled = compileStyle2();

    expectStyle2FrozenContract(compiled, {
      variant: "handheld",
      form: "serum",
      demoArea: "cheek",
      references: {
        characterReferenceId: "avatar_ref_123",
        garmentReferenceId: null,
        productReferenceId: "product_ref_123",
      },
      steps: [
        ["N1", "veo", null, 8, 4, ["avatar"]],
        ["N2", "nano", null, null, null, ["avatar", "product"]],
        ["N3", "veo", "N2", 8, 6, ["avatar"]],
        ["N4", "nano", null, null, null, ["avatar", "product"]],
        ["N5", "veo", "N4", 8, 6, ["avatar"]],
        ["N6", "nano", null, null, null, ["avatar", "product"]],
        ["N7", "veo", "N6", 8, 6, ["avatar"]],
      ],
    });
  });

  it("compiles exact frozen Style 2 topology for large countertop products", () => {
    const compiled = compileStyle2({
      variant: "large_countertop",
      productForm: "large_countertop",
      productReferenceId: "countertop_ref_123",
    });

    expectStyle2FrozenContract(compiled, {
      variant: "large_countertop",
      form: "large_countertop",
      demoArea: "counter_result",
      references: {
        characterReferenceId: "avatar_ref_123",
        garmentReferenceId: null,
        productReferenceId: "countertop_ref_123",
      },
      steps: [
        ["N1", "veo", null, 8, 4, ["avatar"]],
        ["N2", "nano", null, null, null, ["avatar", "product"]],
        ["N3", "veo", "N2", 8, 6, ["avatar"]],
        ["N4", "nano", null, null, null, ["avatar", "product"]],
        ["N5", "veo", "N4", 8, 6, ["avatar"]],
        ["N6", "nano", null, null, null, ["avatar", "product"]],
        ["N7", "veo", "N6", 8, 6, ["avatar"]],
      ],
    });
  });

  it("compiles exact frozen Style 2 topology for worn products", () => {
    const compiled = compileStyle2({
      variant: "worn",
      productForm: "worn",
      productType: "clothing_fashion_shoes",
      garmentReferenceId: "garment_ref_123",
      productReferenceId: null,
    });

    expectStyle2FrozenContract(compiled, {
      variant: "worn",
      form: "worn",
      demoArea: "worn_only",
      references: {
        characterReferenceId: "avatar_ref_123",
        garmentReferenceId: "garment_ref_123",
        productReferenceId: null,
      },
      steps: [
        ["N1", "nano", null, null, null, ["avatar", "garment"]],
        ["N2", "veo", "N1", 8, 6, ["avatar", "garment"]],
        ["N3", "nano", null, null, null, ["avatar", "garment"]],
        ["N4", "veo", "N3", 8, 6, ["avatar", "garment"]],
        ["N5", "nano", null, null, null, ["avatar", "garment"]],
        ["N6", "veo", "N5", 8, 6, ["avatar", "garment"]],
      ],
    });
  });

  it("compiles byte-stable Style 2 output even when callers omit a seed", () => {
    const first = JSON.stringify(compileStyle2({ seed: undefined }));
    const second = JSON.stringify(compileStyle2({ seed: undefined }));

    expect(second).toBe(first);
  });

  it("requires registered Style 2 character refs and manifest-required refs before spend", () => {
    expect(() => compileStyle2({ characterReferenceId: "" })).toThrow(/character reference/i);
    expect(() => compileStyle2({ productReferenceId: null })).toThrow(/product reference/i);
    expect(() => compileStyle2({ productReferenceId: "" })).toThrow(/product reference/i);
    expect(() =>
      compileStyle2({
        variant: "large_countertop",
        productForm: "large_countertop",
        productReferenceId: null,
      }),
    ).toThrow(/product reference/i);
    expect(() => compileStyle2({ variant: "worn", productForm: "worn" })).toThrow(/garment reference/i);
    expect(() =>
      compileStyle2({
        variant: "worn",
        productForm: "worn",
        productType: "clothing_fashion_shoes",
        garmentReferenceId: "garment_ref_1",
      }),
    ).not.toThrow();
  });

  it("fails closed for unsupported styles and invalid Style 2 copy", () => {
    expect(() =>
      compileContentStyle({
        styleId: "style3",
        version: "managed-style3-v1",
        variant: "anything",
      }),
    ).toThrow(/unsupported/i);
    expect(() => compileStyle2({ copy: { ...style2Copy, voiceover: "too short" } })).toThrow(
      /copy validation/i,
    );
  });

  it("rerolls Style 2 scene hashes when a recent hash collides", () => {
    const first = compileStyle2();
    const firstPlan = first.plan as Extract<typeof first.plan, { kind: "style2_mof_avatar" }>;
    const second = compileStyle2({ recentSceneHashes: [firstPlan.scene.sceneHash] });
    const secondPlan = second.plan as Extract<typeof second.plan, { kind: "style2_mof_avatar" }>;

    expect(secondPlan.scene.sceneHash).not.toBe(firstPlan.scene.sceneHash);
    expect(secondPlan.scene.collision).toBe(false);
  });
});
