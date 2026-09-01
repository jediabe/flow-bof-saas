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
 * Coerce a "hook_variants" value into our typed shape. Tolerates:
 *   - Array of {label, text, lever_name?} (the spec shape)
 *   - Array of plain strings (model returned a flat list without
 *     labels — we synthesise positional labels v1/v2/…)
 *   - Object with label keys ({A1: "...", A2: "..."}) — flattened
 *
 * Returns undefined when nothing usable comes back so the caller
 * can preserve back-compat with single-hook responses.
 */
function coerceHookVariants(
  value: unknown,
):
  | Array<{ label: string; text: string; leverName?: string }>
  | undefined {
  const collect: Array<{ label: string; text: string; leverName?: string }> =
    [];

  function pushEntry(label: string, text: unknown, leverName?: unknown) {
    const t = asString(text);
    const l = asString(label) || `v${collect.length + 1}`;
    if (!t) return;
    const ln = asString(leverName);
    collect.push({ label: l, text: t, ...(ln ? { leverName: ln } : {}) });
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const obj = entry as Record<string, unknown>;
        pushEntry(
          (obj.label ?? obj.template ?? obj.lever ?? "") as string,
          obj.text ?? obj.hook ?? "",
          (obj.lever_name ?? obj.leverName) as string | undefined,
        );
      } else if (typeof entry === "string") {
        pushEntry(`v${collect.length + 1}`, entry);
      }
    }
  } else if (value && typeof value === "object") {
    for (const [label, text] of Object.entries(
      value as Record<string, unknown>,
    )) {
      pushEntry(label, text);
    }
  }

  return collect.length > 0 ? collect : undefined;
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

  // Detect Style 1 (Store Discovery) response shape — post-pivot
  // (2026-08). The load-bearing Style 1 signal is `copy.part1Options`:
  // a non-empty array under `copy` (or `copy_options` / `copy.parts`
  // in some model outputs). Every other Style 1 field has a sensible
  // fallback in normaliseStyle1Output — productName falls back to
  // input.productName, category falls back to input.category — so
  // insisting they be present at the top level in the ORIGINAL shape
  // dropped otherwise-good Style 1 responses onto the legacy path
  // and left Product.style1Kit null. The "generated before Style 1"
  // banner then appears on cards whose LLM output was actually a
  // valid Style 1 kit but happened to emit product_name (snake) or
  // omit category. Detector now mirrors normaliseStyle1Output's own
  // tolerance so any response with the load-bearing shape lands on
  // the Style 1 fast path.
  const copyObj =
    r.copy && typeof r.copy === "object" ? (r.copy as Record<string, unknown>) : null;
  const part1CandidateArray =
    (copyObj &&
      (Array.isArray(copyObj.part1Options) && copyObj.part1Options) ||
      (copyObj && Array.isArray(copyObj.part1_options) && copyObj.part1_options)) ||
    null;
  const hasCopyPart1 = Array.isArray(part1CandidateArray) && part1CandidateArray.length > 0;
  // Belt-and-braces: also accept the shape when top-level names are
  // present without the copy.part1Options signal, in case a future
  // response shape lands with the extraction fields but a different
  // copy container. Kept as a permissive OR so we never regress the
  // "Style 1 recognised" path from what it was pre-fix.
  const hasStyle1TopLevel =
    (typeof r.productName === "string" || typeof r.product_name === "string") &&
    !!copyObj;
  const looksLikeStyle1 = hasCopyPart1 || hasStyle1TopLevel;

  if (looksLikeStyle1) {
    return normaliseStyle1Output(r, input);
  }

  // ---- Legacy path (US, manual fallback, older UK responses) ----

  // The LLM uses snake_case per the system prompt; tolerate camelCase
  // too in case a stricter provider auto-renames.
  const imagePrompt = asString(r.image_prompt ?? r.imagePrompt);
  if (!imagePrompt) {
    throw new Error("AI response missing image_prompt");
  }

  // Default the "did the model say nothing?" fallback by market.
  // UK previous behaviour was "UK retail store"; US should land on
  // a non-named description.
  const fallbackRetailer =
    input.market === "us" ? "American retail store" : "UK retail store";

  const retailerName =
    asString(
      r.store_environment ??
      r.retail_environment ??
      r.retailerName ??
      r.retailer_name,
    ) ||
    input.retailerName ||
    fallbackRetailer;

  // PART 4 of the v0.7 spec adds two new fields. retail_environment
  // is the human-readable phrase (US workflow only — UK doesn't emit
  // this key today). product_description is the posting-assist blurb.
  const retailEnvironment =
    asString(r.retail_environment ?? r.store_environment) || undefined;
  const productDescription =
    asString(r.product_description ?? r.productDescription) || undefined;

  const hookVariants = coerceHookVariants(r.hook_variants ?? r.hookVariants);
  // Single-hook field stays populated for back-compat: prefer the
  // first variant when the AI returned a list, fall back to the
  // legacy `hook` string when that's all we got (older prompts).
  const hook =
    hookVariants && hookVariants.length > 0
      ? hookVariants[0].text
      : asString(r.hook) || undefined;
  const caption = asString(r.caption) || undefined;
  const hashtags = coerceHashtags(r.hashtags);

  return {
    retailerName,
    retailEnvironment,
    imagePrompt,
    hook,
    hookVariants,
    caption,
    hashtags,
    productDescription,
    productName: asString(r.product_name) || input.productName,
    category:    asString(r.category) || input.category || undefined,
    videoPrompt: asString(r.video_prompt) || undefined,
    warnings: Array.isArray(r.warnings)
      ? r.warnings.map((w) => String(w ?? "")).filter(Boolean)
      : undefined,
  };
}

/**
 * Style 1 (Store Discovery) response normaliser — post-pivot shape
 * (2026-08). Called by normaliseAiOutput when the raw payload
 * matches the extraction-plus-copy shape.
 *
 * Populates:
 *  - `style1KitJson` : the raw kit stringified for storage on
 *                       Product.style1Kit — this is what the
 *                       desktop /prompts modal + mobile posting
 *                       page render from.
 *  - `imagePrompt`   : a placeholder line ("(Style 1 — Flow
 *                       prompts generated externally)") so the
 *                       legacy batches/prompts-hub `imagePrompt`
 *                       requirement is satisfied even though Flow
 *                       scenes now live in the user's external
 *                       Google Flow tool.
 *  - `hook`          : copy.part1Options[0] for back-compat.
 *  - `caption`       : productDescription (short line for TikTok
 *                       caption above the hashtags).
 *  - `hashtags`      : kit hashtags verbatim.
 *  - `productName`   : the cleaned name from Agent A.
 *  - `category`      : the enum pick from Agent A.
 *  - `warnings`      : whatever the LLM surfaced.
 *
 * No more retailerName / videoPrompt fields — those went with the
 * scene prompts.
 */
function normaliseStyle1Output(
  r: Record<string, unknown>,
  input: ProductPromptInput,
): AiPromptOutput {
  const copy = (r.copy as Record<string, unknown>) || {};

  const productName = asString(r.productName ?? r.product_name) ||
    input.productName;
  const category = asString(r.category) || input.category || "";
  const productDescription =
    asString(r.productDescription ?? r.product_description) || undefined;

  const part1 = coerceStringArray(copy.part1Options ?? copy.part1_options);
  const hashtags = coerceHashtags(r.hashtags);

  if (!productName) {
    throw new Error("Style 1 response missing productName");
  }
  if (part1.length === 0) {
    throw new Error("Style 1 response missing copy.part1Options");
  }

  // Serialize the raw kit for storage. We re-JSON to strip any
  // fields we didn't ask for and to normalise casing.
  const style1KitJson = JSON.stringify(r);

  return {
    // Flow scenes are external now — set a placeholder retailer +
    // imagePrompt so the AiPromptOutput contract (still required by
    // legacy prompts/batches pipelines) is satisfied. Nothing in
    // the Style 1 UI reads either field.
    retailerName: "(external Google Flow tool)",
    imagePrompt:
      "(Style 1 — Flow prompts are generated by the operator's external Google Flow tool from productName + market + category)",
    // Back-compat: the "chosen" hook a legacy consumer might read.
    // Style 1's real picker lives on the mobile-posting page.
    hook: part1[0] || undefined,
    caption: productDescription,
    hashtags,
    productDescription,
    style1KitJson,
    productName,
    category: category || undefined,
    warnings: Array.isArray(r.warnings)
      ? r.warnings.map((w) => String(w ?? "")).filter(Boolean)
      : undefined,
  };
}

/** Coerce a value into a trimmed string array, dropping non-strings
 *  and empties. Used for Style 1 part1/2/3 option arrays. */
function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
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
