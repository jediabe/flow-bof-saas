/**
 * AI output extraction + validation. Ported from
 * flow-bof-automation/ai/prompt_generator.py:extract_json +
 * validate_ai_output, plus a small `normaliseAiOutput` step that maps
 * the LLM's snake_case keys onto the SaaS's camelCase AiPromptOutput
 * shape.
 *
 * The provider modules call extractJson() on the model's reply, then
 * normaliseAiOutput() to shape it. The bulk runner consumes only
 * AiPromptOutput.
 */

import type { AiPromptOutput, ProductPromptInput } from "./types";

// ---------------------------------------------------------------------
// JSON extraction — tolerant of three common LLM emission patterns.
// ---------------------------------------------------------------------

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i;

/**
 * Pull a JSON object out of a model response. Handles:
 *   1. Pure JSON.
 *   2. JSON wrapped in ```json … ``` fences.
 *   3. JSON embedded inside commentary (takes the first {…} block).
 *
 * Throws on real failure. Message is short and safe to render in the UI.
 */
export function extractJson(text: string): unknown {
  const t = (text ?? "").trim();
  if (!t) throw new Error("Empty response from model");

  // Code fence first — strips ```json ... ``` if present.
  const m = FENCE_RE.exec(t);
  if (m) {
    try {
      return JSON.parse(m[1].trim());
    } catch {
      // fall through to next strategy
    }
  }

  // Direct parse.
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }

  // First-to-last brace fallback. Handy when models prepend prose.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(t.slice(first, last + 1));
  }

  throw new Error("No JSON object found in model reply");
}

// ---------------------------------------------------------------------
// Normalisation — LLM snake_case → SaaS camelCase, plus tolerant casts.
// ---------------------------------------------------------------------

/**
 * Coerce a "hashtags" value that arrived as a string into a string[].
 * Accepts space-, comma-, or newline-separated tag lists. Returns
 * `undefined` if nothing usable remains so the caller can drop the
 * field rather than store an empty array.
 */
function coerceHashtags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const cleaned = value
      .map((v) => String(v ?? "").trim())
      .filter((v) => v.length > 0);
    return cleaned.length ? cleaned : undefined;
  }
  if (typeof value === "string") {
    const parts = value
      .split(/[\s,]+/g)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts.length ? parts : undefined;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Shape a parsed model response into the SaaS's standard
 * AiPromptOutput. Fills in retailerName from the original input when
 * the model omitted it; that lets the manual deterministic fallback
 * keep the user's pre-chosen retailer instead of defaulting it.
 *
 * Throws if the response is missing a usable imagePrompt — the only
 * field we can't synthesize ourselves.
 */
export function normaliseAiOutput(
  data: unknown,
  input: ProductPromptInput,
): AiPromptOutput {
  if (!data || typeof data !== "object") {
    throw new Error("AI response is not a JSON object");
  }
  const r = data as Record<string, unknown>;

  // The LLM uses snake_case per the system prompt; tolerate camelCase
  // too in case a stricter provider auto-renames.
  const imagePrompt = asString(r.image_prompt ?? r.imagePrompt);
  if (!imagePrompt) {
    throw new Error("AI response missing image_prompt");
  }

  const retailerName =
    asString(r.store_environment ?? r.retailerName ?? r.retailer_name) ||
    input.retailerName ||
    "UK retail store";

  const hook    = asString(r.hook) || undefined;
  const caption = asString(r.caption) || undefined;
  const hashtags = coerceHashtags(r.hashtags);

  return {
    retailerName,
    imagePrompt,
    hook,
    caption,
    hashtags,
    productName: asString(r.product_name) || input.productName,
    category:    asString(r.category) || input.category || undefined,
    videoPrompt: asString(r.video_prompt) || undefined,
    warnings: Array.isArray(r.warnings)
      ? r.warnings.map((w) => String(w ?? "")).filter(Boolean)
      : undefined,
  };
}

/**
 * Validate an AiPromptOutput before persisting. Returns the list of
 * problems found — empty list means "ok". The caller decides whether
 * to refuse to write or just surface a warning.
 *
 * Today we only enforce imagePrompt being a non-empty string;
 * everything else is optional. Adjust as the schema firms up.
 */
export function validatePromptOutput(out: AiPromptOutput): string[] {
  const problems: string[] = [];
  if (!out.imagePrompt || !out.imagePrompt.trim()) {
    problems.push("imagePrompt is empty");
  }
  if (typeof out.retailerName !== "string" || !out.retailerName.trim()) {
    problems.push("retailerName is empty");
  }
  if (out.hashtags && !Array.isArray(out.hashtags)) {
    problems.push("hashtags is not an array");
  }
  return problems;
}

/** Mask an API key for display. "sk-…abcd" / "" → "" / "*****abcd". */
export function maskApiKey(key: string | null | undefined): string {
  const k = (key ?? "").trim();
  if (!k) return "";
  if (k.length <= 4) return "****";
  return `****${k.slice(-4)}`;
}
