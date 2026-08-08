/**
 * /api/generate/stream/[conversationId]
 *
 * Server-Sent Events endpoint for the APEX MCP chat agent loop.
 * The endpoint's URL still lives under /api/generate for backwards
 * compatibility during the chat-panel refactor — the client-facing
 * chat now lives inside /prompts as a per-batch panel.
 *
 * Contract:
 *   POST /api/generate/stream/<conversationId>
 *   Body: {
 *     text: string,                    // operator input
 *     referenceImageUrls?: string[],   // picker attachments
 *   }
 *
 *   Returns an SSE stream. Events:
 *     event: text_delta      { delta }
 *     event: message_saved   { messageId, role }
 *     event: tool_call       { toolUseId, name, input }
 *     event: tool_result     { toolUseId, isError, preview }
 *     event: done            {}
 *     event: error           { message }
 *
 * Auth: workspace boundary is enforced inside runAgentTurn (which
 * joins the conversation → batch → workspace). We STILL do a
 * lightweight ownership check here so an unauthenticated caller
 * gets a 401/404 up-front rather than through the SSE error
 * channel — cheaper for the caller.
 */

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { runAgentTurn, type AgentEvent } from "@/lib/generate/agent-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ conversationId: string }> },
): Promise<Response> {
  const { workspace } = await getCurrentWorkspace();
  const { conversationId } = await ctx.params;

  if (!conversationId) {
    return sseErrorResponse("missing conversationId", 400);
  }
  // Confirm the conversation belongs to this workspace (via its
  // batch). runAgentTurn re-checks internally; this pre-check
  // gives the client an HTTP-status-shaped error before the SSE
  // stream opens.
  const conv = await db.conversation.findFirst({
    where: {
      id: conversationId,
      deletedAt: null,
      batch: { workspaceId: workspace.id },
    },
    select: { id: true },
  });
  if (!conv) {
    return sseErrorResponse("conversation not found", 404);
  }

  const body = (await req.json().catch(() => null)) as
    | { text?: string; referenceImageUrls?: unknown }
    | null;
  const text = (body?.text ?? "").trim();
  if (!text) {
    return sseErrorResponse("text is required", 400);
  }
  if (text.length > 20_000) {
    return sseErrorResponse("text too long (max 20k chars)", 400);
  }

  const referenceImageUrls = Array.isArray(body?.referenceImageUrls)
    ? (body!.referenceImageUrls as unknown[])
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter(Boolean)
    : [];

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
          conversationId: conv.id,
          userText: text,
          referenceImageUrls,
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
      // Client disconnected mid-stream. The generator halts on its
      // next yield attempt. No long-lived resources here — MCP
      // connections are per-tool-call.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent Caddy / nginx buffering — critical for SSE.
      "X-Accel-Buffering": "no",
    },
  });
}

/** Pre-stream validation errors returned as SSE-shaped body so
 *  the client's consumer can handle them uniformly. */
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
