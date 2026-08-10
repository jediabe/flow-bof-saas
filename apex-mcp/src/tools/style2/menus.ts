/**
 * Style 2 SOP — rotation menus and product-type → room table.
 *
 * These arrays are transcribed VERBATIM from docs/STYLE-2-SOP.md §3.
 * Do not paraphrase, alphabetise, or "clean up" the wording. Each
 * value survives untouched into the generated scene-image prompt,
 * where the model sees "warm wood" vs "wood, warm" as different
 * inputs. Reordering also silently changes the seeded roll result,
 * which invalidates any regression test that pins a seed to a scene.
 *
 * When the SOP changes, update this file; do not add "helper"
 * menus derived from these — the SOP is the single source of truth
 * and having two copies guarantees they drift.
 */

/* ==================================================================
 * Product-type → room table (SOP §3)
 * ================================================================ */

/** The five product-type buckets the SOP recognises. */
export const PRODUCT_TYPES = [
  "skincare_beauty_makeup_haircare",
  "clothing_fashion_shoes",
  "outdoor_garden_fitness",
  "home_kitchen",
  "other",
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** The four rooms the SOP defines a rotation menu for. */
export const ROOMS = ["bathroom", "kitchen", "outdoor", "bedroom"] as const;
export type Room = (typeof ROOMS)[number];

/**
 * SOP §3 room table.
 *
 * "Else → a realistic room it belongs in" is not something a
 * deterministic tool can decide without inventory context. We
 * default the fallback to bathroom (the highest-volume Style 2
 * room in practice) and set `note` on the roll so the caller
 * knows to override room/props if the product doesn't fit.
 */
export const PRODUCT_TYPE_TO_ROOM: Record<ProductType, Room> = {
  skincare_beauty_makeup_haircare: "bathroom",
  clothing_fashion_shoes: "bedroom",
  outdoor_garden_fitness: "outdoor",
  home_kitchen: "kitchen",
  other: "bathroom",
};

/* ==================================================================
 * Rotation menus (SOP §3)
 *
 * Every value is verbatim from the SOP. The menu keys here
 * (`style`, `mirror`, ...) are the keys used in the returned
 * `rolls` map — kept short so the JSON stays readable.
 * ================================================================ */

export const BATHROOM_MENUS = {
  style: [
    "white subway tile",
    "grey stone",
    "white marble",
    "warm wood",
    "dark charcoal tile",
    "micro-cement",
    "sage-green tile",
  ],
  mirror: [
    "round LED-lit",
    "rectangular LED-lit",
    "large frameless",
    "arched",
    "plain tiled wall (no mirror)",
  ],
  outfit: [
    "white ribbed tank",
    "black tank",
    "grey tank",
    "cream waffle robe",
    "lilac robe",
    "blue robe",
    "grey robe",
  ],
  camera_angle: [
    "dead straight-on",
    "very slightly above",
    "very slightly below",
    "a touch off to one side",
  ],
  pose: [
    "both forearms on the counter",
    "one forearm down + selfie arm extended to the lens",
    "leaning in close with chin near hand",
  ],
  lighting: [
    "bright window daylight",
    "warm vanity bulbs",
    "mixed daylight + warm",
    "flat even everyday light",
  ],
  product_cluster: [
    "serums, tubes, jars",
    "lipsticks, compact, brushes in a cup",
    "makeup bag, cotton pads, towel",
    "serums, cotton pads, brushes in a cup",
    "jars, lipsticks, towel",
    "tubes, compact, makeup bag",
  ],
} as const;

export const KITCHEN_MENUS = {
  setting: [
    "bright white modern",
    "warm wood",
    "marble-island",
    "grey handleless",
    "farmhouse with open shelving",
    "small cozy apartment",
  ],
  outfit: [
    "white ribbed tank",
    "black tank",
    "grey tank",
    "cropped tee",
    "oversized shirt",
    "linen shirt",
  ],
  camera_angle: [
    "dead straight-on",
    "very slightly above",
    "very slightly below",
    "a touch off to one side",
  ],
  pose: [
    "both forearms leaning on the counter",
    "one forearm down + selfie arm extended",
    "standing close to the counter, chin near hand",
  ],
  lighting: [
    "bright window daylight",
    "warm kitchen downlights",
    "flat even everyday light",
    "soft daylight",
  ],
  foreground_cluster: [
    "fruit bowl",
    "chopping board",
    "mug of coffee",
    "kettle",
    "plant",
    "glasses",
    "tea towel",
    "utensil pot",
  ],
} as const;

export const OUTDOOR_MENUS = {
  setting: [
    "sunny patio with small table",
    "garden lawn with plants and fence",
    "poolside with loungers",
    "wooden deck with potted foliage",
    "balcony with hanging plants",
    "porch steps with greenery",
  ],
  outfit: [
    "white summer sundress",
    "tank top + denim shorts",
    "cropped tee + shorts",
    "linen shirt over a vest",
    "activewear set",
    "swimsuit + open cover-up",
  ],
  outfit_colour: ["white", "black", "sage", "tan", "pastel"],
  camera_angle: [
    "dead straight-on",
    "very slightly above",
    "very slightly below",
    "a touch off to one side",
  ],
  pose: [
    "leaning forearms on a patio table",
    "sitting on a lounger leaning toward the lens",
    "standing close by the plants",
    "crouched beside a garden bed, selfie arm extended",
  ],
  lighting: [
    "bright midday sun",
    "warm golden-hour glow",
    "soft overcast even light",
    "dappled light through leaves",
  ],
  foreground_cluster: [
    "cold drink with condensation",
    "sunglasses",
    "sunhat",
    "book",
    "plant pot",
    "folded towel",
    "patio-table bits",
  ],
} as const;

/**
 * Bedroom is clothing-only and does NOT roll an outfit — the
 * garment IS the outfit (SOP §3 fashion exception). We roll
 * setting, framing, camera angle, pose, lighting only.
 */
export const BEDROOM_MENUS = {
  setting: [
    "neutral modern with a made bed",
    "with a full-length mirror",
    "cozy with plants and soft bedding",
    "minimalist",
    "warm-lit with a rattan chair",
  ],
  framing: [
    "camera pulled back, garment visible head-to-thigh",
    "full-length mirror selfie",
  ],
  camera_angle: [
    "straight-on",
    "a touch to one side",
    "mirror angle",
  ],
  pose: [
    "standing showing the outfit",
    "turning to show the back",
    "sitting on the edge of the bed",
    "mirror-selfie stance",
  ],
  lighting: [
    "soft window daylight",
    "warm bedside lamp",
    "bright even daylight",
  ],
} as const;

/* ==================================================================
 * Menu index — the single lookup table roll_scene walks.
 * Every entry names the room, its menu source, and the SOP key.
 * ================================================================ */

export const MENUS_BY_ROOM: Record<Room, Record<string, readonly string[]>> = {
  bathroom: BATHROOM_MENUS,
  kitchen: KITCHEN_MENUS,
  outdoor: OUTDOOR_MENUS,
  bedroom: BEDROOM_MENUS,
};
