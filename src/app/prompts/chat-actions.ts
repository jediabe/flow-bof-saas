"use server";

/**
 * /prompts chat panel — server actions for the batch-scoped LLM
 * agent chat. Replaces the deleted workspace-level /generate page:
 * conversations now belong to a Batch, so each batch has its own
 * transcript history and the "which product am I working on" state
 * is remembered per-conversation.
 *
 * All actions are gated on getCurrentWorkspace() + a batch-owns-
 * workspace check. A stolen conversationId can't leak cross-tenant
 * because we always join through Batch.workspaceId.
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
  currentProductId: string | null;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolResultJson: string | null;
  attachedImagesJson: string | null;
  createdAt: string;
}

export interface ConversationDetail {
  ok: boolean;
  message?: string;
  id?: string;
  title?: string;
  currentProductId?: string | null;
  messages?: ChatMessage[];
}

/* ------------------------------------------------------------------
 * Ownership helper
 * ---------------------------------------------------------------- */

async function assertBatchOwned(batchId: string) {
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true, workspaceId: true },
  });
  if (!batch) throw new Error("batch not found");
  return { workspace, batch };
}

/* ------------------------------------------------------------------
 * List / read
 * ---------------------------------------------------------------- */

export async function listBatchConversations(
  batchId: string,
): Promise<ConversationSummary[]> {
  if (!batchId) return [];
  await assertBatchOwned(batchId);
  const rows = await db.conversation.findMany({
    where: { batchId, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      updatedAt: true,
      currentProductId: true,
      _count: { select: { messages: true } },
    },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: r.updatedAt.toISOString(),
    messageCount: r._count.messages,
    currentProductId: r.currentProductId,
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
      deletedAt: null,
      batch: { workspaceId: workspace.id },
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
    currentProductId: conv.currentProductId,
    messages: conv.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCallsJson: m.toolCallsJson,
      toolResultJson: m.toolResultJson,
      attachedImagesJson: m.attachedImagesJson,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/* ------------------------------------------------------------------
 * Create / delete / rename
 * ---------------------------------------------------------------- */

export async function createBatchConversation(input: {
  batchId: string;
  title?: string;
  currentProductId?: string | null;
}): Promise<{ ok: boolean; id?: string; message?: string }> {
  if (!input.batchId) return { ok: false, message: "missing batchId" };
  await assertBatchOwned(input.batchId);
  const conv = await db.conversation.create({
    data: {
      batchId: input.batchId,
      title: input.title?.trim() || "New chat",
      currentProductId: input.currentProductId ?? null,
    },
    select: { id: true },
  });
  revalidatePath("/prompts");
  return { ok: true, id: conv.id };
}

export async function deleteConversation(
  conversationId: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!conversationId) return { ok: false, message: "missing conversationId" };
  const { workspace } = await getCurrentWorkspace();
  const conv = await db.conversation.findFirst({
    where: {
      id: conversationId,
      batch: { workspaceId: workspace.id },
    },
    select: { id: true },
  });
  if (!conv) return { ok: false, message: "conversation not found" };
  await db.conversation.update({
    where: { id: conv.id },
    data:  { deletedAt: new Date() },
  });
  revalidatePath("/prompts");
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
    where: {
      id: input.conversationId,
      deletedAt: null,
      batch: { workspaceId: workspace.id },
    },
    select: { id: true },
  });
  if (!conv) return { ok: false, message: "conversation not found" };
  await db.conversation.update({
    where: { id: conv.id },
    data:  { title },
  });
  revalidatePath("/prompts");
  return { ok: true };
}

/**
 * Persist which product the operator has focused in the chat
 * panel. Called on product-picker change so switching back to a
 * conversation later restores the same context. Silently no-ops
 * on unknown conversation or product outside this workspace.
 */
export async function setConversationProduct(input: {
  conversationId: string;
  productId: string | null;
}): Promise<{ ok: boolean; message?: string }> {
  if (!input.conversationId) {
    return { ok: false, message: "missing conversationId" };
  }
  const { workspace } = await getCurrentWorkspace();
  const conv = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      deletedAt: null,
      batch: { workspaceId: workspace.id },
    },
    select: { id: true, batchId: true },
  });
  if (!conv) return { ok: false, message: "conversation not found" };
  if (input.productId) {
    // The picked product MUST belong to the same batch — otherwise
    // the tool calls would fetch cross-batch context the operator
    // didn't intend.
    const product = await db.product.findFirst({
      where: { id: input.productId, batchId: conv.batchId, deletedAt: null },
      select: { id: true },
    });
    if (!product) {
      return { ok: false, message: "product not in this batch" };
    }
  }
  await db.conversation.update({
    where: { id: conv.id },
    data:  { currentProductId: input.productId },
  });
  return { ok: true };
}
