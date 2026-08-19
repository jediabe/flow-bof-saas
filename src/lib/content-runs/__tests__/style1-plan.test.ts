import { describe, expect, it } from "vitest";
import {
  compileStyle1Plan,
  Style1PlanValidationError,
  type Style1PlanInput,
} from "../style1-plan";

const ukKitchenInput: Style1PlanInput = {
  productName: "Ninja CREAMi Deluxe",
  market: "UK",
  category: "Kitchen/Food",
  productReferenceImageId: "product-image-uk-1",
};

describe("compileStyle1Plan", () => {
  it("compiles the four canonical UK kitchen prompts", () => {
    const plan = compileStyle1Plan(ukKitchenInput);

    expect(plan.specVersion).toBe("managed-style1-v1");
    expect(plan.context).toEqual({
      productName: "Ninja CREAMi Deluxe",
      market: "UK",
      category: "kitchen_food",
      productReferenceImageId: "product-image-uk-1",
      homeSetting: "kitchen",
      homeSurface: "countertop",
    });
    expect(plan.prompts.scene_1_store_image).toContain(
      "inside of a UK retail store, no price tags.",
    );
    expect(plan.prompts.scene_1_store_video).toBe(
      "Continuing from this exact image. Bring the camera closer to the referenced product and have a hand poke it as if the person recording touched it. The referenced product keeps its exact color, shape, logo placement, and proportions from the start frame throughout — no alteration to its design.",
    );
    expect(plan.prompts.scene_2_home_image).toContain(
      "sitting on a clean, tidy countertop in a normal everyday kitchen.",
    );
    expect(plan.prompts.scene_2_home_video).toBe(
      "Continuing from this exact image. Bring the camera slowly closer to the referenced product naturally as if someone is filming it on their phone at home, and have a hand come in and poke it as if the person recording reached out and touched it, no transitions, product stays the clear focus and fully visible in frame throughout, no warping of the referenced product or its label, no alteration to its color, shape, or logo placement from the start frame.",
    );
  });

  it("returns canonical slots, dependencies, and attachment metadata", () => {
    const plan = compileStyle1Plan(ukKitchenInput);

    expect(plan.slots).toEqual([
      {
        slot: "scene_1_store_image",
        assetType: "STORE_IMAGE",
        mediaType: "image",
        prompt: plan.prompts.scene_1_store_image,
        dependencies: [],
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: ["product-image-uk-1"],
          startImageSlot: null,
        },
      },
      {
        slot: "scene_1_store_video",
        assetType: "STORE_VIDEO",
        mediaType: "video",
        prompt: plan.prompts.scene_1_store_video,
        dependencies: ["scene_1_store_image"],
        generation: {
          aspectRatio: "portrait",
          durationSeconds: 8,
          productReferenceImageIds: [],
          startImageSlot: "scene_1_store_image",
        },
      },
      {
        slot: "scene_2_home_image",
        assetType: "HOME_IMAGE",
        mediaType: "image",
        prompt: plan.prompts.scene_2_home_image,
        dependencies: [],
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: ["product-image-uk-1"],
          startImageSlot: null,
        },
      },
      {
        slot: "scene_2_home_video",
        assetType: "HOME_VIDEO",
        mediaType: "video",
        prompt: plan.prompts.scene_2_home_video,
        dependencies: ["scene_2_home_image"],
        generation: {
          aspectRatio: "portrait",
          durationSeconds: 8,
          productReferenceImageIds: [],
          startImageSlot: "scene_2_home_image",
        },
      },
    ]);
  });

  it("returns byte-stable output for the same frozen input", () => {
    const first = JSON.stringify(compileStyle1Plan(ukKitchenInput));
    const second = JSON.stringify(compileStyle1Plan({ ...ukKitchenInput }));

    expect(second).toBe(first);
  });

  it.each([
    [{ ...ukKitchenInput, productName: "" }, "productName"],
    [{ ...ukKitchenInput, category: "" }, "category"],
    [{ ...ukKitchenInput, category: "other" }, "category"],
    [{ ...ukKitchenInput, productReferenceImageId: "" }, "productReferenceImageId"],
    [{ ...ukKitchenInput, market: undefined }, "market"],
  ])("returns a typed validation failure for invalid context at %s", (input, path) => {
    try {
      compileStyle1Plan(input as Style1PlanInput);
      throw new Error("expected compileStyle1Plan to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Style1PlanValidationError);
      expect(error).toMatchObject({ code: "STYLE1_PLAN_VALIDATION_FAILED" });
      expect((error as Style1PlanValidationError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
    }
  });

  it.each([
    ["skincare", "beauty_skincare", "bathroom", "countertop"],
    ["beauty", "beauty_skincare", "bathroom", "countertop"],
    ["kitchen", "kitchen_food", "kitchen", "countertop"],
    ["food", "kitchen_food", "kitchen", "countertop"],
    ["home", "home_storage", "living room", "side table"],
    ["storage", "home_storage", "living room", "side table"],
    ["outdoor", "tools_outdoor", "garage", "workbench"],
    ["tools", "tools_outdoor", "garage", "workbench"],
    ["garden", "tools_outdoor", "garage", "workbench"],
    ["tech", "tech", "home office", "desk"],
    ["pet", "pets", "living room", "floor"],
  ])(
    "accepts the SOP niche %s and canonicalizes it",
    (category, canonicalCategory, homeSetting, homeSurface) => {
      const plan = compileStyle1Plan({
        ...ukKitchenInput,
        category,
      });

      expect(plan.context).toMatchObject({
        category: canonicalCategory,
        homeSetting,
        homeSurface,
      });
    },
  );

  it.each([
    ["Beauty/Skincare", "beauty_skincare", "bathroom", "countertop"],
    ["Home / Storage", "home_storage", "living room", "side table"],
    ["Tools/Outdoor", "tools_outdoor", "garage", "workbench"],
    ["Tech", "tech", "home office", "desk"],
    ["Pets", "pets", "living room", "floor"],
  ])(
    "resolves %s to a deterministic scene 2 setting and surface",
    (category, canonicalCategory, homeSetting, homeSurface) => {
      const plan = compileStyle1Plan({
        productName: "Fixture Product",
        market: "US",
        category,
        productReferenceImageId: "product-image-us-1",
      });

      expect(plan.context.category).toBe(canonicalCategory);
      expect(plan.context.homeSetting).toBe(homeSetting);
      expect(plan.context.homeSurface).toBe(homeSurface);
      expect(plan.prompts.scene_1_store_image).toContain(
        "inside of a US retail store, no price tags.",
      );
      expect(plan.prompts.scene_2_home_image).toContain(
        `sitting on a clean, tidy ${homeSurface} in a normal everyday ${homeSetting}.`,
      );
    },
  );
});
