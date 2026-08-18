/**
 * AI-assisted IP / trademark risk check.
 *
 * Companion to the deterministic heuristic in lib/ip-risk.ts. Same
 * input contract (a product's text fields), same output verdict
 * shape (IpRiskAssessment). The two are merged via mergeIpRisk()
 * with "higher score wins" semantics, so the AI verdict can only
 * ESCALATE risk over the heuristic — never reduce it.
 *
 * Trigger contract: this runs ONLY when the user explicitly clicks
 * "Run AI risk check" (per-product or batch-level). It is NEVER
 * fired automatically by the Kalodata importer or by scheduled
 * jobs — the user pays per call.
 *
 * Privacy contract (from the Phase 9 memory):
 *   - The model receives only product text fields (name, title,
 *     category, description, tiktokUrl).
 *   - NEVER sends: API keys, runner tokens, workspace cookies, or
 *     anything else the workspace has stored. callProvider here
 *     constructs its OWN request from scratch — same as
 *     providers.ts.
 *
 * Messaging contract:
 *   - System prompt is explicit: NOT legal advice; never says
 *     "illegal"; says "potential risk" and recommends manual
 *     review.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
// Behavior-preserving extraction — see src/lib/media/fetch-image.ts
// module doc for the details this used to carry inline.
import { fetchImageAsBase64 } from "@/lib/media/fetch-image";

import { DEFAULT_MODELS, type AiProviderSettings } from "./types";
import { extractJson } from "./prompt-generator";
import {
  type IpRiskAssessment,
  type IpRiskStatus,
  IP_RISK_STATUSES,
  type ProductForRiskCheck,
} from "../ip-risk";
import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------
// System prompt — verbatim spec language, with the hard "never say
// illegal" rule front-loaded.
// ---------------------------------------------------------------------

const IP_RISK_SYSTEM_PROMPT = `You are a COUNTERFEIT / brand-
impersonation screener for TikTok Shop product listings on Google
Flow.

You are NOT a generic "brand mention" detector. Most products on
TikTok Shop that mention a brand are LEGITIMATE: the brand's own
direct listings, authorized retailers, licensed sellers, or
compatibility accessories. Flagging every brand mention as risky
produces useless false positives.

Your job is to identify the MINORITY of listings that show CLEAR
signs of:

  - **Counterfeit** — fake "authentic"/"OEM" claims, "1:1 replica",
    "mirror quality", "dupe", "knockoff", "designer inspired",
    "unbranded version of <brand>" language.
  - **Typosquatting** — deliberately misspelled brand names like
    "Nikee" for Nike, "Adiidas" for Adidas, "Apel" for Apple,
    "Eufii" for Eufy. Legitimate brand sellers spell the brand
    correctly.
  - **Brand impersonation** — logos, monograms, or trade dress of a
    famous brand (LV pattern bag, Gucci-pattern shirt) from a
    seller with no apparent brand authorization.
  - **Protected character / franchise use** — Pokémon, Disney
    characters, Marvel, Hello Kitty, anime franchises, sports
    teams — used by a seller that's clearly not the IP holder or
    licensee.

CRITICAL RULES — read carefully:

1. **NEVER say a product is "illegal."** Say "potential risk" and
   recommend manual review.

2. **A brand-name mention alone is NOT a counterfeit signal.**
   Most branded listings on TikTok Shop are legitimate. Examples
   that should be LOW (NOT high, NOT needs_manual_review):
     - "Eufy Security Video Doorbell E340" — Eufy is owned by
       Anker; this is the legitimate product listing.
     - "Apple iPhone 15 Pro Max Case (Genuine Apple MagSafe)" —
       Apple-branded accessory listing.
     - "Sony WH-1000XM5 Wireless Headphones" — exact product name.
     - "Stanley 30oz Quencher H2.0 Tumbler" — exact product name.
     - "LEGO Star Wars Millennium Falcon" — exact LEGO product.
   None of those are counterfeit signals. Mark them LOW.

3. **Compatibility / accessory products are LOW.** Examples:
     - "Phone case compatible with iPhone 15"
     - "Screen protector for Samsung Galaxy S24"
     - "Replacement charger for Sony PlayStation 5"
     - "Strap for Apple Watch Series 9"

4. **HIGH requires an actual counterfeit/impersonation signal.**
   Examples that ARE HIGH:
     - "1:1 Mirror Replica AJ1 Sneakers" — explicit counterfeit
       language.
     - "Designer Inspired LV Monogram Tote Bag" — imitation
       + logo + brand.
     - "Nikee Air Max" / "Adiidas Originals" — typosquatting.
     - "OEM Brand Apple AirPods Pro" — false-official claim.
     - "Authentic Replica Rolex Watch" — internally contradictory
       counterfeit language.
     - "Hello Kitty Plush from Generic Toy Co." — unauthorized
       character use.

5. **MEDIUM is for soft signals worth a manual look** — multiple
   brand mentions, designer-pattern terms without clear brand
   impersonation, ambiguous descriptions. Don't reach for HIGH
   unless you'd bet money it's counterfeit.

6. **Brand ownership matters.** Many brands are subsidiaries of
   each other. Anker owns Eufy + Soundcore. Apple owns Beats.
   Procter & Gamble owns many beauty brands. Don't flag a product
   as suspicious just because the brand name doesn't match what
   you'd expect — assume legitimate cross-brand listings exist.

7. **Default to LOW when uncertain.** Reserving HIGH for clear
   counterfeit signals reduces false positives and keeps the
   screening tool useful. When in doubt, MEDIUM or
   needs_manual_review — never HIGH on a hunch.

OUTPUT — return STRICT JSON only, no markdown fence:

{
  "ipRiskStatus": "low" | "medium" | "high" | "needs_manual_review",
  "reasons": ["<short factual observations, not legal claims>"],
  "recommendation": "approve" | "review" | "reject",
  "notes": "<one short sentence summarising your verdict>"
}

GOOD reasons (specific, observation-based):
  - "Title uses 'Nikee', a 1-letter misspelling of Nike —
    typosquatting signal."
  - "Title includes '1:1 Mirror Replica' — explicit counterfeit
    language."
  - "Mentions 'Hello Kitty' protected Sanrio character; seller name
    in the data does not appear to be Sanrio or a licensed reseller."

BAD reasons (do not write these):
  - "This is counterfeit and illegal."
  - "Mentions Apple — manual review recommended." (way too
    aggressive; Apple-branded TikTok listings are usually
    legitimate.)
  - "Branded product listing — manual review recommended." (this
    flags every legitimate listing; the system would be useless.)
  - "<Brand> is a registered trademark of <holder>; manual review
    recommended." (trademark status alone is not a risk signal.)

If you cannot find ANY counterfeit / impersonation signal, return:
  status="low", reasons=[], recommendation="approve",
  notes="No counterfeit or impersonation signals; appears to be a
  legitimate product listing."`;

// ---------------------------------------------------------------------
// User-prompt formatter — keep it tight; the model only needs the
// product text fields. We deliberately do NOT include image URLs or
// reference image data: this is a text-based heuristic for now.
// Vision-assisted checks are a future enhancement (per the spec's
// PART 6 note).
// ---------------------------------------------------------------------

function formatIpRiskUserPrompt(input: ProductForRiskCheck): string {
  const v = (x: string | null | undefined) =>
    (x ?? "").toString().trim() || "(none)";
  return [
    `Product Name: ${v(input.productName) || "(unknown)"}`,
    `Original Title: ${v(input.originalTitle)}`,
    `Category: ${v(input.category)}`,
    `TikTok URL: ${v(input.tiktokUrl)}`,
    `Description: ${v(input.description)}`,
    "",
    "Assess IP/trademark risk per the system rules.",
    "Return the JSON now. No prose, no markdown, JSON only.",
  ].join("\n");
}

// ---------------------------------------------------------------------
// JSON normalisation — coerce the model's reply into a clean
// IpRiskAssessment. Defends against models that return numbers,
// extra keys, or slightly wrong status spellings.
// ---------------------------------------------------------------------

const STATUS_SCORE: Record<IpRiskStatus, number> = {
  unchecked:           0,
  low:                 0,
  medium:              50,
  needs_manual_review: 65,
  high:                85,
};

function coerceStatus(raw: unknown): IpRiskStatus {
  if (typeof raw !== "string") return "needs_manual_review";
  const norm = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (IP_RISK_STATUSES.has(norm as IpRiskStatus)) {
    return norm as IpRiskStatus;
  }
  // Loose-spell aliases the model might emit.
  if (norm === "needs_review" || norm === "review" || norm === "manual_review") {
    return "needs_manual_review";
  }
  if (norm === "ok" || norm === "safe") return "low";
  if (norm === "warn" || norm === "warning" || norm === "moderate") return "medium";
  if (norm === "dangerous" || norm === "block" || norm === "infringing") {
    return "high";
  }
  return "needs_manual_review";
}

function coerceReasons(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((r) => typeof r === "string")
      .map((r) => (r as string).trim())
      .filter(Boolean)
      .slice(0, 12);
  }
  if (typeof raw === "string" && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

function coerceRecommendation(
  raw: unknown,
  fallback: IpRiskAssessment["recommendation"],
): IpRiskAssessment["recommendation"] {
  if (raw === "approve" || raw === "review" || raw === "reject") return raw;
  return fallback;
}

function normaliseAiVerdict(raw: unknown): IpRiskAssessment {
  if (!raw || typeof raw !== "object") {
    return {
      status: "needs_manual_review",
      score: STATUS_SCORE.needs_manual_review,
      reasons: ["AI response was empty or unparseable; manual review required."],
      matchedTerms: [],
      recommendation: "review",
    };
  }
  const obj = raw as Record<string, unknown>;
  const status = coerceStatus(obj.ipRiskStatus ?? obj.status);
  const reasons = coerceReasons(obj.reasons);
  const notes =
    typeof obj.notes === "string" && obj.notes.trim()
      ? [`AI summary: ${obj.notes.trim()}`]
      : [];
  const recommendation = coerceRecommendation(
    obj.recommendation,
    status === "high"
      ? "reject"
      : status === "low"
        ? "approve"
        : "review",
  );
  return {
    status,
    score: STATUS_SCORE[status],
    reasons: [...reasons, ...notes],
    matchedTerms: [],
    recommendation,
  };
}

// ---------------------------------------------------------------------
// Provider clients
// ---------------------------------------------------------------------

interface AiRiskCallResult {
  verdict: IpRiskAssessment;
  provider: "openai" | "anthropic" | "openrouter";
  model: string;
}

async function openaiIpRisk(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
): Promise<AiRiskCallResult> {
  const apiKey = (settings.openaiApiKey ?? "").trim();
  if (!apiKey) throw new Error("OpenAI API key is empty.");
  const model = (settings.openaiModel || "").trim() || DEFAULT_MODELS.openai;
  const client = new OpenAI({ apiKey });
  const resp = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: IP_RISK_SYSTEM_PROMPT },
      { role: "user", content: formatIpRiskUserPrompt(input) },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return {
    verdict: normaliseAiVerdict(extractJson(content)),
    provider: "openai",
    model,
  };
}

async function anthropicIpRisk(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
): Promise<AiRiskCallResult> {
  const apiKey = (settings.anthropicApiKey ?? "").trim();
  if (!apiKey) throw new Error("Anthropic API key is empty.");
  const model =
    (settings.anthropicModel || "").trim() || DEFAULT_MODELS.anthropic;
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    temperature: 0.2,
    system: IP_RISK_SYSTEM_PROMPT + "\n\nReturn JSON only. No markdown.",
    messages: [{ role: "user", content: formatIpRiskUserPrompt(input) }],
  });
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return {
    verdict: normaliseAiVerdict(extractJson(text)),
    provider: "anthropic",
    model,
  };
}

async function openrouterIpRisk(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
): Promise<AiRiskCallResult> {
  const apiKey = (settings.openrouterApiKey ?? "").trim();
  if (!apiKey) throw new Error("OpenRouter API key is empty.");
  const model =
    (settings.openrouterModel || "").trim() || DEFAULT_MODELS.openrouter;
  const defaultHeaders: Record<string, string> = {};
  if (settings.openrouterSiteUrl)
    defaultHeaders["HTTP-Referer"] = settings.openrouterSiteUrl;
  if (settings.openrouterAppName)
    defaultHeaders["X-Title"] = settings.openrouterAppName;
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: Object.keys(defaultHeaders).length
      ? defaultHeaders
      : undefined,
  });
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: IP_RISK_SYSTEM_PROMPT + "\n\nReturn JSON only.",
      },
      { role: "user", content: formatIpRiskUserPrompt(input) },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return {
    verdict: normaliseAiVerdict(extractJson(content)),
    provider: "openrouter",
    model,
  };
}

/**
 * Public entry point — routes to the configured provider and
 * returns the verdict plus which provider/model handled it.
 *
 * Throws on transport errors. The caller catches and maps to a
 * per-product failure entry; no global error leaks API keys.
 *
 * Returns `null` (no throw) when the active provider is "manual"
 * — the heuristic is the only signal in that mode. Callers should
 * skip the merge step and just persist the heuristic verdict.
 */
export async function aiAssessIpRisk(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
): Promise<AiRiskCallResult | null> {
  switch (settings.provider) {
    case "manual":
      return null;
    case "openai":
      return openaiIpRisk(input, settings);
    case "anthropic":
      return anthropicIpRisk(input, settings);
    case "openrouter":
      return openrouterIpRisk(input, settings);
    default:
      throw new Error(`Unknown AI provider: ${settings.provider}`);
  }
}

// ---------------------------------------------------------------------
// Vision-assisted check
// ---------------------------------------------------------------------
//
// Pure-text screening misses the signals that matter most for
// counterfeit detection: actual logos on packaging, misspelled
// brand text on the product, generic-looking packaging that doesn't
// match the claimed brand, poor print quality consistent with
// counterfeits. Vision-capable AI models can read those.
//
// This entry point is opt-in (user clicks "with vision" in the UI)
// and ONLY runs when:
//   - A vision-capable provider is configured (OpenAI / Anthropic /
//     OpenRouter; manual provider returns null).
//   - The product has a reference image URL we can fetch.
//
// The verdict still passes through the merge function — vision can
// only ESCALATE the heuristic's verdict (higher score wins). A
// legitimate listing with a clean image stays LOW; a "Nikee Air Max"
// title whose image shows a real Nike logo + clean packaging
// stays MEDIUM/needs-review (the typosquat is suspicious but the
// image suggests genuine product, so we want manual review, not
// auto-reject).
//
// Privacy contract preserved: we send the product's text + the
// reference image URL (OpenAI/OpenRouter) or base64-encoded bytes
// (Anthropic). NEVER the API key, runner token, or workspace
// cookies.

const IP_RISK_VISION_SYSTEM_PROMPT = `You are a COUNTERFEIT / brand-
impersonation screener for TikTok Shop product listings. You have
access to both the product TITLE and the PRODUCT IMAGE.

Use the image to verify (or refute) the title's brand claims.
This is the most useful signal we have — most counterfeit products
look "off" in ways the text can't capture.

WHAT THE IMAGE TELLS YOU:

1. **Logo authenticity** — does the brand mark on the product /
   packaging match the real brand's logo? Counterfeits often have
   subtly wrong proportions, fonts, or colors. Authentic logos
   look like the brand's official marks. Examples:
   - Real Nike swoosh: clean curve, specific proportions.
   - Counterfeit Nike: slight asymmetry, wrong angle.
   - Real Apple logo: bite on right side, specific leaf shape.
   - Counterfeit Apple: missing leaf, wrong bite ratio.

2. **Text misspellings on the product or packaging** — this is
   one of the strongest signals. If the title says "Apple iPhone"
   but the image shows "Apel" or "Aplle" on the product, that's
   a CLEAR counterfeit signal.

3. **Packaging quality** — authentic brand packaging has
   consistent printing, accurate colors, professional layout.
   Counterfeits often show:
   - Slightly off colors
   - Pixellation / blurry logos
   - Wrong font weights
   - Generic-looking boxes
   - "Made in <wrong country>" labels (e.g., "Made in China" on a
     Stanley Cup that's actually US-made; minor signal — many
     brands manufacture overseas)

4. **Brand consistency** — does the image actually show the brand
   claimed in the title? A title claiming "Lego Star Wars" but
   showing a generic block set with no Lego logo is a strong
   counterfeit signal.

5. **Product category match** — does the visible product match the
   title? Photo of generic shoes captioned "Nike Air Jordan 1" =
   probably counterfeit if the swoosh / Jumpman logo is absent or
   wrong.

ALL THE TEXT-LAYER RULES STILL APPLY (you saw them in the
non-vision prompt — they're not repeated here, but: never say
"illegal", default LOW for legitimate listings, only HIGH on clear
counterfeit signals, brand mention alone is NOT a counterfeit
signal).

RULES SPECIFIC TO VISION:

- **A clean, professional product image of the named brand is a
  STRONG positive signal.** If the title says "Eufy Video
  Doorbell" and the image shows a clean Eufy product with the
  proper Eufy logo, this is a legitimate listing — mark LOW.
- **A clearly off / counterfeit-looking image is a STRONG negative
  signal.** Even if the title is innocent, an image with
  misspelled brand text or fake-looking logo = HIGH.
- **Image alone is rarely conclusive.** A blurry photo doesn't
  mean counterfeit (it might just be a bad seller photo). Weight
  the image WITH the text, not in isolation.
- **If the image doesn't clearly show the product** (placeholder,
  stock photo, screenshot, watermark-only) flag the verdict as
  needs_manual_review and explain in reasons.
- **If you can't see the image** for any reason, fall back to the
  text-only assessment and note that vision was unavailable in
  your reasons.

OUTPUT — same strict JSON as the text-only version:

{
  "ipRiskStatus": "low" | "medium" | "high" | "needs_manual_review",
  "reasons": ["<observations from text AND image>"],
  "recommendation": "approve" | "review" | "reject",
  "notes": "<one short sentence summarising your verdict>"
}

Prefix any image-derived observations with "[image]" so the user
can see which signals came from where:
  - "[image] Logo appears authentic — clean Eufy mark with
    correct font."
  - "[image] Packaging shows 'Adiidas' misspelling — strong
    counterfeit signal."
  - "[image] Generic-looking shoe with no visible Nike branding
    despite 'Nike Air Max' title."

If no counterfeit/impersonation signal in EITHER text or image:
  status="low", reasons=[], recommendation="approve",
  notes="No counterfeit or impersonation signals in text or
  image."`;

async function openaiIpRiskVision(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
  imageUrl: string,
): Promise<AiRiskCallResult> {
  const apiKey = (settings.openaiApiKey ?? "").trim();
  if (!apiKey) throw new Error("OpenAI API key is empty.");
  const model = (settings.openaiModel || "").trim() || DEFAULT_MODELS.openai;
  const client = new OpenAI({ apiKey });
  const resp = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: IP_RISK_VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: formatIpRiskUserPrompt(input) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return {
    verdict: normaliseAiVerdict(extractJson(content)),
    provider: "openai",
    model,
  };
}

async function anthropicIpRiskVision(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
  imageUrl: string,
): Promise<AiRiskCallResult> {
  const apiKey = (settings.anthropicApiKey ?? "").trim();
  if (!apiKey) throw new Error("Anthropic API key is empty.");
  const model =
    (settings.anthropicModel || "").trim() || DEFAULT_MODELS.anthropic;
  const client = new Anthropic({ apiKey });
  const { data, mediaType } = await fetchImageAsBase64(imageUrl);
  const message = await client.messages.create({
    model,
    max_tokens: 1024,
    temperature: 0.2,
    system: IP_RISK_VISION_SYSTEM_PROMPT + "\n\nReturn JSON only. No markdown.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          },
          { type: "text", text: formatIpRiskUserPrompt(input) },
        ],
      },
    ],
  });
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return {
    verdict: normaliseAiVerdict(extractJson(text)),
    provider: "anthropic",
    model,
  };
}

async function openrouterIpRiskVision(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
  imageUrl: string,
): Promise<AiRiskCallResult> {
  const apiKey = (settings.openrouterApiKey ?? "").trim();
  if (!apiKey) throw new Error("OpenRouter API key is empty.");
  const model =
    (settings.openrouterModel || "").trim() || DEFAULT_MODELS.openrouter;
  const defaultHeaders: Record<string, string> = {};
  if (settings.openrouterSiteUrl)
    defaultHeaders["HTTP-Referer"] = settings.openrouterSiteUrl;
  if (settings.openrouterAppName)
    defaultHeaders["X-Title"] = settings.openrouterAppName;
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: Object.keys(defaultHeaders).length
      ? defaultHeaders
      : undefined,
  });
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: IP_RISK_VISION_SYSTEM_PROMPT + "\n\nReturn JSON only.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: formatIpRiskUserPrompt(input) },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return {
    verdict: normaliseAiVerdict(extractJson(content)),
    provider: "openrouter",
    model,
  };
}

/**
 * Vision-assisted IP risk check. Same entry-point contract as
 * `aiAssessIpRisk` but uses a vision-capable model and sends the
 * reference image along with the product text.
 *
 * Returns `null` for the manual provider (no model to call).
 * Throws on transport errors — caller decides whether to fall
 * back to text-only or surface the failure.
 *
 * `imageUrl` MUST be absolute and publicly fetchable. The
 * SaaS-side `toAgentAssetUrl` helper turns `/uploads/...` paths
 * into the right shape.
 */
export async function aiAssessIpRiskWithVision(
  input: ProductForRiskCheck,
  settings: AiProviderSettings,
  imageUrl: string,
): Promise<AiRiskCallResult | null> {
  switch (settings.provider) {
    case "manual":
      return null;
    case "openai":
      return openaiIpRiskVision(input, settings, imageUrl);
    case "anthropic":
      return anthropicIpRiskVision(input, settings, imageUrl);
    case "openrouter":
      return openrouterIpRiskVision(input, settings, imageUrl);
    default:
      throw new Error(`Unknown AI provider: ${settings.provider}`);
  }
}
