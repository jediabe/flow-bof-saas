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

import { DEFAULT_MODELS, type AiProviderSettings } from "./types";
import { extractJson } from "./prompt-generator";
import {
  type IpRiskAssessment,
  type IpRiskStatus,
  IP_RISK_STATUSES,
  type ProductForRiskCheck,
} from "../ip-risk";

// ---------------------------------------------------------------------
// System prompt — verbatim spec language, with the hard "never say
// illegal" rule front-loaded.
// ---------------------------------------------------------------------

const IP_RISK_SYSTEM_PROMPT = `You are an IP/trademark risk screener
for TikTok Shop products on Google Flow.

You are NOT giving legal advice. You are identifying POTENTIAL
intellectual property, trademark, counterfeit, brand impersonation,
character / franchise, or platform-policy risk for content creation.
Be conservative. Lean toward "review" when in doubt.

Rules you MUST follow:
1. NEVER say a product is "illegal." Say "potential risk" and
   recommend manual review.
2. Generic compatibility products are LOW or MEDIUM risk, not high:
     - "case for iPhone", "screen protector for Samsung Galaxy",
       "charger compatible with AirPods" → low or medium.
   Only escalate to HIGH when the product uses brand logos, fake
   official packaging, or claims to be official/authentic/OEM
   without authorization.
3. Famous brand names (Nike, Gucci, Louis Vuitton, Apple, Disney,
   Pokémon, Stanley, Crocs, etc.) ALONE are usually HIGH risk,
   except in the compatibility case above.
4. Imitation phrases ("dupe", "1:1", "replica", "designer inspired",
   "knockoff", "clone") are STRONG HIGH-risk signals.
5. Character / franchise references (Disney, Marvel, Pokémon, Bluey,
   anime, sports teams) → HIGH.
6. Logo / pattern terms ("monogram", "designer pattern", "mascot",
   "copyrighted artwork") are at LEAST medium; HIGH when combined
   with a brand or character reference.
7. When signals are mixed or unclear → "needs_manual_review", not
   "low".

Return STRICT JSON only — no markdown code fence, no commentary,
nothing outside the JSON object. Use exactly these keys:

{
  "ipRiskStatus": "low" | "medium" | "high" | "needs_manual_review",
  "reasons": ["<short factual observations, not legal claims>"],
  "recommendation": "approve" | "review" | "reject",
  "notes": "<one short sentence summarising your verdict, plain language>"
}

Reasons should be factual observations, NOT legal determinations.
Examples of GOOD reasons:
  - "Title mentions 'designer inspired' which suggests imitation intent."
  - "Product name includes 'Pokémon' — protected franchise."
  - "Mentions 'compatible with iPhone' but does not claim Apple
    branding or affiliation."
Examples of BAD reasons (do not write these):
  - "This is counterfeit and illegal."
  - "Violates trademark law."

If you cannot find any meaningful risk signal, return:
  status="low", reasons=[], recommendation="approve", notes="No
  obvious brand or IP signals in the supplied text."`;

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
