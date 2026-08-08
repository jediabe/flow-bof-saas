/**
 * /api/generate/stream/[conversationId]
 *
 * Server-Sent Events endpoint for the /generate agent loop.
 *
 * Contract:
 *   POST /api/generate/stream/<conversationId>
 *   Body: { text: string }  — the operator's message
 *
 *   Returns an SSE stream. Events:
 *     event: text_delta      { delta }
 *     event: message_saved   { messageId, role }
 *     event: tool_call       { toolUseId, name, input }
 *     event: tool_result     { toolUseId, isError, preview }
 *     event: done            {}
 *     event: error           { message }
 *
 * Design decision: POST-with-SSE-response (not GET-with-body-in-
 * query-string). Simpler than negotiating EventSource + a separate
 * POST for the input. Client uses fetch() + a ReadableStream reader
 * to consume — EventSource doesn't support POST bodies.
 *
 * Auth: standard workspace-scoped via getCurrentWorkspace.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { runAgentTurn, type AgentEvent } from "@/lib/generate/agent-runner";

// Long-running SSE — disable static optimization and set a
// generous max duration. Node.js runtime, not edge (we call
// Prisma).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600; // 10 min; a video-heavy turn can go long

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { workspace } = await getCurrentWorkspace();
  const { conversationId } = await ctx.params;

  if (!conversationId) {
    return sseErrorResponse("missing conversationId", 400);
  }
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId: workspace.id, deletedAt: null },
    select: { id: true },
  });
  if (!conv) {
    return sseErrorResponse("conversation not found", 404);
  }

  const body = (await req.json().catch(() => null)) as
    | { text?: string }
    | null;
  const text = (body?.text ?? "").trim();
  if (!text) {
    return sseErrorResponse("text is required", 400);
  }
  if (text.length > 20_000) {
    return sseErrorResponse("text too long (max 20k chars)", 400);
  }

  // Persist the user message FIRST — even if the agent bails,
  // the operator's input shouldn't be lost. Rehydrated into the
  // conversation history that runAgentTurn loads.
  await db.message.create({
    data: {
      conversationId: conv.id,
      role:    "user",
      content: text,
    },
  });
  // Auto-derive title on first user message (mirror sendUserMessage).
  const convWithCount = await db.conversation.findUnique({
    where: { id: conv.id },
    select: { title: true, _count: { select: { messages: true } } },
  });
  if (
    convWithCount &&
    convWithCount.title === "New chat" &&
    convWithCount._count.messages === 1
  ) {
    const autoTitle =
      text.length <= 60
        ? text
        : text.slice(0, 60).replace(/\s+\S*$/, "") + "…";
    await db.conversation.update({
      where: { id: conv.id },
      data:  { title: autoTitle },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: AgentEvent) => {
        const line =
          `event: ${event.type}\n` +
          `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(line));
      };
      try {
        for await (const event of runAgentTurn({
          workspaceId: workspace.id,
          conversationId: conv.id,
        })) {
          write(event);
        }
      } catch (err) {
        write({
          type: "error",
          message: `Runner threw: ${(err as Error).message?.slice(0, 300)}`,
        });
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Client disconnected mid-stream. The generator will halt
      // on its next yield attempt. Nothing else to clean up
      // because we don't hold any long-lived resources here —
      // MCP connections are per-tool-call.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent proxies (Caddy, nginx) from buffering the
      // stream — critical for SSE to actually stream.
      "X-Accel-Buffering": "no",
    },
  });
}

/** For pre-stream validation errors, return SSE-shaped error
 *  so the client can consume uniformly. */
function sseErrorResponse(message: string, status: number): Response {
  const body =
    `event: error\ndata: ${JSON.stringify({ type: "error", message })}\n\n` +
    `event: done\ndata: ${JSON.stringify({ type: "done" })}\n\n`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
