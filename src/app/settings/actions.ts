"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import {
  loadOrCreateSettings,
  toServerSettings,
  toMaskedSettings,
  type MaskedAiProviderSettings,
} from "@/lib/workspace-settings";
import { testProvider } from "@/lib/ai/providers";
import { KNOWN_PROVIDERS, type AiProviderKey } from "@/lib/ai/types";

/**
 * Return the masked settings projection for the Settings page form.
 * Keys come back as `****abcd` previews + a `keySet` boolean — never
 * the full value. Safe to render in a client component.
 */
export async function getMaskedAiSettings(): Promise<MaskedAiProviderSettings> {
  const { workspace } = await getCurrentWorkspace();
  const row = await loadOrCreateSettings(workspace.id);
  return toMaskedSettings(row);
}

/**
 * Persist a settings update from the form. The form posts every
 * field, but API key fields use a sentinel:
 *
 *   - empty string  → "leave unchanged" (the masked input was blank)
 *   - "__CLEAR__"   → wipe the stored key
 *   - any other     → store verbatim (new key)
 *
 * That way we never have to round-trip the secret to the client just
 * to round it back to the server.
 */
export async function saveAiSettings(formData: FormData): Promise<{
  ok: boolean;
  message: string;
}> {
  const { workspace } = await getCurrentWorkspace();
  const row = await loadOrCreateSettings(workspace.id);

  const rawProvider = String(formData.get("aiProvider") || "manual")
    .trim()
    .toLowerCase();
  const provider: AiProviderKey = (KNOWN_PROVIDERS as string[]).includes(
    rawProvider,
  )
    ? (rawProvider as AiProviderKey)
    : "manual";

  const data: Record<string, string | null> = {
    aiProvider: provider,
  };

  // Models + non-secret fields: empty string clears, other value
  // overwrites. We treat "" as "clear" here since the user can't
  // accidentally erase a key (those use the sentinel).
  const setOrClear = (form: string, db: string) => {
    const v = String(formData.get(form) ?? "").trim();
    data[db] = v || null;
  };
  setOrClear("openaiModel",       "openaiModel");
  setOrClear("anthropicModel",    "anthropicModel");
  setOrClear("openrouterModel",   "openrouterModel");
  setOrClear("openrouterSiteUrl", "openrouterSiteUrl");
  setOrClear("openrouterAppName", "openrouterAppName");

  const applyKey = (formField: string, dbField: keyof typeof row) => {
    const raw = formData.get(formField);
    if (raw === null || raw === undefined) return; // not in form, leave alone
    const v = String(raw);
    if (v === "") return; // blank → leave unchanged
    if (v === "__CLEAR__") {
      data[dbField as string] = null;
      return;
    }
    data[dbField as string] = v.trim();
  };
  applyKey("openaiApiKey",     "openaiApiKey");
  applyKey("anthropicApiKey",  "anthropicApiKey");
  applyKey("openrouterApiKey", "openrouterApiKey");

  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data,
  });
  revalidatePath("/settings");
  return { ok: true, message: "Settings saved." };
}

/**
 * Toggle the workspace's IP risk screening on / off. Kept separate
 * from saveAiSettings so the AI-providers form doesn't have to
 * round-trip the IP risk checkbox every time someone saves keys.
 *
 * Returns void so it can be passed directly as a `<form action>`.
 * The revalidatePath reflects the new state in the UI.
 */
export async function setIpRiskChecksEnabled(formData: FormData): Promise<void> {
  const { workspace } = await getCurrentWorkspace();
  await loadOrCreateSettings(workspace.id);
  const enabled = formData.get("enabled") === "on";
  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data: { ipRiskChecksEnabled: enabled },
  });
  revalidatePath("/settings");
  revalidatePath("/batches", "layout");
}

/**
 * Persist a workspace-level override for the UK and/or US AI image
 * system prompt. Empty / whitespace-only fields clear the override
 * (the bundled default kicks back in). Kept separate from
 * saveAiSettings so the AI-providers form doesn't round-trip the
 * (potentially very large) prompt text every time someone saves keys.
 */
export async function saveAiPrompts(formData: FormData): Promise<void> {
  const { workspace } = await getCurrentWorkspace();
  await loadOrCreateSettings(workspace.id);

  // Empty input = "use bundled default" → store null. Trim
  // whitespace so a textarea full of newlines doesn't silently
  // override the prompt with blank.
  const normalise = (v: FormDataEntryValue | null): string | null => {
    const t = String(v ?? "").trim();
    return t.length > 0 ? t : null;
  };

  const uk = normalise(formData.get("ukSystemPromptOverride"));
  const us = normalise(formData.get("usSystemPromptOverride"));

  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data: {
      ukSystemPromptOverride: uk,
      usSystemPromptOverride: us,
    },
  });
  revalidatePath("/settings");
  revalidatePath("/batches", "layout");
}

/**
 * Persist anti-block settings: daily image-gen submit cap and the
 * cooldown duration in hours. Validates ranges so a typo in the
 * form can't disable the safeguard entirely (cap=0 would mean no
 * jobs ever dispatch; we silently raise it to 10 instead).
 */
export async function saveAntiBlockSettings(formData: FormData): Promise<void> {
  const { workspace } = await getCurrentWorkspace();
  await loadOrCreateSettings(workspace.id);

  const capRaw = Number(formData.get("dailyImageSubmitCap") ?? 50);
  const cooldownRaw = Number(formData.get("cooldownHours") ?? 4);

  const cap = Number.isFinite(capRaw) ? Math.round(capRaw) : 50;
  const cooldown = Number.isFinite(cooldownRaw) ? Math.round(cooldownRaw) : 4;

  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data: {
      dailyImageSubmitCap: Math.max(10, Math.min(500, cap)),
      cooldownHours: Math.max(1, Math.min(48, cooldown)),
    },
  });
  revalidatePath("/settings");
  revalidatePath("/batches", "layout");
}

/**
 * Manually clear the unusual-activity cooldown. The user uses this
 * after they've warmed the account back up (used Flow by hand,
 * generated 1-2 manually, browsed for a while) and want to resume
 * automated batches without waiting the full cooldown window.
 */
export async function clearUnusualActivityCooldown(): Promise<void> {
  const { workspace } = await getCurrentWorkspace();
  await loadOrCreateSettings(workspace.id);
  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data: {
      lastUnusualActivityAt: null,
      lastUnusualActivityReason: null,
    },
  });
  revalidatePath("/settings");
  revalidatePath("/batches", "layout");
}

/**
 * Verify the configured provider responds. Uses the *currently saved*
 * settings — call saveAiSettings first if you want to test newly-typed
 * values.
 *
 * Caveat: testing OpenAI / Anthropic / OpenRouter costs ~20 tokens.
 * Manual is free.
 */
export async function testAiProviderAction(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { workspace } = await getCurrentWorkspace();
  const row = await loadOrCreateSettings(workspace.id);
  return await testProvider(toServerSettings(row));
}

/* ------------------------------------------------------------------
 * Workspace API token — programmatic access from external scripts.
 *
 * Currently powers the flow-bof-automation cookie fetcher
 * (scripts/fetch_tiktok_cookies.py) which POSTs freshly-captured
 * TikTok Shop cookies to /api/tiktok-accounts/add. Any future
 * workspace-scoped programmatic surface uses the same token.
 *
 * Rotate freely — generating a new token silently invalidates the
 * previous one. There is NO way to display an old token; the raw
 * string is returned exactly once on generate and never again
 * (mirrors GitHub PAT / Vercel token UX).
 * ---------------------------------------------------------------- */

const API_TOKEN_BYTES = 32;

/** Mint a fresh workspace API token and persist it. Returns the raw
 *  string ONCE — caller must save it immediately, it will not be
 *  recoverable from the server after this call. */
export async function generateWorkspaceApiToken(): Promise<{
  ok: boolean;
  token?: string;
  message?: string;
}> {
  const { workspace } = await getCurrentWorkspace();
  // Retry a few times on the vanishingly unlikely unique-collision.
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = await mintTokenString();
    try {
      await db.workspace.update({
        where: { id: workspace.id },
        data:  { apiToken: raw },
      });
      revalidatePath("/settings");
      return { ok: true, token: raw };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "P2002") throw err;
      continue;
    }
  }
  return {
    ok: false,
    message: "Could not allocate a unique token after 4 attempts. Try again.",
  };
}

/** Nuke the current token without generating a new one. External
 *  scripts using it stop working immediately. */
export async function revokeWorkspaceApiToken(): Promise<{ ok: boolean }> {
  const { workspace } = await getCurrentWorkspace();
  await db.workspace.update({
    where: { id: workspace.id },
    data:  { apiToken: null },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/** Just tell the page whether a token is set, WITHOUT returning the
 *  raw string. The generate/rotate flow shows the raw string; every
 *  subsequent load just says "set" or "not set". */
export async function getWorkspaceApiTokenStatus(): Promise<{
  hasToken: boolean;
}> {
  const { workspace } = await getCurrentWorkspace();
  const w = await db.workspace.findUnique({
    where: { id: workspace.id },
    select: { apiToken: true },
  });
  return { hasToken: !!w?.apiToken };
}

/** Node crypto → URL-safe base64 token. */
async function mintTokenString(): Promise<string> {
  const { randomBytes } = await import("node:crypto");
  return randomBytes(API_TOKEN_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* ------------------------------------------------------------------
 * ElevenLabs voice references (Style 1)
 *
 * The operator does a one-time voice-design step in ElevenLabs
 * (see the "Create Your Custom AI Voice" section of the Loom
 * Library PDF) and pastes the resulting voice ID + a friendly
 * label here. No ElevenLabs API integration — the settings are
 * pure UX plumbing so the mobile-posting page can render "paste
 * the script into voice: <label> (<id>)" per market.
 *
 * Empty-string save clears the field (Prisma nulls it). Trimmed
 * to strip accidental whitespace when copy-pasting from
 * ElevenLabs.
 * ---------------------------------------------------------------- */

export interface WorkspaceVoiceSettings {
  ukVoiceId: string | null;
  ukVoiceLabel: string | null;
  usVoiceId: string | null;
  usVoiceLabel: string | null;
}

export async function getWorkspaceVoiceSettings(): Promise<WorkspaceVoiceSettings> {
  const { workspace } = await getCurrentWorkspace();
  const row = await loadOrCreateSettings(workspace.id);
  return {
    ukVoiceId:    row.elevenLabsVoiceIdUk    ?? null,
    ukVoiceLabel: row.elevenLabsVoiceLabelUk ?? null,
    usVoiceId:    row.elevenLabsVoiceIdUs    ?? null,
    usVoiceLabel: row.elevenLabsVoiceLabelUs ?? null,
  };
}

/**
 * Save the per-market voice ID + friendly label. Both are trimmed;
 * empty strings clear the corresponding field. Never validates the
 * ID against ElevenLabs — the operator is source-of-truth for what
 * their real voice ID is, and we deliberately don't hit their API.
 */
export async function saveWorkspaceVoiceSettings(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const { workspace } = await getCurrentWorkspace();
  const norm = (v: FormDataEntryValue | null): string | null => {
    const s = String(v ?? "").trim();
    return s.length > 0 ? s : null;
  };
  const ukId    = norm(formData.get("ukVoiceId"));
  const ukLabel = norm(formData.get("ukVoiceLabel"));
  const usId    = norm(formData.get("usVoiceId"));
  const usLabel = norm(formData.get("usVoiceLabel"));

  await loadOrCreateSettings(workspace.id);
  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data: {
      elevenLabsVoiceIdUk:    ukId,
      elevenLabsVoiceLabelUk: ukLabel,
      elevenLabsVoiceIdUs:    usId,
      elevenLabsVoiceLabelUs: usLabel,
    },
  });
  revalidatePath("/settings");
  return { ok: true, message: "Voice settings saved." };
}

/* ------------------------------------------------------------------
 * CapCut template URL (Style 1)
 *
 * Store the operator's shared CapCut template link that pre-bakes
 * all the styling (music, hook text style, sale text style, caption
 * preset, timing). The mobile posting page renders it as a big
 * "Open CapCut template" button per product so assembly drops to
 * fill-in-the-blanks.
 *
 * Pure UX plumbing — no CapCut API integration. The operator
 * maintains the template in their own CapCut account and updates
 * the URL here if they rebuild the template.
 * ---------------------------------------------------------------- */

export async function getWorkspaceCapCutTemplateUrl(): Promise<{
  url: string | null;
}> {
  const { workspace } = await getCurrentWorkspace();
  const row = await loadOrCreateSettings(workspace.id);
  return { url: row.capCutTemplateUrl ?? null };
}

export async function saveWorkspaceCapCutTemplateUrl(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const { workspace } = await getCurrentWorkspace();
  const raw = String(formData.get("capCutTemplateUrl") ?? "").trim();
  // Basic URL sanity — reject non-http(s) so we don't render a
  // <a href> pointing at a javascript: or file: URI. Empty string
  // clears the field.
  let toSave: string | null = null;
  if (raw.length > 0) {
    if (!/^https?:\/\//i.test(raw)) {
      return {
        ok: false,
        message: "Template URL must start with https:// (or http://).",
      };
    }
    toSave = raw;
  }
  await loadOrCreateSettings(workspace.id);
  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data:  { capCutTemplateUrl: toSave },
  });
  revalidatePath("/settings");
  return {
    ok: true,
    message: toSave ? "CapCut template URL saved." : "CapCut template URL cleared.",
  };
}

/* ------------------------------------------------------------------
 * Google Flow account (via APEX MCP)
 *
 * Onboarding for the useapi.net-backed video generation. Operator
 * uploads a Google-Flow-session cookie blob captured from their
 * browser DevTools; we forward to the MCP server's /admin/accounts
 * which validates against Google, opens the session, and returns the
 * connected email. We persist the email on WorkspaceSettings.flowEmail
 * — from then on it's the flow_email claim on every JWT the app
 * mints for MCP tool calls.
 *
 * Cookies themselves are NEVER persisted here (or by the MCP). The
 * server discards them after handshake; useapi.net owns the refresh
 * cycle from that point.
 * ---------------------------------------------------------------- */

export interface GoogleFlowStatus {
  /** True when a flowEmail is persisted for this workspace. */
  connected: boolean;
  /** The connected Google Flow account email (or null when not yet
   *  connected). */
  email: string | null;
  /** Health as reported by useapi.net: "OK" | ... others. Only
   *  populated when connected AND the MCP status call succeeded. */
  health: string | null;
  /** True when health === "OK". Convenience flag for the UI. */
  healthy: boolean;
  /** Live-check error message when the status call itself failed
   *  (MCP down, credentials mismatch, etc). Distinct from `health`
   *  which is a semantic state reported by a successful status call. */
  liveError: string | null;
}

export async function getGoogleFlowAccountStatus(): Promise<GoogleFlowStatus> {
  const { workspace } = await getCurrentWorkspace();
  const row = await loadOrCreateSettings(workspace.id);
  const email = row.flowEmail?.trim() || null;
  if (!email) {
    return {
      connected: false,
      email: null,
      health: null,
      healthy: false,
      liveError: null,
    };
  }
  // Live-check the account against the MCP — catches broken
  // sessions (596 upstream) before the operator hits them mid-
  // generation.
  try {
    const { mcpGetAccountStatus } = await import("@/lib/apex-mcp");
    const status = await mcpGetAccountStatus(email);
    return {
      connected: true,
      email,
      health: status.health,
      healthy: status.healthy,
      liveError: null,
    };
  } catch (err) {
    const { ApexMcpError } = await import("@/lib/apex-mcp");
    const message =
      err instanceof ApexMcpError
        ? `${err.status || "?"} · ${err.message}`
        : (err as Error).message || "unknown MCP error";
    return {
      connected: true,
      email,
      health: null,
      healthy: false,
      liveError: message.slice(0, 300),
    };
  }
}

export async function connectGoogleFlowAccount(
  formData: FormData,
): Promise<{ ok: boolean; message: string; email?: string }> {
  const cookies = String(formData.get("cookies") ?? "").trim();
  if (cookies.length < 50) {
    return {
      ok: false,
      message:
        "Paste the full cookie table (tab-separated) copied from DevTools on accounts.google.com — the field looks empty or too short.",
    };
  }
  const { workspace } = await getCurrentWorkspace();
  try {
    const { mcpConnectGoogleFlowAccount } = await import("@/lib/apex-mcp");
    const resp = await mcpConnectGoogleFlowAccount({ cookies });
    if (!resp.email) {
      return {
        ok: false,
        message:
          "MCP accepted the cookies but didn't return an email. Check the MCP logs — this is unexpected.",
      };
    }
    await loadOrCreateSettings(workspace.id);
    await db.workspaceSettings.update({
      where: { workspaceId: workspace.id },
      data:  { flowEmail: resp.email },
    });
    revalidatePath("/settings");
    return {
      ok: true,
      message: `Connected ${resp.email} (health: ${resp.health}).`,
      email: resp.email,
    };
  } catch (err) {
    const { ApexMcpError } = await import("@/lib/apex-mcp");
    if (err instanceof ApexMcpError) {
      // The MCP maps upstream 400 to a specific "invalid_cookies"
      // code — surface a helpful message pointing at the most
      // common cause (missed 2FA "don't ask again" checkbox).
      if (err.code === "invalid_cookies") {
        return {
          ok: false,
          message:
            "Google rejected those cookies. Common causes: the 2FA \"Don't ask again on this device\" checkbox wasn't ticked when signing in, or the cookies came from the wrong domain (must be accounts.google.com). Re-capture and retry.",
        };
      }
      return {
        ok: false,
        message: `MCP returned ${err.status || "?"}: ${err.message}`,
      };
    }
    return {
      ok: false,
      message: `Connect failed: ${(err as Error).message.slice(0, 300)}`,
    };
  }
}

export async function disconnectGoogleFlowAccount(): Promise<{
  ok: boolean;
  message: string;
}> {
  const { workspace } = await getCurrentWorkspace();
  const row = await loadOrCreateSettings(workspace.id);
  const email = row.flowEmail?.trim();
  if (!email) {
    return { ok: false, message: "No Google Flow account is connected." };
  }
  // Try the MCP delete, but don't block clearing the local flowEmail
  // even if the remote delete fails — the operator's intent is to
  // stop using this account here. Log the remote failure so it's
  // visible in docker logs; local state is what matters for the UI.
  try {
    const { mcpDisconnectGoogleFlowAccount } = await import("@/lib/apex-mcp");
    await mcpDisconnectGoogleFlowAccount(email);
  } catch (err) {
    console.warn(
      `[settings] MCP disconnect for ${email} threw, clearing local flowEmail anyway:`,
      err,
    );
  }
  await db.workspaceSettings.update({
    where: { workspaceId: workspace.id },
    data:  { flowEmail: null },
  });
  revalidatePath("/settings");
  return {
    ok: true,
    message: `Disconnected ${email}. Re-connect via the panel when you're ready.`,
  };
}
