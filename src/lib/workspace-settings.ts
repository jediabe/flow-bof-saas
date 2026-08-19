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
import {
  DEFAULT_FLOW_IMAGE_MODEL,
  DEFAULT_FLOW_VIDEO_MODEL,
} from "@/lib/content-runs/constants";

export const ALLOWED_FLOW_IMAGE_MODELS = [DEFAULT_FLOW_IMAGE_MODEL] as const;
export const ALLOWED_FLOW_VIDEO_MODELS = [DEFAULT_FLOW_VIDEO_MODEL] as const;

export interface ServerFlowDefaults {
  imageModel: string;
  videoModel: string;
  flowAccountConfigured: boolean;
  imageModelAllowed: boolean;
  videoModelAllowed: boolean;
}

type FlowSettingsRow = {
  flowEmail?: string | null;
  flowImageModel?: string | null;
  flowVideoModel?: string | null;
};

/**
 * Return only the managed Flow configuration needed by server-side domain
 * services. The account email itself is deliberately reduced to a boolean.
 */
export function toServerFlowDefaults(row: FlowSettingsRow | null): ServerFlowDefaults {
  const imageModel = row?.flowImageModel?.trim() || DEFAULT_FLOW_IMAGE_MODEL;
  const videoModel = row?.flowVideoModel?.trim() || DEFAULT_FLOW_VIDEO_MODEL;
  return {
    imageModel,
    videoModel,
    flowAccountConfigured: Boolean(row?.flowEmail?.trim()),
    imageModelAllowed: (ALLOWED_FLOW_IMAGE_MODELS as readonly string[]).includes(imageModel),
    videoModelAllowed: (ALLOWED_FLOW_VIDEO_MODELS as readonly string[]).includes(videoModel),
  };
}

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
    openaiApiKey:           row.openaiApiKey,
    openaiModel:            row.openaiModel,
    anthropicApiKey:        row.anthropicApiKey,
    anthropicModel:         row.anthropicModel,
    openrouterApiKey:       row.openrouterApiKey,
    openrouterModel:        row.openrouterModel,
    openrouterSiteUrl:      row.openrouterSiteUrl,
    openrouterAppName:      row.openrouterAppName,
    ukSystemPromptOverride: row.ukSystemPromptOverride,
    usSystemPromptOverride: row.usSystemPromptOverride,
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
