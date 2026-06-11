/**
 * AI provider clients. One thin transport wrapper per provider; all
 * of them speak the same UK_SYSTEM_PROMPT + ProductPromptInput in,
 * AiPromptOutput out.
 *
 * Each provider gets credentials and model from the
 * AiProviderSettings argument — never from process.env. That means a
 * future Phase-5 multi-tenant build can call them with per-workspace
 * credentials and the only thing that changes is the row Prisma
 * returns.
 *
 * Keys are never logged. Tests / generate failures surface a short
 * `${type}: ${message}` string; never the request headers.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "node:buffer";

import {
  DEFAULT_MODELS,
  type AiMarket,
  type AiPromptOutput,
  type AiProviderSettings,
  type ProductPromptInput,
} from "./types";
import {
  UK_SYSTEM_PROMPT,
  formatUserPrompt as formatUkUserPrompt,
} from "./uk-retail-prompts";
import {
  US_SYSTEM_PROMPT,
  formatUserPrompt as formatUsUserPrompt,
} from "./us-retail-prompts";
import { buildUkRetailPrompt } from "../uk-retailers";
import { buildUsRetailPrompt, findUsEnvironment } from "../us-retailers";
import { extractJson, normaliseAiOutput } from "./prompt-generator";

/**
 * Pick the system prompt + user-prompt formatter for the market on
 * the input. Defaults to UK when unset for back-compat.
 *
 * Honours per-workspace overrides on AiProviderSettings — if the
 * operator has typed a custom prompt into Settings → AI Image
 * Prompts, that wins over the bundled constant. Whitespace-only
 * overrides are treated as "not set" so an accidentally-blanked
 * textarea doesn't silently feed an empty system prompt to the AI.
 */
function templateForMarket(
  market: AiMarket | undefined,
  settings?: AiProviderSettings,
): {
  systemPrompt: string;
  formatUserPrompt: (p: ProductPromptInput) => string;
} {
  const ukOverride = (settings?.ukSystemPromptOverride ?? "").trim();
  const usOverride = (settings?.usSystemPromptOverride ?? "").trim();
  if (market === "us") {
    return {
      systemPrompt: usOverride || US_SYSTEM_PROMPT,
      formatUserPrompt: formatUsUserPrompt,
    };
  }
  return {
    systemPrompt: ukOverride || UK_SYSTEM_PROMPT,
    formatUserPrompt: formatUkUserPrompt,
  };
}

// Internal: tiny per-product call result. Providers throw on transport
// errors; the bulk runner wraps the throw in a per-product entry.
export interface ProviderCallResult {
  output: AiPromptOutput;
  /** Whether we hit the network. False for manual. */
  remote: boolean;
}

// ---------------------------------------------------------------------
// Manual / deterministic fallback
// ---------------------------------------------------------------------

/**
 * Deterministic market-aware prompt — no network call, no API key.
 * Picks the UK or US retail catalogue based on input.market, then
 * delegates to that catalogue's prompt builder. Output matches the
 * shape every other provider returns (minus the AI-only fields:
 * hook / caption / hashtags / productDescription stay undefined
 * because there's no model to synthesise them).
 */
export function manualGenerate(
  input: ProductPromptInput,
): ProviderCallResult {
  if (input.market === "us") {
    const { prompt, envKey } = buildUsRetailPrompt({
      productName: input.productName,
      category:    input.category,
      retailerName: input.retailerName,
    });
    return {
      remote: false,
      output: {
        retailerName:      envKey,
        // The 2026-06-05 framework renamed the catalogue's `phrase`
        // field to `storeType` (the noun that fits "inside a modern
        // [STORE TYPE]"). retailEnvironment carries that for the
        // SaaS to surface as a chip + on the posting-assist page.
        retailEnvironment: findUsEnvironment(envKey).storeType ?? undefined,
        imagePrompt:       prompt,
        hook:              undefined,
        caption:           undefined,
        hashtags:          undefined,
        productDescription: undefined,
      },
    };
  }
  const { prompt, retailerKey } = buildUkRetailPrompt({
    productName: input.productName,
    category:    input.category,
    retailerName: input.retailerName,
  });
  return {
    remote: false,
    output: {
      retailerName: retailerKey,
      imagePrompt:  prompt,
      hook:         undefined,
      caption:      undefined,
      hashtags:     undefined,
    },
  };
}

// ---------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------

export async function openaiGenerate(
  input: ProductPromptInput,
  settings: AiProviderSettings,
): Promise<ProviderCallResult> {
  const apiKey = (settings.openaiApiKey ?? "").trim();
  if (!apiKey) throw new Error("OpenAI API key is empty.");

  const model = (settings.openaiModel || "").trim() || DEFAULT_MODELS.openai;
  const client = new OpenAI({ apiKey });

  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market, settings);
  const resp = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: formatUserPrompt(input) },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return { remote: true, output: normaliseAiOutput(extractJson(content), input) };
}

// ---------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------

export async function anthropicGenerate(
  input: ProductPromptInput,
  settings: AiProviderSettings,
): Promise<ProviderCallResult> {
  const apiKey = (settings.anthropicApiKey ?? "").trim();
  if (!apiKey) throw new Error("Anthropic API key is empty.");

  const model =
    (settings.anthropicModel || "").trim() || DEFAULT_MODELS.anthropic;
  const client = new Anthropic({ apiKey });

  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market, settings);
  const message = await client.messages.create({
    model,
    max_tokens: 2048,
    temperature: 0.4,
    // Anthropic has no native JSON mode; the system prompt already
    // demands strict JSON, but we double-reinforce.
    system: systemPrompt + "\n\nReturn JSON only. No markdown.",
    messages: [{ role: "user", content: formatUserPrompt(input) }],
  });
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return { remote: true, output: normaliseAiOutput(extractJson(text), input) };
}

// ---------------------------------------------------------------------
// OpenRouter — OpenAI-compatible HTTPS at openrouter.ai
// ---------------------------------------------------------------------

export async function openrouterGenerate(
  input: ProductPromptInput,
  settings: AiProviderSettings,
): Promise<ProviderCallResult> {
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
    defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
  });

  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market, settings);
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt + "\n\nReturn JSON only." },
      { role: "user",   content: formatUserPrompt(input) },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return { remote: true, output: normaliseAiOutput(extractJson(content), input) };
}

// ---------------------------------------------------------------------
// Provider test ping — small payload, just verifies the key + model.
// Returns a short message safe to render. Never leaks the key.
// ---------------------------------------------------------------------

const TEST_USER = `Return strict JSON only: {"ok": true}. No commentary, no prose, no markdown.`;

export async function testProvider(
  settings: AiProviderSettings,
): Promise<{ ok: boolean; message: string }> {
  try {
    switch (settings.provider) {
      case "manual":
        return { ok: true, message: "Manual provider — no API key required." };
      case "openai": {
        const apiKey = (settings.openaiApiKey ?? "").trim();
        if (!apiKey) return { ok: false, message: "OpenAI API key is empty." };
        const model =
          (settings.openaiModel || "").trim() || DEFAULT_MODELS.openai;
        const client = new OpenAI({ apiKey });
        const r = await client.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 20,
          messages: [{ role: "user", content: TEST_USER }],
        });
        const text = (r.choices?.[0]?.message?.content ?? "").trim();
        return { ok: true, message: `OK (model ${model}). Reply: ${text.slice(0, 60)}` };
      }
      case "anthropic": {
        const apiKey = (settings.anthropicApiKey ?? "").trim();
        if (!apiKey) return { ok: false, message: "Anthropic API key is empty." };
        const model =
          (settings.anthropicModel || "").trim() || DEFAULT_MODELS.anthropic;
        const client = new Anthropic({ apiKey });
        const m = await client.messages.create({
          model,
          max_tokens: 30,
          messages: [{ role: "user", content: TEST_USER }],
        });
        const text = m.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();
        return { ok: true, message: `OK (model ${model}). Reply: ${text.slice(0, 60)}` };
      }
      case "openrouter": {
        const apiKey = (settings.openrouterApiKey ?? "").trim();
        if (!apiKey)
          return { ok: false, message: "OpenRouter API key is empty." };
        const model =
          (settings.openrouterModel || "").trim() || DEFAULT_MODELS.openrouter;
        const client = new OpenAI({
          apiKey,
          baseURL: "https://openrouter.ai/api/v1",
        });
        const r = await client.chat.completions.create({
          model,
          temperature: 0,
          max_tokens: 20,
          messages: [{ role: "user", content: TEST_USER }],
        });
        const text = (r.choices?.[0]?.message?.content ?? "").trim();
        const note =
          (settings.openrouterModel || "").trim()
            ? ""
            : " (using openrouter/auto — set a specific model to lock it)";
        return { ok: true, message: `OK (model ${model})${note}. Reply: ${text.slice(0, 60)}` };
      }
      default:
        return { ok: false, message: `Unknown provider: ${settings.provider}` };
    }
  } catch (err) {
    const e = err as Error;
    // Don't include err.stack — it can carry header fragments.
    return {
      ok: false,
      message: `${e.name}: ${String(e.message ?? e).slice(0, 200)}`,
    };
  }
}

/**
 * Dispatch one call against whichever provider the settings select.
 * Returns the normalised AiPromptOutput; throws on transport failure
 * so the bulk runner can record a per-product error.
 *
 * Phase 9.5+ — `options.useVision`: when true AND
 * `input.referenceImageUrl` is a fetchable absolute URL AND the
 * provider isn't "manual", the AI receives the product image
 * alongside the text. Lets the model describe specific visible
 * details (exact colors, branding placement, hardware, packaging
 * copy) in the image_prompt instead of guessing from the product
 * name. Falls back to text-only when vision can't be used.
 */
export async function callProvider(
  input: ProductPromptInput,
  settings: AiProviderSettings,
  options: { useVision?: boolean } = {},
): Promise<ProviderCallResult> {
  const wantVision =
    options.useVision === true &&
    typeof input.referenceImageUrl === "string" &&
    input.referenceImageUrl.length > 0 &&
    settings.provider !== "manual";
  switch (settings.provider) {
    case "manual":     return manualGenerate(input);
    case "openai":
      return wantVision
        ? await openaiGenerateVision(input, settings)
        : await openaiGenerate(input, settings);
    case "anthropic":
      return wantVision
        ? await anthropicGenerateVision(input, settings)
        : await anthropicGenerate(input, settings);
    case "openrouter":
      return wantVision
        ? await openrouterGenerateVision(input, settings)
        : await openrouterGenerate(input, settings);
  }
  // Exhaustive switch above; this is unreachable but keeps tsc happy.
  throw new Error(`Unknown AI provider: ${(settings as AiProviderSettings).provider}`);
}

// ---------------------------------------------------------------------
// Vision-enabled provider variants
// ---------------------------------------------------------------------
//
// Each one mirrors its text-only sibling but appends a vision
// addendum to the system prompt and includes the product's
// reference image in the user message. The AI is instructed to
// describe specific visible details (colors, materials, branding
// placement, hardware) so the image_prompt is faithful to what's
// actually in the reference instead of guessing from the product
// name alone.
//
// Failures throw — caller catches and maps to a per-product error.
// We do NOT silently fall back to text-only here; the caller has
// the option-flag context to decide whether to retry without
// vision.

const VISION_PROMPT_ADDENDUM = `

============================================================
VISION ANALYSIS — REFERENCE IMAGE ATTACHED
============================================================
You can see the product's reference image. The image model
(Nano Banana Pro) also sees this reference and uses it as the
authoritative source for the product's visual details. Your
job is NOT to translate the reference into a text description
— that fights the reference and the image model will rebuild
from your text instead of matching the actual product.

Use vision to do exactly three things:

  1. Identify the product TYPE correctly (e.g. "a 4L portable
     cooler" not "a cooler"; "a pair of wide-leg joggers" not
     "joggers"). This anchors the right silhouette.

  2. Spot anything TRICKY the image model would likely get
     wrong without explicit guidance — unusual handle/hinge
     placement, asymmetric lid, non-obvious orientation, a
     part the reference shows that the image-gen prior would
     omit. Call this out in ONE sentence in the image_prompt.

  3. Spot any VISIBLE LETTERING on the product or packaging
     (brand wordmarks, model numbers, package copy). When
     present, include the "Preserve any visible lettering..."
     sentence. Lettering is the detail Nano Banana Pro is
     most likely to invent or misspell, so this matters.

DO NOT write a long description of colors, shades, materials,
textures, hardware, or proportions. The reference image
carries those.`;

export async function openaiGenerateVision(
  input: ProductPromptInput,
  settings: AiProviderSettings,
): Promise<ProviderCallResult> {
  const apiKey = (settings.openaiApiKey ?? "").trim();
  if (!apiKey) throw new Error("OpenAI API key is empty.");
  if (!input.referenceImageUrl) {
    throw new Error("Reference image URL required for vision generation.");
  }
  const model = (settings.openaiModel || "").trim() || DEFAULT_MODELS.openai;
  const client = new OpenAI({ apiKey });
  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market, settings);
  const resp = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt + VISION_PROMPT_ADDENDUM },
      {
        role: "user",
        content: [
          { type: "text", text: formatUserPrompt(input) },
          {
            type: "image_url",
            image_url: { url: input.referenceImageUrl },
          },
        ],
      },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return { remote: true, output: normaliseAiOutput(extractJson(content), input) };
}

export async function anthropicGenerateVision(
  input: ProductPromptInput,
  settings: AiProviderSettings,
): Promise<ProviderCallResult> {
  const apiKey = (settings.anthropicApiKey ?? "").trim();
  if (!apiKey) throw new Error("Anthropic API key is empty.");
  if (!input.referenceImageUrl) {
    throw new Error("Reference image URL required for vision generation.");
  }
  const model =
    (settings.anthropicModel || "").trim() || DEFAULT_MODELS.anthropic;
  const client = new Anthropic({ apiKey });
  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market, settings);

  // Anthropic doesn't accept raw URLs — fetch + base64-encode the
  // image first. Same helper shape Phase 9 vision uses.
  const { data, mediaType } = await _fetchImageForAnthropic(
    input.referenceImageUrl,
  );

  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    temperature: 0.4,
    system: systemPrompt + VISION_PROMPT_ADDENDUM + "\n\nReturn JSON only. No markdown.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data },
          },
          { type: "text", text: formatUserPrompt(input) },
        ],
      },
    ],
  });
  const text = message.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  return { remote: true, output: normaliseAiOutput(extractJson(text), input) };
}

export async function openrouterGenerateVision(
  input: ProductPromptInput,
  settings: AiProviderSettings,
): Promise<ProviderCallResult> {
  const apiKey = (settings.openrouterApiKey ?? "").trim();
  if (!apiKey) throw new Error("OpenRouter API key is empty.");
  if (!input.referenceImageUrl) {
    throw new Error("Reference image URL required for vision generation.");
  }
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
  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market, settings);
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      {
        role: "system",
        content:
          systemPrompt + VISION_PROMPT_ADDENDUM + "\n\nReturn JSON only.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: formatUserPrompt(input) },
          {
            type: "image_url",
            image_url: { url: input.referenceImageUrl },
          },
        ],
      },
    ],
  });
  const content = resp.choices?.[0]?.message?.content ?? "";
  return { remote: true, output: normaliseAiOutput(extractJson(content), input) };
}

/** Anthropic-only helper: fetch a public URL → base64 + media-type
 *  triple. Mirrors the Phase 9 vision helper but lives here so the
 *  prompt-generator path doesn't depend on the IP-risk module. */
async function _fetchImageForAnthropic(url: string): Promise<{
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Reference image fetch failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  const ct = (resp.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ct.startsWith("image/")) {
    throw new Error(
      `Reference image fetch returned non-image content-type: ${ct || "?"}`,
    );
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const MAX = 8 * 1024 * 1024;
  if (buf.byteLength > MAX) {
    throw new Error(`Reference image too large (${buf.byteLength} bytes).`);
  }
  const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
  const mediaType = (
    allowed.includes(ct as (typeof allowed)[number]) ? ct : "image/jpeg"
  ) as (typeof allowed)[number];
  return { data: buf.toString("base64"), mediaType };
}
