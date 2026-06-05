/**
 * US TikTok Shop retail-environment catalogue + the blanket
 * image-prompt template the "Build US Store Prompt" path uses.
 *
 * Why this exists at all when uk-retailers.ts already covers the UK
 * workflow: the US prompts CANNOT mention specific named stores (per
 * the v0.7 spec — different legal / brand-safety surface from the UK
 * workflow). Instead we ship a catalogue of generic retail-environment
 * descriptions and a category→environment matcher that picks one.
 *
 * The "retailerName" field stored on Product for a US batch will hold
 * one of the `key`s from this file (e.g. "us_big_box_aisle"); the
 * prompt template renders the corresponding `phrase` into the
 * placement sentence.
 *
 * Lives in code (not the database) for the same reason as the UK
 * catalogue: phrasing tweaks happen in one place.
 */

export const US_ENVIRONMENT_FALLBACK = "__us_fallback__" as const;

export interface UsRetailEnvironment {
  /**
   * Stable key used as the canonical retailerName for the US workflow.
   * `__us_fallback__` collapses to the generic "American retail store"
   * placement sentence.
   */
  key: string;
  /** Display label shown in the selector. */
  label: string;
  /**
   * Phrase substituted into the prompt template's [US_ENVIRONMENT]
   * slot. Generic environment language only — no named stores. For
   * the fallback, the template uses a fully generic sentence.
   */
  phrase: string | null;
}

/**
 * Catalogue of US retail environments. Ordered roughly from generic
 * to specific so the manual selector reads sensibly top-to-bottom.
 * Add new entries at the end so existing Product.retailerName values
 * (stored as `key`) keep resolving.
 */
export const US_ENVIRONMENTS: ReadonlyArray<UsRetailEnvironment> = [
  {
    key: US_ENVIRONMENT_FALLBACK,
    label: "US retail store (fallback)",
    phrase: null,
  },
  {
    key: "us_big_box_aisle",
    label: "American big-box retail aisle",
    phrase:
      "broad American big-box retail aisle, wide shelves, bright overhead lighting, " +
      "everyday consumer goods nearby",
  },
  {
    key: "us_lifestyle_retail",
    label: "Modern American lifestyle retail display",
    phrase:
      "modern American lifestyle retail display, clean shelves, polished merchandising, " +
      "soft bright retail lighting",
  },
  {
    key: "us_warehouse_club",
    label: "American warehouse-club aisle",
    phrase:
      "warehouse-club-style retail aisle, tall industrial shelving, bulk-pack " +
      "presentation, wide concrete floor, bright ceiling lights",
  },
  {
    key: "us_pharmacy_aisle",
    label: "American pharmacy-style aisle",
    phrase:
      "American pharmacy-style retail aisle, organized wellness shelves, bright " +
      "clinical retail lighting",
  },
  {
    key: "us_beauty_display",
    label: "American beauty retail display",
    phrase:
      "American beauty retail display, cosmetics counter, clean testers, glossy " +
      "shelves, premium lighting",
  },
  {
    key: "us_electronics_showroom",
    label: "American electronics showroom / tech aisle",
    phrase:
      "American electronics showroom or tech aisle, demo counter, clean modern " +
      "product display, cool bright lighting",
  },
  {
    key: "us_home_improvement",
    label: "American home-improvement retail aisle",
    phrase:
      "American home-improvement retail aisle, industrial shelving, tools or " +
      "hardware nearby, practical store lighting",
  },
  {
    key: "us_pet_supply",
    label: "American pet-supply retail aisle",
    phrase:
      "American pet-supply retail aisle, pet food / accessory shelves, clean " +
      "organized display",
  },
  {
    key: "us_sporting_goods",
    label: "American sporting goods retail section",
    phrase:
      "American sporting goods retail section, fitness equipment shelves, " +
      "athletic accessories nearby",
  },
  {
    key: "us_home_shopping_setup",
    label: "American home / kitchen / desk surface",
    phrase:
      "realistic American home-shopping setup — kitchen counter, bathroom shelf, " +
      "office desk, bedroom dresser, garage workbench, or living room surface " +
      "depending on what fits the product naturally",
  },
];

/** Look up a US environment by key. Falls back to the generic entry. */
export function findUsEnvironment(
  key: string | null | undefined,
): UsRetailEnvironment {
  if (!key) return US_ENVIRONMENTS[0];
  return US_ENVIRONMENTS.find((r) => r.key === key) ?? US_ENVIRONMENTS[0];
}

interface UsEnvironmentRule {
  envKey: string;
  /**
   * Substrings matched against `(category + " " + productName).toLowerCase()`
   * — first matching rule wins. Order this array from most specific to
   * least specific so the niche categories don't lose to a generic
   * "household" hit.
   */
  keywords: string[];
}

/**
 * Category → environment mapping. Mirrors the v0.7 PART 2 US
 * environment catalogue. Most-specific rules first so e.g. "skincare"
 * lands in `us_beauty_display`, not the broader `us_pharmacy_aisle`.
 */
const US_ENVIRONMENT_RULES: UsEnvironmentRule[] = [
  // Beauty / luxury beauty first — premium positioning beats the
  // generic pharmacy aisle for makeup and high-end skincare.
  {
    envKey: "us_beauty_display",
    keywords: [
      "makeup", "make-up", "make up",
      "lipstick", "mascara", "foundation", "eyeshadow", "concealer",
      "blush", "highlighter", "primer", "bronzer",
      "luxury skincare", "premium skincare",
      "fragrance", "perfume", "cologne", "eau de",
    ],
  },
  // Health / general skincare / grooming — pharmacy aisle.
  {
    envKey: "us_pharmacy_aisle",
    keywords: [
      "skincare", "skin care", "serum", "moisturiser", "moisturizer",
      "cleanser", "toner", "sunscreen", "spf",
      "vitamin", "supplement", "wellness", "protein", "collagen",
      "omega", "probiotic", "biotin", "magnesium",
      "hair", "shampoo", "conditioner",
      "grooming", "shave", "shaver", "razor", "beard",
      "oral", "toothpaste", "toothbrush", "mouthwash", "deodorant",
      "health",
    ],
  },
  // Electronics / tech / gaming.
  {
    envKey: "us_electronics_showroom",
    keywords: [
      "electronics", "tech", "laptop", "phone", "smartphone", "tablet",
      "appliance", "gaming", "console", "audio",
      "headphone", "earphone", "earbud", "speaker",
      "tv", "monitor", "camera",
    ],
  },
  // Sports / fitness — non-clothing.
  {
    envKey: "us_sporting_goods",
    keywords: [
      "sports", "sport equipment", "gym", "fitness",
      "yoga", "dumbbell", "kettlebell", "resistance band", "running",
      "athletic", "workout",
    ],
  },
  // Home improvement / tools / garden.
  {
    envKey: "us_home_improvement",
    keywords: [
      "tool", "tools", "drill", "hammer", "wrench",
      "home improvement", "diy",
      "garden", "outdoor", "patio", "lawn",
    ],
  },
  // Pet products.
  {
    envKey: "us_pet_supply",
    keywords: [
      "pet", "pets", "dog food", "cat food", "pet food",
      "pet toy", "pet accessory", "pet grooming", "leash", "litter",
    ],
  },
  // Bulk / large-pack / appliances.
  {
    envKey: "us_warehouse_club",
    keywords: [
      "bulk", "case of", "pack of 24", "pack of 48",
      "large appliance", "industrial",
    ],
  },
  // Lifestyle retail — apparel, home, beauty-adjacent, accessories.
  {
    envKey: "us_lifestyle_retail",
    keywords: [
      "clothing", "apparel",
      "t-shirt", "tshirt", "tee", "shirt", "jeans", "trousers",
      "dress", "hoodie", "jumper", "jacket", "coat",
      "underwear", "socks",
      "home decor", "lifestyle",
      "accessory", "accessories", "bag", "handbag", "scarf", "hat",
    ],
  },
  // Big-box catch-all — household, grocery, cleaning, everyday goods.
  {
    envKey: "us_big_box_aisle",
    keywords: [
      "household", "grocery", "snack", "drink", "beverage",
      "cleaning", "everyday",
      "kitchen", "drinkware", "cookware", "tableware",
      "small appliance",
      "toy", "toys", "game", "games", "puzzle", "action figure",
      "doll", "plush",
    ],
  },
  // Home-shopping surface — explicit hints that the product is for
  // home/lifestyle use rather than a retail aisle. Comes near the end
  // because most products will have matched something more specific
  // by now.
  {
    envKey: "us_home_shopping_setup",
    keywords: [
      "for the bathroom", "for the kitchen", "for the bedroom",
      "for the office", "for the garage", "for the living room",
    ],
  },
];

/**
 * Best-match US environment key for a product. Returns the fallback
 * when no rule matches — the prompt still works, just lands in the
 * generic "American retail store" placement sentence.
 */
export function pickUsEnvironmentKey({
  category,
  productName,
}: {
  category: string | null | undefined;
  productName: string | null | undefined;
}): string {
  const haystack = `${category ?? ""} ${productName ?? ""}`.toLowerCase();
  if (!haystack.trim()) return US_ENVIRONMENT_FALLBACK;
  for (const rule of US_ENVIRONMENT_RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) {
      return rule.envKey;
    }
  }
  return US_ENVIRONMENT_FALLBACK;
}

/**
 * Build a US image prompt for a product. Picks the environment
 * automatically (overriding a stored retailerName only when null) so
 * a freshly-imported US batch lands with sensible environments
 * without the user touching each row.
 */
export function buildUsRetailPrompt(product: {
  productName: string | null | undefined;
  category: string | null | undefined;
  retailerName?: string | null;
}): { prompt: string; envKey: string } {
  const envKey =
    product.retailerName ||
    pickUsEnvironmentKey({
      category: product.category,
      productName: product.productName,
    });
  return { prompt: buildUsStorePrompt(envKey), envKey };
}

/**
 * Compose the US image prompt for a given environment key. The
 * fallback key inserts the generic "American retail store" placement
 * sentence rather than a category-specific one.
 *
 * Output is the same four-paragraph structure as the UK builder so
 * the runner sees the same shape regardless of market. Paragraph 3
 * is the one that diverges: UK names a retailer; US describes the
 * environment by appearance only.
 */
export function buildUsStorePrompt(envKey: string | null | undefined): string {
  const env = findUsEnvironment(envKey);
  const placement =
    env.phrase === null
      ? "Place the product inside a realistic American retail store environment, " +
        "no price tags, no text overlays, no promotional graphics, no catalog layout."
      : `Place the product inside a ${env.phrase}, no price tags, no text overlays, ` +
        "no promotional graphics, no catalog layout.";

  return [
    // Paragraph 1 — reference handling (same guardrail as UK; the
    // surface-area of reference-image trickery doesn't change by
    // market).
    "Use the uploaded reference image only to understand the product's design. " +
      "Do not copy the reference image layout, background, text, labels, " +
      "promotional graphics, multiple variants, collage arrangement, catalog " +
      "composition, TikTok UI, shipping badges, discount claims, or " +
      "product-page graphics.",
    // Paragraph 2 — product extraction.
    "Extract the primary product as one realistic physical product display. " +
      "Show one product, or one complete pair/set if that is how the product " +
      "is naturally sold.",
    // Paragraph 3 — placement (the only paragraph that varies between
    // UK and US).
    placement,
    // Paragraph 4 — realism constraints. Casual handheld iPhone shopper
    // photo style matches the spec's PART 3 "Realism" section.
    "Preserve the product's core shape, color, material, proportions, packaging, " +
      "and branding if visible. Make it look physically present with realistic " +
      "scale, contact shadows, shelf / table / counter placement, and ordinary " +
      "nearby store or home items as appropriate. Casual handheld iPhone " +
      "shopper photo, realistic American retail or home environment. No studio " +
      "render, no catalog layout, no text overlays, no promotional graphics, " +
      "no fake UI.",
  ].join("\n\n");
}
