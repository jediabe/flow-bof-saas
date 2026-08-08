/**
 * /generate — workspace-level LLM agent chat.
 *
 * Server component gate: loads the conversation list + the
 * currently-selected conversation (via ?c=<id> URL param), passes
 * them to GenerateClient. Chat state lives in URL so a browser
 * refresh preserves position.
 *
 * SCAFFOLD (Commit 3): messages persist, but no LLM turn fires
 * yet. Sending shows the user message and a placeholder
 * "assistant coming in Commit 4" state. Commit 4 adds the
 * Anthropic tool-use loop against the APEX MCP + our custom
 * tools; results attach to Products via Commit 7.
 */

import { getCurrentWorkspace } from "@/lib/workspace";
import { loadOrCreateSettings } from "@/lib/workspace-settings";
import GenerateClient from "./GenerateClient";
import {
  listConversations,
  getConversationDetail,
  type ConversationDetail,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function GeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}) {
  const { workspace } = await getCurrentWorkspace();
  const [conversations, settings, sp] = await Promise.all([
    listConversations(),
    loadOrCreateSettings(workspace.id),
    searchParams,
  ]);

  // Load the selected conversation on the server so first paint
  // has messages ready — no client-side "loading…" flash on the
  // most common path.
  let selected: ConversationDetail | null = null;
  const selectedId = sp.c?.trim();
  if (selectedId) {
    selected = await getConversationDetail(selectedId);
  }

  return (
    <GenerateClient
      initialConversations={conversations}
      initialSelected={selected}
      flowEmail={settings.flowEmail ?? null}
    />
  );
}
