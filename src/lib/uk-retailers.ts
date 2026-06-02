/**
 * UK retailer catalogue + the blanket image-prompt template the
 * "Build UK Store Prompt" button uses.
 *
 * The template intentionally lives in code (not in the database) so we
 * can tweak phrasing in one place. When we eventually swap in
 * per-tenant prompt presets, this becomes the default that a workspace
 * inherits.
 */

export const UK_RETAILER_FALLBACK = "__fallback__" as const;

export interface UkRetailer {
  /** Stable key. Special value `__fallback__` means "generic UK retail store". */
  key: string;
  /** Display label shown in the selector. */
  label: string;
  /**
   * Phrase substituted into the prompt template's [RETAILER] slot.
   * For the fallback, the template uses the generic "UK retail store"
   * variant — `phrase` is null and the builder picks the fallback
   * sentence.
   */
  phrase: string | null;
}

export const UK_RETAILERS: ReadonlyArray<UkRetailer> = [
  { key: UK_RETAILER_FALLBACK, label: "UK retail store (fallback)", phrase: null },
  { key: "boots",              label: "Boots",                phrase: "Boots" },
  { key: "sephora_uk",         label: "Sephora UK",           phrase: "Sephora UK" },
  { key: "selfridges",         label: "Selfridges",           phrase: "Selfridges" },
  { key: "holland_and_barrett",label: "Holland & Barrett",    phrase: "Holland & Barrett" },
  { key: "primark",            label: "Primark",              phrase: "Primark" },
  { key: "schuh",              label: "Schuh",                phrase: "Schuh" },
  { key: "jd_sports",          label: "JD Sports",            phrase: "JD Sports" },
  { key: "ikea",               label: "IKEA",                 phrase: "IKEA" },
  { key: "john_lewis",         label: "John Lewis",           phrase: "John Lewis" },
  { key: "currys",             label: "Currys",               phrase: "Currys" },
  { key: "argos",              label: "Argos",                phrase: "Argos" },
  { key: "smyths_toys",        label: "Smyths Toys",          phrase: "Smyths Toys" },
  { key: "pets_at_home",       label: "Pets at Home",         phrase: "Pets at Home" },
  { key: "tesco",              label: "Tesco",                phrase: "Tesco" },
];

/** Look up a retailer by key. Falls back to the generic entry. */
export function findRetailer(key: string | null | undefined): UkRetailer {
  if (!key) return UK_RETAILERS[0];
  return UK_RETAILERS.find((r) => r.key === key) ?? UK_RETAILERS[0];
}

/**
 * Best-match retailer for a product based on category + name keywords.
 * Categories are matched first, then we fall through to keyword-spotting
 * inside the productName as a tiebreaker. Returns the fallback retailer
 * key when nothing fits — the prompt template still works, it just
 * places the product in a generic UK retail store.
 *
 * Keyword rules are intentionally additive: if a product looks like both
 * "skincare" and "perfume", whichever rule matches first wins. The order
 * of the array below is therefore the priority order.
 */
interface RetailerKeywordRule {
  retailerKey: string;
  /**
   * Substrings checked against `(category + " " + productName).toLowerCase()`.
   * Substrings are matched as-is (no regex), each word/phrase a separate entry.
   */
  keywords: string[];
}

const RETAILER_KEYWORD_RULES: RetailerKeywordRule[] = [
  { retailerKey: "selfridges",          keywords: ["perfume", "cologne", "fragrance", "eau de"] },
  { retailerKey: "sephora_uk",          keywords: ["makeup", "make-up", "make up", "luxury skincare", "beauty", "lipstick", "mascara", "foundation", "eyeshadow", "concealer", "blush", "highlighter", "bath", "body wash"] },
  { retailerKey: "boots",               keywords: ["skincare", "skin care", "serum", "moisturiser", "moisturizer", "cleanser", "toner", "sunscreen", "hair", "shampoo", "conditioner", "grooming", "shave", "shaver", "razor", "beard", "oral", "toothpaste", "toothbrush", "mouthwash", "deodorant", "health"] },
  { retailerKey: "holland_and_barrett", keywords: ["vitamin", "supplement", "wellness", "protein", "collagen", "omega", "probiotic", "biotin", "magnesium"] },
  { retailerKey: "schuh",               keywords: ["shoe", "shoes", "footwear", "trainer", "trainers", "sneaker", "boot", "boots", "heel", "heels", "sandal", "sandals", "slipper", "slippers"] },
  { retailerKey: "jd_sports",           keywords: ["sports", "sport equipment", "gym", "fitness", "yoga", "dumbbell", "kettlebell", "resistance band", "running"] },
  { retailerKey: "primark",             keywords: ["clothing", "apparel", "t-shirt", "tshirt", "tee", "shirt", "jeans", "trousers", "dress", "hoodie", "jumper", "jacket", "coat", "underwear", "socks"] },
  { retailerKey: "ikea",                keywords: ["furniture", "storage", "bedding", "sofa", "couch", "armchair", "wardrobe", "drawer", "shelving", "home organisation", "home organization", "duvet", "pillow"] },
  { retailerKey: "john_lewis",          keywords: ["kitchen", "drinkware", "towel", "bag", "handbag", "accessory", "accessories", "homeware", "cutlery", "tableware", "cookware", "pan"] },
  { retailerKey: "currys",              keywords: ["electronics", "tech", "laptop", "phone", "smartphone", "tablet", "appliance", "gaming", "console", "audio", "headphone", "speaker", "tv", "monitor", "camera"] },
  { retailerKey: "smyths_toys",         keywords: ["toy", "toys", "game", "games", "puzzle", "action figure", "lego", "doll", "plush"] },
  { retailerKey: "argos",               keywords: ["small appliance", "household", "garden", "outdoor"] },
  { retailerKey: "pets_at_home",        keywords: ["pet", "pets", "dog food", "cat food", "pet food", "pet toy", "pet accessory", "grooming brush"] },
  { retailerKey: "tesco",               keywords: ["grocery", "snack", "drink", "beverage", "cleaning", "everyday"] },
];

/**
 * Pick the best-match retailer key for a product, given its category
 * and product name. Returns the fallback key (`__fallback__`) when no
 * rule matches.
 */
export function pickRetailerKey({
  category,
  productName,
}: {
  category: string | null | undefined;
  productName: string | null | undefined;
}): string {
  const haystack = `${category ?? ""} ${productName ?? ""}`.toLowerCase();
  if (!haystack.trim()) return UK_RETAILER_FALLBACK;
  for (const rule of RETAILER_KEYWORD_RULES) {
    if (rule.keywords.some((k) => haystack.includes(k))) {
      return rule.retailerKey;
    }
  }
  return UK_RETAILER_FALLBACK;
}

/**
 * Build a UK retail prompt for a product. Picks the retailer
 * automatically (overriding a stored retailerName only if it's null)
 * so a freshly-imported batch lands with sensible retailers without
 * the user touching each row.
 */
export function buildUkRetailPrompt(product: {
  productName: string | null | undefined;
  category: string | null | undefined;
  retailerName?: string | null;
}): { prompt: string; retailerKey: string } {
  const retailerKey =
    product.retailerName ||
    pickRetailerKey({
      category: product.category,
      productName: product.productName,
    });
  return { prompt: buildUkStorePrompt(retailerKey), retailerKey };
}

/**
 * Compose the UK store image prompt for a given retailer. The
 * fallback retailer (`__fallback__`) inserts the generic "UK retail
 * store" sentence instead of a brand-specific one.
 */
export function buildUkStorePrompt(retailerKey: string | null | undefined): string {
  const retailer = findRetailer(retailerKey);
  const placement =
    retailer.phrase === null
      ? "Put a display setup for this product inside of a UK retail store, no price tags."
      : `Put a display setup for this product inside of a ${retailer.phrase} store, no price tags.`;

  return [
    "Use the uploaded reference image only to understand the product's design. " +
      "Do not copy the reference image layout, background, text, labels, " +
      "promotional graphics, multiple variants, collage arrangement, or catalog composition.",
    "Extract the primary product as one realistic physical product display. " +
      "Show one product, or one complete pair/set if that is how the product is naturally sold.",
    placement,
    "Preserve the product's core shape, color, material, proportions, visible details, " +
      "packaging, and branding if present. Make it look physically present in the store " +
      "with realistic scale, contact shadows, shelf/table placement, and ordinary nearby " +
      "store items. Casual handheld shopper photo, realistic UK retail environment. " +
      "No text overlays, no promotional graphics, no catalog layout, no studio render.",
  ].join("\n\n");
}
