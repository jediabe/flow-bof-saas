/**
 * US TikTok Shop retail-environment catalogue + the editorial
 * image-prompt template the "Build US Store Prompt" path uses.
 *
 * Hard constraint: generated US prompts must NEVER mention specific
 * named US stores (Walmart / Target / CVS / etc.). Instead each
 * category maps to a generic store-type noun phrase that fits the
 * "inside a modern [STORE TYPE]" template slot.
 *
 * Framework (verbatim per the 2026-06-05 product spec):
 *
 *   Paragraph 1 — placement + reference handling:
 *     "Editorial retail product shot of the [PRODUCT NAME] displayed
 *     exactly as shown in the reference image on a [DISPLAY METHOD]
 *     inside a modern [STORE TYPE]. Match the product's color,
 *     texture, size, and details precisely as they appear in the
 *     reference. The product is the clear hero focus with open
 *     negative space surrounding it, nothing else nearby. No store
 *     logos, no brand signage, no price tags visible anywhere."
 *
 *   Paragraph 2 — lighting + atmosphere:
 *     "[LIGHTING SENTENCE]. Background softly blurred with realistic
 *     retail shelving and store atmosphere visible in the distance."
 *
 *   Paragraph 3 — realism / camera (verbatim, fixed):
 *     "Shot on a handheld iPhone 15 Pro style camera with authentic
 *     casual shopper framing and slight natural imperfections.
 *     Visible realism: realistic textures, slight dust particles
 *     catching light, natural shadows, true-to-size proportions. Not
 *     cinematic, not studio lighting, not glossy CGI, not overly
 *     polished. Looks like a real customer discovered the viral
 *     TikTok Shop deal while browsing."
 *
 * Each environment in the catalogue below provides a default
 * (displayMethod, storeType, lightingSentence) triple the
 * deterministic builder substitutes into the template. The AI
 * provider receives the same template + table in its system prompt
 * and picks per product.
 */

export const US_ENVIRONMENT_FALLBACK = "__us_fallback__" as const;

export interface UsRetailEnvironment {
  /**
   * Stable key used as the canonical retailerName for the US workflow.
   * `__us_fallback__` collapses to the generic "American retail store"
   * placement when no category-specific entry matches.
   */
  key: string;
  /** Display label shown in the selector. */
  label: string;
  /**
   * Generic store-type noun phrase substituted into the template's
   * "inside a modern [STORE TYPE]" slot. NEVER a named retailer.
   */
  storeType: string;
  /**
   * Fixture / surface the product sits on, substituted into the
   * "displayed ... on a [DISPLAY METHOD]" slot. Singular noun
   * phrase that grammatically follows "on a / on an".
   */
  displayMethod: string;
  /**
   * One-sentence lighting description that opens paragraph 2.
   * Should be a complete sentence (no trailing period — the builder
   * appends one along with the rest of the paragraph).
   */
  lightingSentence: string;
}

/**
 * Catalogue of US retail environments. Add new entries at the END
 * so existing Product.retailerName values keep resolving by key.
 *
 * The previous "us_home_shopping_setup" fallback was removed
 * (2026-06-05) — it was placing products on kitchen counters /
 * bathroom shelves rather than retail fixtures, which contradicted
 * the "retail product shot" intent of the framework. Replaced with
 * a stronger generic-retail fallback + new "us_auto_accessories"
 * category for car / vehicle accessory products.
 */
export const US_ENVIRONMENTS: ReadonlyArray<UsRetailEnvironment> = [
  {
    key: US_ENVIRONMENT_FALLBACK,
    label: "US retail store (fallback)",
    storeType: "American retail store",
    displayMethod: "tidy retail shelf",
    lightingSentence:
      "Even retail lighting with neutral ceiling tones evenly washes the product",
  },
  {
    key: "us_big_box_aisle",
    label: "American big-box retail store",
    storeType: "American big-box retail store",
    displayMethod: "shelf endcap with neatly faced front",
    lightingSentence:
      "Cool overhead retail lighting with natural ceiling glow brightens the aisle",
  },
  {
    key: "us_lifestyle_retail",
    label: "American lifestyle retail store",
    storeType: "American lifestyle retail store",
    displayMethod: "folded table display at eye level",
    lightingSentence:
      "Soft warm retail lighting from track fixtures highlights the product surface",
  },
  {
    key: "us_warehouse_club",
    label: "American warehouse club store",
    storeType: "American warehouse club store",
    displayMethod: "tall industrial pallet shelf",
    lightingSentence:
      "Bright fluorescent ceiling lighting flattens shadows across an open concrete floor",
  },
  {
    key: "us_pharmacy_aisle",
    label: "American pharmacy",
    storeType: "American drugstore-style pharmacy",
    displayMethod: "clean white pharmacy shelf with section dividers",
    lightingSentence:
      "Bright clinical retail lighting with an even white fluorescent tone illuminates the aisle",
  },
  {
    key: "us_beauty_display",
    label: "American beauty retail store",
    storeType: "American beauty retail store",
    displayMethod: "glossy cosmetics counter display",
    lightingSentence:
      "Premium spotlight lighting accents the product's surface with a soft warm glow",
  },
  {
    key: "us_electronics_showroom",
    label: "American electronics retail store",
    storeType: "American electronics retail store",
    displayMethod: "dedicated demo stand with a backlit accent strip",
    lightingSentence:
      "Cool LED accent lighting with subtle blue undertones rims the product",
  },
  {
    key: "us_home_improvement",
    label: "American home-improvement retail store",
    storeType: "American home-improvement retail store",
    displayMethod: "industrial peg hook on a steel slatwall",
    lightingSentence:
      "Bright practical overhead lighting with a slight warm cast covers the aisle",
  },
  {
    key: "us_pet_supply",
    label: "American pet supply retail store",
    storeType: "American pet supply retail store",
    displayMethod: "tidy pet-aisle shelf with section signage softly out of focus",
    lightingSentence:
      "Clean even retail lighting with neutral tones washes the product",
  },
  {
    key: "us_sporting_goods",
    label: "American sporting goods retail store",
    storeType: "American sporting goods retail store",
    displayMethod: "athletic-section shelf with sleek metal supports",
    lightingSentence:
      "Cool bright retail lighting with mild accent highlights picks out the product texture",
  },
  // 2026-06-05: new category covering car / vehicle accessories.
  // Previously these landed in the (now removed) home-shopping
  // setup and got staged on kitchen counters. They belong in an
  // auto parts retail context.
  {
    key: "us_auto_accessories",
    label: "American auto parts retail store",
    storeType: "American auto parts retail store",
    displayMethod: "wall-mounted accessory peg hook above a parts shelf",
    lightingSentence:
      "Practical bright overhead retail lighting with cool steel-toned reflections falls across the product",
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
 * Category → environment mapping. Most-specific rules first so e.g.
 * "skincare" lands in `us_beauty_display`, not the broader
 * `us_pharmacy_aisle`.
 */
const US_ENVIRONMENT_RULES: UsEnvironmentRule[] = [
  // Auto / vehicle accessories first — distinctive enough that we
  // don't want it falling into one of the broader buckets below.
  {
    envKey: "us_auto_accessories",
    keywords: [
      "car ", "auto ", "automotive", "vehicle",
      "armrest", "center console", "dashboard",
      "car seat", "car mat", "car organizer", "trunk organizer",
      "steering wheel", "gear shift", "cup holder",
      "windshield", "wiper",
      "tire", "rim", "wheel cover",
      "license plate", "bumper sticker",
    ],
  },
  // Beauty / luxury beauty — premium positioning beats the generic
  // pharmacy aisle for makeup and high-end skincare.
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
  // Big-box catch-all — household, grocery, cleaning, everyday goods,
  // kitchenware, toys.
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
];

/**
 * Best-match US environment key for a product. Returns the fallback
 * when no rule matches — the prompt still works, just lands in the
 * generic "American retail store" placement.
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
 * automatically (overriding a stored retailerName only when null)
 * so a freshly-imported US batch lands with sensible environments
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
  return {
    prompt: buildUsStorePrompt(envKey, product.productName ?? null),
    envKey,
  };
}

/**
 * Compose the US image prompt for a given environment key + product
 * name. Renders the 3-paragraph editorial template per the
 * 2026-06-05 product spec — strict, no extra paragraphs, no
 * reference-handling guardrail (intentionally not in the spec).
 */
export function buildUsStorePrompt(
  envKey: string | null | undefined,
  productName: string | null = null,
): string {
  const env = findUsEnvironment(envKey);
  const name = (productName ?? "").trim() || "product";

  // Paragraph 1 — placement + reference fidelity + hero focus.
  const p1 =
    `Editorial retail product shot of the ${name} displayed exactly ` +
    `as shown in the reference image on a ${env.displayMethod} inside ` +
    `a modern ${env.storeType}. Match the product's color, texture, ` +
    `size, and details precisely as they appear in the reference. The ` +
    `product is the clear hero focus with open negative space ` +
    `surrounding it, nothing else nearby. No store logos, no brand ` +
    `signage, no price tags visible anywhere.`;

  // Paragraph 2 — lighting + soft-blur retail atmosphere.
  const p2 =
    `${env.lightingSentence}. Background softly blurred with ` +
    `realistic retail shelving and store atmosphere visible in the ` +
    `distance.`;

  // Paragraph 3 — camera + realism (verbatim, fixed text).
  const p3 =
    "Shot on a handheld iPhone 15 Pro style camera with authentic " +
    "casual shopper framing and slight natural imperfections. Visible " +
    "realism: realistic textures, slight dust particles catching " +
    "light, natural shadows, true-to-size proportions. Not cinematic, " +
    "not studio lighting, not glossy CGI, not overly polished. Looks " +
    "like a real customer discovered the viral TikTok Shop deal while " +
    "browsing.";

  return [p1, p2, p3].join("\n\n");
}
