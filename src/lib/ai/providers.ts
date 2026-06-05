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
 */
function templateForMarket(
  market: AiMarket | undefined,
): {
  systemPrompt: string;
  formatUserPrompt: (p: ProductPromptInput) => string;
} {
  if (market === "us") {
    return {
      systemPrompt: US_SYSTEM_PROMPT,
      formatUserPrompt: formatUsUserPrompt,
    };
  }
  return {
    systemPrompt: UK_SYSTEM_PROMPT,
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
        retailEnvironment: findUsEnvironment(envKey).phrase ?? undefined,
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

  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market);
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

  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market);
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

  const { systemPrompt, formatUserPrompt } = templateForMarket(input.market);
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
 */
export async function callProvider(
  input: ProductPromptInput,
  settings: AiProviderSettings,
): Promise<ProviderCallResult> {
  switch (settings.provider) {
    case "manual":     return manualGenerate(input);
    case "openai":     return await openaiGenerate(input, settings);
    case "anthropic":  return await anthropicGenerate(input, settings);
    case "openrouter": return await openrouterGenerate(input, settings);
  }
  // Exhaustive switch above; this is unreachable but keeps tsc happy.
  throw new Error(`Unknown AI provider: ${(settings as AiProviderSettings).provider}`);
}
