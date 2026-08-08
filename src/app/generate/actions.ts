"use server";

/**
 * /generate — server actions for the LLM agent chat.
 *
 * This file is the SCAFFOLD half (Commit 3): CRUD for conversations
 * + user-message persistence. Actually running the Anthropic tool-
 * use loop, calling MCP tools, streaming assistant responses over
 * SSE — that's Commit 4. Send actions in this file only persist
 * the user turn and return the conversation state; no assistant
 * response is generated yet.
 *
 * All actions are workspace-scoped via getCurrentWorkspace(). A
 * stolen conversationId can't leak cross-tenant.
 */

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";

/* ------------------------------------------------------------------
 * Types shared with the client
 * ---------------------------------------------------------------- */

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolResultJson: string | null;
  createdAt: string;
}

export interface ConversationDetail {
  ok: boolean;
  message?: string;
  id?: string;
  title?: string;
  messages?: ChatMessage[];
}

/* ------------------------------------------------------------------
 * List / read
 * ---------------------------------------------------------------- */

export async function listConversations(): Promise<ConversationSummary[]> {
  const { workspace } = await getCurrentWorkspace();
  const rows = await db.conversation.findMany({
    where: { workspaceId: workspace.id, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt.toISOString(),
    messageCount: r._count.messages,
  }));
}

export async function getConversationDetail(
  conversationId: string,
): Promise<ConversationDetail> {
  if (!conversationId) {
    return { ok: false, message: "missing conversationId" };
  }
  const { workspace } = await getCurrentWorkspace();
  const conv = await db.conversation.findFirst({
    where: {
      id: conversationId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!conv) return { ok: false, message: "conversation not found" };
  return {
    ok: true,
    id: conv.id,
    title: conv.title,
    messages: conv.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCallsJson: m.toolCallsJson,
      toolResultJson: m.toolResultJson,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------
 * Create / delete / rename
 * ---------------------------------------------------------------- */

export async function createConversation(input?: {
  title?: string;
}): Promise<{ ok: boolean; id?: string; message?: string }> {
  const { workspace } = await getCurrentWorkspace();
  const conv = await db.conversation.create({
    data: {
      workspaceId: workspace.id,
      title: input?.title?.trim() || "New chat",
    },
    select: { id: true },
  });
  revalidatePath("/generate");
  return { ok: true, id: conv.id };
}

export async function deleteConversation(
  conversationId: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!conversationId) return { ok: false, message: "missing conversationId" };
  const { workspace } = await getCurrentWorkspace();
  // Verify ownership before touching. Prevents a stolen id from
  // deleting another workspace's data.
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!conv) return { ok: false, message: "conversation not found" };
  // Soft-delete so we can undo later if needed. Hard cleanup is a
  // cron / manual decision, not this action's problem.
  await db.conversation.update({
    where: { id: conv.id },
    data:  { deletedAt: new Date() },
  });
  revalidatePath("/generate");
  return { ok: true };
}

export async function renameConversation(input: {
  conversationId: string;
  title: string;
}): Promise<{ ok: boolean; message?: string }> {
  const title = input.title?.trim();
  if (!input.conversationId) {
    return { ok: false, message: "missing conversationId" };
  }
  if (!title) return { ok: false, message: "title cannot be empty" };
  if (title.length > 120) {
    return { ok: false, message: "title too long (max 120 chars)" };
  }
  const { workspace } = await getCurrentWorkspace();
  const conv = await db.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: workspace.id, deletedAt: null },
    select: { id: true },
  });
  if (!conv) return { ok: false, message: "conversation not found" };
  await db.conversation.update({
    where: { id: conv.id },
    data:  { title },
  });
  revalidatePath("/generate");
  return { ok: true };
}

/* ------------------------------------------------------------------
 * Send message (SCAFFOLD — Commit 4 adds the LLM turn)
 * ---------------------------------------------------------------- */

export async function sendUserMessage(input: {
  conversationId: string;
  text: string;
}): Promise<{ ok: boolean; message?: string; messageId?: string }> {
  const text = (input.text ?? "").trim();
  if (!input.conversationId) {
    return { ok: false, message: "missing conversationId" };
  }
  if (!text) return { ok: false, message: "message cannot be empty" };
  if (text.length > 20_000) {
    return { ok: false, message: "message too long (max 20k chars)" };
  }
  const { workspace } = await getCurrentWorkspace();
  const conv = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      workspaceId: workspace.id,
      deletedAt: null,
    },
    select: { id: true, title: true, _count: { select: { messages: true } } },
  });
  if (!conv) return { ok: false, message: "conversation not found" };

  const created = await db.message.create({
    data: {
      conversationId: conv.id,
      role:    "user",
      content: text,
    },
    select: { id: true },
  });

  // Auto-derive a conversation title from the FIRST user message —
  // truncated to something readable. If the operator later renames
  // it manually, renameConversation writes and this path never
  // touches it again (only fires when messageCount was 0).
  if (conv._count.messages === 0 && conv.title === "New chat") {
    const autoTitle =
      text.length <= 60
        ? text
        : text.slice(0, 60).replace(/\s+\S*$/, "") + "…";
    await db.conversation.update({
      where: { id: conv.id },
      data:  { title: autoTitle },
    });
  }

  revalidatePath("/generate");
  return { ok: true, messageId: created.id };
}
