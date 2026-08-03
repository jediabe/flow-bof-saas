/**
 * Style 1 — Store Discovery — shared types + parser.
 *
 * The full video kit produced by the AI copy bot for one product.
 * Stored as a JSON string on Product.style1Kit; parsed via
 * parseStyle1Kit for consumers (desktop /prompts, mobile posting).
 *
 * Every field is set by the LLM in a single generation call —
 * there is NO fan-out chain, no separate calls for image prompt vs.
 * copy vs. hashtags. One JSON round-trip per approved product.
 *
 * See uk-retail-prompts.ts for the system-prompt spec that produces
 * this shape.
 */

export interface Style1Scene {
  /** Prompt to paste into Google Flow's image tool. */
  imagePrompt: string;
  /** Prompt to paste into Google Flow's motion tool AFTER the image
   *  has been generated. */
  motionPrompt: string;
}

export interface Style1Scene1 extends Style1Scene {
  /** The retailer whose store shelf Scene 1 uses. e.g. "Boots",
   *  "Sephora UK", "Currys". LLM picks from the SOP's retailer
   *  library based on product category. Falls back to a generic
   *  "UK retail store" when nothing fits. */
  retailerName: string;
}

export interface Style1Scene2 extends Style1Scene {
  /** Household room Scene 2 places the product in. Niche-driven:
   *  skincare→bathroom, kitchen→kitchen, storage→bedroom, tools→
   *  garage, etc. */
  setting: string;
}

export interface Style1Kit {
  /** Store-shelf discovery scene. ~8s in the final video. */
  scene1: Style1Scene1;
  /** Product-at-home proof scene. ~8s in the final video. */
  scene2: Style1Scene2;

  copy: {
    /** 5 options for Part 1 — on-screen text over Scene 1 AND
     *  spoken by ElevenLabs. 22-26 words each (~8s read).
     *  Mix of the three approved shapes: apology / WAIT / this-is-
     *  your-sign. Every option includes the exact discount %. */
    part1Options: string[];
    /** 5 options for Part 2 — voiceover for Scene 2, spoken only.
     *  18-22 words each (~8s read). Two beats: experiential
     *  benefit → deal + CTA. UK says "orange basket"; US says
     *  "orange cart". */
    part2Options: string[];
    /** 5 options for Part 3 — on-screen sale text over Scene 2,
     *  shown only. ≤10 words each. Deal + urgency + CTA. */
    part3Options: string[];
  };

  /** Exact 5-tag UK block (or US equivalent) including #aigc. */
  hashtags: string[];

  /** Short, sayable product name used across all copy. e.g.
   *  "Ninja CREAMi Deluxe", not the full listing title. */
  productShortName: string;

  /** Discount % the copy is built around. Copied verbatim from the
   *  input; null when no discount was supplied. */
  discountPercent: number | null;

  /** "UK" | "US". Drives basket vs. cart wording + which
   *  retailer library the LLM pulled from. */
  market: "UK" | "US";
}

/**
 * Parse a JSON-string Style1Kit into the typed shape. Returns null
 * on malformed input rather than throwing so consumers can render a
 * "regenerate" affordance instead of blowing up the page.
 *
 * Tolerant on missing fields — an older row where the LLM returned
 * a partial payload still parses; missing arrays default to empty.
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
  const scene1 = coerceScene1(r.scene1);
  const scene2 = coerceScene2(r.scene2);
  const copy = coerceCopy(r.copy);
  const hashtags = coerceStringArray(r.hashtags);
  const productShortName = typeof r.productShortName === "string"
    ? r.productShortName
    : "";
  const discountPercent =
    typeof r.discountPercent === "number" && Number.isFinite(r.discountPercent)
      ? Math.round(r.discountPercent)
      : null;
  const market: "UK" | "US" = r.market === "US" ? "US" : "UK";

  // Minimum shape check — need at least both scenes' image prompts
  // and at least one option per copy part for the page to render
  // anything useful. If those are missing the kit is unusable.
  if (!scene1.imagePrompt || !scene2.imagePrompt) return null;
  if (copy.part1Options.length === 0) return null;

  return {
    scene1,
    scene2,
    copy,
    hashtags,
    productShortName,
    discountPercent,
    market,
  };
}

function coerceScene1(v: unknown): Style1Scene1 {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    imagePrompt: typeof o.imagePrompt === "string" ? o.imagePrompt : "",
    motionPrompt: typeof o.motionPrompt === "string" ? o.motionPrompt : "",
    retailerName: typeof o.retailerName === "string" ? o.retailerName : "",
  };
}

function coerceScene2(v: unknown): Style1Scene2 {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    imagePrompt: typeof o.imagePrompt === "string" ? o.imagePrompt : "",
    motionPrompt: typeof o.motionPrompt === "string" ? o.motionPrompt : "",
    setting: typeof o.setting === "string" ? o.setting : "",
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
 * Compose the "Flow agent prompt" — a single paste-into-Flow-agent
 * conversation that produces both scenes end-to-end with a
 * pick-best-of-2 checkpoint in the middle.
 *
 * The wrapper is deterministic (no LLM call). It bakes in:
 *   - The universal preface (upload ref image, Veo 3.1 Lite,
 *     9:16, 1 output).
 *   - The LLM-picked scene prompts (already have product noun
 *     + retailer + setting substituted).
 *   - The 2-stage stop-and-wait structure so the operator picks
 *     one store variation + one home variation before any video
 *     generates.
 *   - The Stage 2 motion prompts, verbatim from the Style 1 SOP.
 *   - Explicit "no speech / no music / no text overlays / no
 *     faces" constraints so the operator doesn't have to remember
 *     them each time.
 *
 * Used by /prompts + /mobile-posting as the PRIMARY copy-paste
 * artefact — one button copies this whole thing and drops the
 * operator into Flow's agent chat. The 4 individual prompts in
 * the kit remain available as a "one prompt at a time" fallback.
 */
export function buildFlowAgentPrompt(kit: Style1Kit): string {
  return `Before pasting: upload the Kalodata product image as the reference. Settings — Veo 3.1 Lite · 9:16 · 1 output (no faces, no speech in these clips, so there's no reason to pay Omni Flash rates).

We are making one TikTok "store discovery" video. Work in TWO STAGES and stop between them.

Use the referenced product image as the exact product reference for everything. The product must stay identical and true to size in every image and every clip — no warping of the product or its label, no invented text, no redrawn branding.

In every image and clip: no price tags, no watermarks, no shoppers, no people's faces. Hands and forearms only.

═══════════════════════════════════════
STAGE 1 — DO THIS NOW
═══════════════════════════════════════
Create 4 still images, 9:16 vertical, one output each. Two variations of each scene so I can pick the cleaner one.

IMAGES 1 and 2 — two variations of:
${kit.scene1.imagePrompt}

IMAGES 3 and 4 — two variations of:
${kit.scene2.imagePrompt}

THEN STOP. Show me all four and wait. Do not generate any video until I reply with the two image numbers I want.

═══════════════════════════════════════
STAGE 2 — ONLY AFTER I REPLY
═══════════════════════════════════════
I will reply with two numbers, e.g. "1 and 3". The first is the store scene, the second is the home scene. Animate each chosen image into an 8-second vertical 9:16 clip with Veo 3.1 Lite, one output each, using the image as the FIRST FRAME.

STORE CLIP —
${kit.scene1.motionPrompt}

HOME CLIP —
${kit.scene2.motionPrompt}

NO SPEECH, no voices, no music in either clip — the voiceover is added later in CapCut. Quiet ambient sound only: soft shop background for the store clip, quiet room tone for the home clip.

No text on screen in either clip.`;
}
