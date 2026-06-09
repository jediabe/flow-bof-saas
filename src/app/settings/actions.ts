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
