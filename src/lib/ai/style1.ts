/**
 * Style 1 — Store Discovery — shared types + parser.
 *
 * The video kit produced by the AI copy bot for one product. Stored
 * as a JSON string on Product.style1Kit; parsed via parseStyle1Kit
 * for consumers (desktop /prompts, mobile posting).
 *
 * SHAPE PIVOT (2026-08): the kit no longer contains Flow scene
 * prompts (imagePrompt / motionPrompt / retailerName / setting).
 * The user built an external "Google Flow tool" that generates
 * Flow prompts from three plain fields — productName + market +
 * category — so all we do here is extract those three cleanly and
 * hand them off. The Flow scenes are entirely out-of-band now.
 *
 * The copy generator half (Part 1/2/3 options + hashtags + product
 * description) still runs in the same LLM call and drives what the
 * mobile posting page shows.
 *
 * See uk-retail-prompts.ts for the system-prompt spec that produces
 * this shape.
 */

export interface Style1Kit {
  /** Short, sayable product name for the Google Flow tool AND the
   *  voice/on-screen copy. e.g. "Ninja CREAMi Deluxe", not the
   *  full listing title. */
  productName: string;

  /** "UK" | "US". Drives basket vs. cart wording. */
  market: "UK" | "US";

  /** One of: Beauty/Skincare, Kitchen/Food, Home/Storage,
   *  Tools/Outdoor, Tech, Pets. Drives the room setting the
   *  external Google Flow tool picks for Scene 2. */
  category: string;

  copy: {
    /** 5 options for Part 1 — on-screen text over Scene 1 AND
     *  spoken by ElevenLabs. 22-26 words each (~8s read). Mix of
     *  apology / WAIT / this-is-your-sign shapes. Every option
     *  includes the exact discount %. */
    part1Options: string[];
    /** 5 options for Part 2 — voiceover for Scene 2, spoken only.
     *  18-22 words each (~8s read). Experiential benefit → deal +
     *  CTA. UK "orange basket"; US "orange cart". */
    part2Options: string[];
    /** 5 options for Part 3 — on-screen sale text over Scene 2,
     *  shown only. ≤10 words each. Deal + urgency + CTA. */
    part3Options: string[];
  };

  /** 5-tag hashtag block including #AIGC. Exact SOP set:
   *  #tiktokshopuk #dealdrops #tiktokmademebuyit #weekendsale #AIGC
   *  (US market swaps #tiktokshopuk for #tiktokshopus). */
  hashtags: string[];

  /** Short TikTok-caption-ready product description. One line,
   *  no marketing fluff — the operator pastes it as the caption
   *  lead-in above the hashtags. */
  productDescription: string;

  /** Discount % the copy is built around. Copied verbatim from
   *  the input; null when no discount was supplied. */
  discountPercent: number | null;

  /** LLM-surfaced warnings — missing discount %, ambiguous
   *  market, etc. Rendered on /prompts as an amber notice. */
  warnings: string[];
}

/**
 * Parse a JSON-string Style1Kit into the typed shape. Returns null
 * on malformed input rather than throwing so consumers can render
 * a "regenerate" affordance instead of blowing up the page.
 *
 * Tolerant on missing fields. Also handles legacy kits from the
 * pre-pivot shape (scene1/scene2/productShortName) by degrading
 * to null so callers show the "regenerate" nudge — legacy kits
 * lack the productName + category fields the new UI expects and
 * would render nonsense if we tried to coerce them.
 */
export function parseStyle1Kit(raw: string | null | undefined): Style1Kit | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;

  // Legacy pre-pivot shape had scene1/scene2 at the top level and
  // called the name field productShortName. Reject so /prompts
  // shows the "regenerate to get the new shape" nudge.
  if ("scene1" in r || "scene2" in r) return null;

  const productName = typeof r.productName === "string" ? r.productName.trim() : "";
  const category = typeof r.category === "string" ? r.category.trim() : "";
  const productDescription =
    typeof r.productDescription === "string" ? r.productDescription.trim() : "";
  const copy = coerceCopy(r.copy);
  const hashtags = coerceStringArray(r.hashtags);
  const warnings = coerceStringArray(r.warnings);
  const discountPercent =
    typeof r.discountPercent === "number" && Number.isFinite(r.discountPercent)
      ? Math.round(r.discountPercent)
      : null;
  const market: "UK" | "US" = r.market === "US" ? "US" : "UK";

  // Minimum shape check — a name + at least one Part 1 option is
  // enough for the mobile posting page to render something useful.
  if (!productName) return null;
  if (copy.part1Options.length === 0) return null;

  return {
    productName,
    market,
    category,
    copy,
    hashtags,
    productDescription,
    discountPercent,
    warnings,
  };
}

function coerceCopy(v: unknown): Style1Kit["copy"] {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    part1Options: coerceStringArray(o.part1Options),
    part2Options: coerceStringArray(o.part2Options),
    part3Options: coerceStringArray(o.part3Options),
  };
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Compose the exact block the operator pastes into their external
 * Google Flow tool. Three plain lines — the format the tool
 * expects. Deterministic (no LLM call).
 *
 *   Product Name: <productName>
 *   Market: <UK|US>
 *   Category: <one of the enum>
 */
export function buildGoogleFlowToolInput(kit: Style1Kit): string {
  return `Product Name: ${kit.productName}\nMarket: ${kit.market}\nCategory: ${kit.category}`;
}

/**
 * Compose the ElevenLabs script the operator pastes into their
 * saved voice. Part 1 + Part 2 back-to-back = ~16s voice file
 * that plays across BOTH scenes (Part 1 over Scene 1, Part 2 over
 * Scene 2) — this is the coach's confirmed reading of the SOP,
 * overriding Step 6's "Scene 2 only" phrasing.
 *
 * Falls back to option 1 of each part when the operator hasn't
 * picked a specific option yet — the script is always something
 * the operator can paste, even mid-triage.
 *
 * Adds a blank line between Part 1 and Part 2 so ElevenLabs
 * treats them as separate reads with a natural beat between —
 * matches how the CapCut cut lands.
 */
export function buildElevenLabsScript(
  kit: Style1Kit,
  chosenPart1: string | null,
  chosenPart2: string | null,
): string {
  const part1 = chosenPart1 || kit.copy.part1Options[0] || "";
  const part2 = chosenPart2 || kit.copy.part2Options[0] || "";
  if (!part1 && !part2) return "";
  if (!part2) return part1;
  if (!part1) return part2;
  return `${part1}\n\n${part2}`;
}
