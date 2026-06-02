/**
 * Workspace settings helpers. Single source of truth for *loading*
 * the WorkspaceSettings row and projecting it onto the shapes the
 * client + server need.
 *
 * Two projection shapes:
 *   - `AiProviderSettings` (server-only) carries full API keys for
 *     use by the provider modules.
 *   - `MaskedAiProviderSettings` (safe-for-client) replaces every
 *     API key with a 4-character preview + a "set" boolean.
 */

import { db } from "@/lib/db";
import type {
  AiProviderKey,
  AiProviderSettings,
} from "@/lib/ai/types";
import {
  KNOWN_PROVIDERS,
  DEFAULT_MODELS,
} from "@/lib/ai/types";
import { maskApiKey } from "@/lib/ai/prompt-generator";

export interface MaskedAiProviderSettings {
  provider: AiProviderKey;
  openai: {
    model: string;
    keyPreview: string;
    keySet: boolean;
  };
  anthropic: {
    model: string;
    keyPreview: string;
    keySet: boolean;
  };
  openrouter: {
    model: string;
    siteUrl: string;
    appName: string;
    keyPreview: string;
    keySet: boolean;
  };
}

const KNOWN_SET = new Set<string>(KNOWN_PROVIDERS);

/** Load (or lazily create) the WorkspaceSettings row. Server-only. */
export async function loadOrCreateSettings(workspaceId: string) {
  const existing = await db.workspaceSettings.findUnique({
    where: { workspaceId },
  });
  if (existing) return existing;
  return await db.workspaceSettings.create({
    data: { workspaceId, aiProvider: "manual" },
  });
}

/**
 * Project a settings row onto the full server-side shape. Use this
 * only inside server actions / route handlers — never return it to
 * a client component.
 */
export function toServerSettings(
  row: Awaited<ReturnType<typeof loadOrCreateSettings>>,
): AiProviderSettings {
  const p = (row.aiProvider || "manual").toLowerCase();
  const provider: AiProviderKey = KNOWN_SET.has(p)
    ? (p as AiProviderKey)
    : "manual";
  return {
    provider,
    openaiApiKey:      row.openaiApiKey,
    openaiModel:       row.openaiModel,
    anthropicApiKey:   row.anthropicApiKey,
    anthropicModel:    row.anthropicModel,
    openrouterApiKey:  row.openrouterApiKey,
    openrouterModel:   row.openrouterModel,
    openrouterSiteUrl: row.openrouterSiteUrl,
    openrouterAppName: row.openrouterAppName,
  };
}

/**
 * Project a settings row onto the client-safe shape: every API key
 * becomes a 4-character masked preview + a `keySet` flag. Models +
 * non-secret fields pass through. Used by the Settings page form.
 */
export function toMaskedSettings(
  row: Awaited<ReturnType<typeof loadOrCreateSettings>>,
): MaskedAiProviderSettings {
  const p = (row.aiProvider || "manual").toLowerCase();
  const provider: AiProviderKey = KNOWN_SET.has(p)
    ? (p as AiProviderKey)
    : "manual";
  return {
    provider,
    openai: {
      model:      row.openaiModel || DEFAULT_MODELS.openai,
      keyPreview: maskApiKey(row.openaiApiKey),
      keySet:     !!(row.openaiApiKey ?? "").trim(),
    },
    anthropic: {
      model:      row.anthropicModel || DEFAULT_MODELS.anthropic,
      keyPreview: maskApiKey(row.anthropicApiKey),
      keySet:     !!(row.anthropicApiKey ?? "").trim(),
    },
    openrouter: {
      model:      row.openrouterModel || DEFAULT_MODELS.openrouter,
      siteUrl:    row.openrouterSiteUrl || "",
      appName:    row.openrouterAppName || "",
      keyPreview: maskApiKey(row.openrouterApiKey),
      keySet:     !!(row.openrouterApiKey ?? "").trim(),
    },
  };
}
