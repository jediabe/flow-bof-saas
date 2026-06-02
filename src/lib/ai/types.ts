/**
 * Shared types for the AI prompt generation layer.
 *
 * One canonical shape for the input (a product) and the output (a
 * generated prompt bundle). Every provider produces this shape — that
 * way the calling code doesn't care whether the manual fallback,
 * OpenAI, Anthropic, or OpenRouter is selected.
 */

/** All supported AI provider keys. `manual` is the deterministic fallback. */
export type AiProviderKey = "manual" | "openai" | "anthropic" | "openrouter";

export const KNOWN_PROVIDERS: AiProviderKey[] = [
  "manual",
  "openai",
  "anthropic",
  "openrouter",
];

/** Default model for each remote provider — matches flow-bof-automation. */
export const DEFAULT_MODELS: Record<Exclude<AiProviderKey, "manual">, string> = {
  openai:     "gpt-4o-mini",
  anthropic:  "claude-3-5-sonnet-latest",
  openrouter: "openrouter/auto",
};

/** Server-side settings shape passed to providers. */
export interface AiProviderSettings {
  provider: AiProviderKey;
  openaiApiKey?:      string | null;
  openaiModel?:       string | null;
  anthropicApiKey?:   string | null;
  anthropicModel?:    string | null;
  openrouterApiKey?:  string | null;
  openrouterModel?:   string | null;
  openrouterSiteUrl?: string | null;
  openrouterAppName?: string | null;
}

/** Input to the prompt generator — one product worth of context. */
export interface ProductPromptInput {
  productName:        string;
  originalTitle?:     string | null;
  category?:          string | null;
  retailerName?:      string | null;
  tiktokUrl?:         string | null;
  notes?:             string | null;
  referenceImageUrl?: string | null;
}

/**
 * Standard output shape every provider returns. Mirrors the Python
 * SUPPORTED_OUTPUT_KEYS set so a workbook that went through the
 * Streamlit app and one that went through the SaaS produce the same
 * fields.
 *
 * `retailerName` is the SaaS-facing canonical retailer (matches the
 * Python `store_environment`) — kept under the SaaS-native field
 * name so it lines up with Product.retailerName without extra
 * mapping. The original `store_environment` arrives populated for
 * back-compat with old workbooks.
 */
export interface AiPromptOutput {
  retailerName: string;
  imagePrompt:  string;
  hook?:        string;
  caption?:     string;
  hashtags?:    string[];
  // Echoed-through fields, mostly used for debugging the provider's
  // reasoning. The SaaS doesn't render these but stores them on the
  // AI envelope for traceability.
  productName?: string;
  category?:    string;
  videoPrompt?: string;
  warnings?:    string[];
}

/** Mode the bulk-prompt action exposes. */
export type AiOverwriteMode = "missing" | "all";
