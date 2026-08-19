import { MANAGED_STYLE1_SPEC_VERSION } from "./constants";
import type { AssetType, ContentSlot, ImageSlot } from "./types";

export type Style1Market = "UK" | "US";

export interface Style1PlanInput {
  productName: string;
  market: Style1Market;
  category: string;
  productReferenceImageId: string;
}

export interface Style1PlanValidationIssue {
  path: keyof Style1PlanInput;
  message: string;
}

export class Style1PlanValidationError extends Error {
  readonly code = "STYLE1_PLAN_VALIDATION_FAILED" as const;

  constructor(readonly issues: Style1PlanValidationIssue[]) {
    super("Style 1 plan input failed validation");
    this.name = "Style1PlanValidationError";
  }
}

export interface Style1PlanPrompts {
  scene_1_store_image: string;
  scene_1_store_video: string;
  scene_2_home_image: string;
  scene_2_home_video: string;
}

interface Style1BaseSlotPlan {
  slot: ContentSlot;
  assetType: AssetType;
  prompt: string;
  dependencies: ContentSlot[];
}

export interface Style1ImageSlotPlan extends Style1BaseSlotPlan {
  mediaType: "image";
  generation: {
    aspectRatio: "9:16";
    productReferenceImageIds: [string];
    startImageSlot: null;
  };
}

export interface Style1VideoSlotPlan extends Style1BaseSlotPlan {
  mediaType: "video";
  dependencies: [ImageSlot];
  generation: {
    aspectRatio: "portrait";
    durationSeconds: 8;
    productReferenceImageIds: [];
    startImageSlot: ImageSlot;
  };
}

export interface Style1Plan {
  specVersion: typeof MANAGED_STYLE1_SPEC_VERSION;
  context: {
    productName: string;
    market: Style1Market;
    category: string;
    productReferenceImageId: string;
    homeSetting: string;
    homeSurface: string;
  };
  prompts: Style1PlanPrompts;
  slots: [
    Style1ImageSlotPlan,
    Style1VideoSlotPlan,
    Style1ImageSlotPlan,
    Style1VideoSlotPlan,
  ];
}

const STORE_VIDEO_PROMPT =
  "Continuing from this exact image. Bring the camera closer to the referenced product and have a hand poke it as if the person recording touched it. The referenced product keeps its exact color, shape, logo placement, and proportions from the start frame throughout — no alteration to its design.";

const HOME_VIDEO_PROMPT =
  "Continuing from this exact image. Bring the camera slowly closer to the referenced product naturally as if someone is filming it on their phone at home, and have a hand come in and poke it as if the person recording reached out and touched it, no transitions, product stays the clear focus and fully visible in frame throughout, no warping of the referenced product or its label, no alteration to its color, shape, or logo placement from the start frame.";

type CanonicalStyle1Category =
  | "beauty_skincare"
  | "kitchen_food"
  | "home_storage"
  | "tools_outdoor"
  | "tech"
  | "pets";

const CATEGORY_ALIASES: Record<string, CanonicalStyle1Category> = {
  beauty: "beauty_skincare",
  skincare: "beauty_skincare",
  beauty_skincare: "beauty_skincare",
  skincare_beauty: "beauty_skincare",
  kitchen: "kitchen_food",
  food: "kitchen_food",
  kitchen_food: "kitchen_food",
  food_kitchen: "kitchen_food",
  home: "home_storage",
  storage: "home_storage",
  home_storage: "home_storage",
  storage_home: "home_storage",
  outdoor: "tools_outdoor",
  tools: "tools_outdoor",
  garden: "tools_outdoor",
  tools_outdoor: "tools_outdoor",
  outdoor_tools: "tools_outdoor",
  tools_outdoor_garden: "tools_outdoor",
  outdoor_tools_garden: "tools_outdoor",
  tech: "tech",
  pet: "pets",
  pets: "pets",
};

const HOME_PLACEMENTS: Record<
  CanonicalStyle1Category,
  { setting: string; surface: string }
> = {
  beauty_skincare: { setting: "bathroom", surface: "countertop" },
  kitchen_food: { setting: "kitchen", surface: "countertop" },
  home_storage: { setting: "living room", surface: "side table" },
  tools_outdoor: { setting: "garage", surface: "workbench" },
  tech: { setting: "home office", surface: "desk" },
  pets: { setting: "living room", surface: "floor" },
};

export function compileStyle1Plan(input: Style1PlanInput): Style1Plan {
  const candidate = (input ?? {}) as Partial<Style1PlanInput>;
  const productName =
    typeof candidate.productName === "string" ? candidate.productName.trim() : "";
  const productReferenceImageId =
    typeof candidate.productReferenceImageId === "string"
      ? candidate.productReferenceImageId.trim()
      : "";
  const categoryKey =
    typeof candidate.category === "string"
      ? candidate.category
          .trim()
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "_")
          .replaceAll(/^_+|_+$/g, "")
      : "";
  const category = CATEGORY_ALIASES[categoryKey];
  const placement = category ? HOME_PLACEMENTS[category] : undefined;
  const issues: Style1PlanValidationIssue[] = [];

  if (!productName) {
    issues.push({ path: "productName", message: "Product name is required" });
  }
  if (candidate.market !== "UK" && candidate.market !== "US") {
    issues.push({ path: "market", message: "Market must be UK or US" });
  }
  if (!categoryKey) {
    issues.push({ path: "category", message: "Product category is required" });
  } else if (!category || !placement) {
    issues.push({
      path: "category",
      message: "Product category does not map to a deterministic Style 1 home placement",
    });
  }
  if (!productReferenceImageId) {
    issues.push({
      path: "productReferenceImageId",
      message: "A product reference image is required",
    });
  }
  if (issues.length > 0) {
    throw new Style1PlanValidationError(issues);
  }

  const market = candidate.market as Style1Market;
  const resolvedCategory = category as CanonicalStyle1Category;
  const resolvedPlacement = placement as { setting: string; surface: string };
  const homeSetting = resolvedPlacement.setting;
  const homeSurface = resolvedPlacement.surface;

  const prompts: Style1PlanPrompts = {
    scene_1_store_image: `Put a display setup for this product inside of a ${market} retail store, no price tags. The referenced product matches its exact color, shape, logo placement, and proportions from the attached reference — do not alter its design in any way.`,
    scene_1_store_video: STORE_VIDEO_PROMPT,
    scene_2_home_image: `A real casual iPhone snapshot of this exact product sitting on a clean, tidy ${homeSurface} in a normal everyday ${homeSetting}. The referenced product matches its exact color, shape, logo placement, and proportions from the attached reference — do not alter its design in any way. The home looks real and presentable — clean surfaces with just one or two natural everyday items nearby, NOT cluttered, NOT messy, NOT styled or curated. Flat, normal indoor household lighting — no soft golden-hour glow, no dramatic light. Authentic phone-camera look: slight grain, true-to-life colors, minor natural imperfections, slightly casual framing like a quick photo. The product is clearly visible with its label sharp and readable, fully in frame and never cropped by the frame edge. Amateur snapshot of a clean normal home, NOT professional, NOT cinematic, NOT studio, NOT glossy, NOT CGI, NOT a magazine shoot, and NOT messy or dirty. Vertical 9:16.`,
    scene_2_home_video: HOME_VIDEO_PROMPT,
  };

  return {
    specVersion: MANAGED_STYLE1_SPEC_VERSION,
    context: {
      productName,
      market,
      category: resolvedCategory,
      productReferenceImageId,
      homeSetting,
      homeSurface,
    },
    prompts,
    slots: [
      {
        slot: "scene_1_store_image",
        assetType: "STORE_IMAGE",
        mediaType: "image",
        prompt: prompts.scene_1_store_image,
        dependencies: [],
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: [productReferenceImageId],
          startImageSlot: null,
        },
      },
      {
        slot: "scene_1_store_video",
        assetType: "STORE_VIDEO",
        mediaType: "video",
        prompt: prompts.scene_1_store_video,
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
        prompt: prompts.scene_2_home_image,
        dependencies: [],
        generation: {
          aspectRatio: "9:16",
          productReferenceImageIds: [productReferenceImageId],
          startImageSlot: null,
        },
      },
      {
        slot: "scene_2_home_video",
        assetType: "HOME_VIDEO",
        mediaType: "video",
        prompt: prompts.scene_2_home_video,
        dependencies: ["scene_2_home_image"],
        generation: {
          aspectRatio: "portrait",
          durationSeconds: 8,
          productReferenceImageIds: [],
          startImageSlot: "scene_2_home_image",
        },
      },
    ],
  };
}
