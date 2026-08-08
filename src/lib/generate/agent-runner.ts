/**
 * /generate agent runner — Anthropic Messages API tool-use loop
 * bridged to the APEX MCP server.
 *
 * Called by the /api/generate/stream/[id] SSE endpoint. Runs the
 * full turn:
 *   1. Load conversation history from DB
 *   2. Load MCP tool schemas via JWT-authenticated listTools
 *   3. Loop:
 *      a. Stream Anthropic response
 *      b. Emit text deltas to the client via yielded events
 *      c. If Anthropic emits tool_use blocks, call each via MCP,
 *         yield tool_call / tool_result events, feed results back
 *         in the next messages[] as user turns per the API contract
 *      d. Break when stop_reason === "end_turn" (or safety cap)
 *   4. Persist the assistant + tool_result turns to DB
 *
 * Emits events as an async generator so the SSE endpoint can just
 * for-await and pipe. Never throws mid-stream — errors turn into
 * "error" events with a message.
 *
 * This is Commit 4 of the MCP integration. Commit 5 layers in the
 * SOP-trained system prompt + our custom tools (get_product_context,
 * save_generated_video, etc). This file's SYSTEM_PROMPT is a
 * placeholder that names the MCP tools available but doesn't have
 * SOP-specific instructions yet.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { db } from "@/lib/db";
import { loadOrCreateSettings } from "@/lib/workspace-settings";
import { callMcpTool, listMcpTools } from "@/lib/apex-mcp";

/** Anthropic model when calling Anthropic directly. Sonnet 5 is
 *  the picked default — best tool-use balance for the price.
 *  Overridable via WorkspaceSettings.anthropicModel. */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** Default model when routing through OpenRouter. OpenRouter
 *  uses prefixed model IDs (`<provider>/<name>`); we default to
 *  the newest Sonnet variant they typically carry. Overridable
 *  via WorkspaceSettings.openrouterModel — if OpenRouter hasn't
 *  yet added a model, the operator can set the exact id there.
 *  We deliberately DON'T default to openrouter/auto because
 *  auto-routing can land on a model without tool-use support. */
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";

/** Hard cap on the agent loop. Prevents runaway tool-call chains
 *  from a hallucinating model. Real Style-1 flows should finish
 *  in ~10 tool calls (4 Flow ops + polling). 30 leaves headroom
 *  for retries but bounds cost. */
const MAX_LOOP_ITERATIONS = 30;

/** Max output tokens per Anthropic call. Sonnet 5 default is
 *  usually plenty for a conversational agent — but tool-heavy
 *  turns can be long. 4096 is a safe ceiling. */
const MAX_TOKENS = 4096;

/**
 * Events yielded by runAgentTurn. The SSE endpoint serialises
 * these as `event: <type>\ndata: <json>\n\n`.
 */
export type AgentEvent =
  | { type: "text_delta"; delta: string }
  | { type: "message_saved"; messageId: string; role: string }
  | {
      type: "tool_call";
      toolUseId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      isError: boolean;
      /** Compact preview of the result for the UI — full content
       *  lives in the persisted message. */
      preview: string;
    }
  | { type: "done" }
  | { type: "error"; message: string };

export async function* runAgentTurn(input: {
  workspaceId: string;
  conversationId: string;
}): AsyncGenerator<AgentEvent, void, void> {
  try {
    yield* runAgentTurnInner(input);
  } catch (err) {
    console.error("[agent-runner] unhandled:", err);
    yield {
      type: "error",
      message: (err as Error).message?.slice(0, 400) || "unknown error",
    };
  }
}

async function* runAgentTurnInner(input: {
  workspaceId: string;
  conversationId: string;
}): AsyncGenerator<AgentEvent, void, void> {
  const settings = await loadOrCreateSettings(input.workspaceId);
  // Provider selection: prefer a direct Anthropic key when set;
  // fall back to OpenRouter routed through Anthropic's SDK via
  // baseURL override. OpenRouter's /api/v1/messages endpoint is
  // Anthropic-Messages-API-compatible and passes tool_use /
  // tool_result blocks through to the underlying model, so the
  // rest of the agent loop is provider-agnostic.
  const anthropicKey  = (settings.anthropicApiKey  ?? "").trim();
  const openrouterKey = (settings.openrouterApiKey ?? "").trim();

  let apiKey: string;
  let baseURL: string | undefined;
  let modelName: string;
  let providerLabel: string;
  let defaultHeaders: Record<string, string> | undefined;

  if (anthropicKey) {
    apiKey = anthropicKey;
    baseURL = undefined;
    modelName =
      (settings.anthropicModel ?? "").trim() || DEFAULT_ANTHROPIC_MODEL;
    providerLabel = "Anthropic";
  } else if (openrouterKey) {
    apiKey = openrouterKey;
    // Anthropic SDK appends "/v1/messages" internally, so baseURL
    // must NOT already end in /v1 — otherwise you get a double
    // /v1/v1/messages that OpenRouter returns as a 404 HTML page.
    baseURL = "https://openrouter.ai/api";
    modelName =
      (settings.openrouterModel ?? "").trim() || DEFAULT_OPENROUTER_MODEL;
    providerLabel = "OpenRouter";
    // OpenRouter's per-app leaderboard headers. Optional but a
    // nice signal on their dashboard about which app is calling.
    const headers: Record<string, string> = {};
    if (settings.openrouterSiteUrl)
      headers["HTTP-Referer"] = settings.openrouterSiteUrl;
    if (settings.openrouterAppName)
      headers["X-Title"] = settings.openrouterAppName;
    if (Object.keys(headers).length > 0) defaultHeaders = headers;
  } else {
    yield {
      type: "error",
      message:
        "No AI provider key configured. Set an Anthropic OR OpenRouter API key in Settings → AI Providers.",
    };
    return;
  }
  const flowEmail = (settings.flowEmail ?? "").trim();
  if (!flowEmail) {
    yield {
      type: "error",
      message:
        "No Google Flow account bound to this workspace. Bind one in Settings → Google Flow account before running the agent.",
    };
    return;
  }

  // Load conversation history and re-hydrate into Anthropic's
  // MessageParam[] shape. We only pass user + assistant turns to
  // Anthropic — never system messages (system prompt is built
  // fresh per request from workspace context).
  const conv = await db.conversation.findFirst({
    where: { id: input.conversationId, workspaceId: input.workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!conv) {
    yield { type: "error", message: "Conversation not found" };
    return;
  }
  const stored = await db.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      content: true,
      toolCallsJson: true,
      toolResultJson: true,
    },
  });
  const messages: MessageParam[] = stored.map(rehydrateMessage);

  // Load MCP tools once at loop start. If the JWT expires
  // mid-loop we mint a fresh one for each callMcpTool below —
  // the tool schemas don't change between calls, so this list
  // stays valid for the whole turn.
  let anthropicTools: Tool[];
  try {
    const mcpTools = await listMcpTools({
      sub: input.workspaceId,
      flowEmail,
    });
    anthropicTools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: (t.inputSchema as Tool["input_schema"]) ?? {
        type: "object",
        properties: {},
      },
    }));
  } catch (err) {
    yield {
      type: "error",
      message: `Couldn't list MCP tools: ${(err as Error).message?.slice(0, 300)}`,
    };
    return;
  }

  const anthropic = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(defaultHeaders ? { defaultHeaders } : {}),
  });
  console.log(
    `[agent-runner] provider=${providerLabel} model=${modelName} workspace=${input.workspaceId}`,
  );
  const systemPrompt = buildSystemPrompt();

  // Tool-use loop. Each iteration: send messages[] to Anthropic,
  // stream the response, if it ends with tool_use — call each
  // tool and append a paired user tool_result message. Break
  // when Anthropic stops for end_turn.
  for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter += 1) {
    let finalMessage: Message;
    try {
      // Non-streaming for now — simpler to persist + emit atomic
      // events after each turn. Streaming deltas is a nice-to-have
      // for perceived speed but adds complexity around handling
      // partial tool_use blocks. Can retrofit later.
      finalMessage = await anthropic.messages.create({
        model: modelName,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });
    } catch (err) {
      yield {
        type: "error",
        message: `Anthropic error: ${(err as Error).message?.slice(0, 300)}`,
      };
      return;
    }

    // Extract text blocks + tool_use blocks from the assistant
    // response. We emit the text as a single delta (no streaming
    // yet — see comment above) so the client can render it as
    // one bubble.
    const textParts: string[] = [];
    const toolUses: ToolUseBlock[] = [];
    for (const block of finalMessage.content) {
      if (block.type === "text") {
        textParts.push((block as TextBlock).text);
      } else if (block.type === "tool_use") {
        toolUses.push(block as ToolUseBlock);
      }
    }
    const textContent = textParts.join("\n\n");

    // Emit text to the client BEFORE persisting so the UI updates
    // as fast as possible.
    if (textContent) {
      yield { type: "text_delta", delta: textContent };
    }
    for (const tu of toolUses) {
      yield {
        type: "tool_call",
        toolUseId: tu.id,
        name: tu.name,
        input: (tu.input as Record<string, unknown>) ?? {},
      };
    }

    // Persist the assistant turn (text + tool_use blocks).
    const assistantRow = await db.message.create({
      data: {
        conversationId: conv.id,
        role:    "assistant",
        content: textContent,
        toolCallsJson:
          toolUses.length > 0
            ? JSON.stringify(toolUses)
            : null,
      },
      select: { id: true },
    });
    yield {
      type: "message_saved",
      messageId: assistantRow.id,
      role: "assistant",
    };
    // Add to in-memory conversation for the next iteration.
    messages.push({
      role: "assistant",
      content: finalMessage.content,
    });

    // Loop exit: Anthropic finished without asking for more tools.
    if (finalMessage.stop_reason !== "tool_use") {
      break;
    }
    if (toolUses.length === 0) {
      // Defensive: stop_reason says tool_use but no blocks
      // present. Bail rather than infinite-loop.
      break;
    }

    // Execute each tool_use via MCP in parallel — Anthropic can
    // request multiple tools in one turn. Order the results the
    // same way for stable transcripts.
    const toolResults: ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        try {
          const result = await callMcpTool({
            sub: input.workspaceId,
            flowEmail,
            name: tu.name,
            args: (tu.input as Record<string, unknown>) ?? {},
          });
          // Anthropic's tool_result content is a string (or a
          // content-block array). We stringify the MCP result's
          // content or structuredContent so the model has
          // something to reason about.
          const resultText =
            result.structuredContent !== undefined
              ? JSON.stringify(result.structuredContent).slice(0, 20_000)
              : (result.content ?? [])
                  .map((c) => {
                    if (c && typeof c === "object" && "text" in c) {
                      return String((c as { text: unknown }).text ?? "");
                    }
                    return "";
                  })
                  .join("\n")
                  .slice(0, 20_000);
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: resultText || "(empty result)",
            is_error: result.isError,
          };
        } catch (err) {
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: `Tool call failed: ${(err as Error).message?.slice(0, 300)}`,
            is_error: true,
          };
        }
      }),
    );

    // Emit each result to the client + persist as its own user-role
    // message with toolResultJson populated.
    for (const tr of toolResults) {
      const preview =
        typeof tr.content === "string"
          ? tr.content.slice(0, 200)
          : "(structured content)";
      yield {
        type: "tool_result",
        toolUseId: tr.tool_use_id,
        isError: Boolean(tr.is_error),
        preview,
      };
      const row = await db.message.create({
        data: {
          conversationId: conv.id,
          role:    "user",
          content: "",
          toolResultJson: JSON.stringify(tr),
        },
        select: { id: true },
      });
      yield { type: "message_saved", messageId: row.id, role: "user" };
    }

    // Feed results back to Anthropic for the next iteration.
    messages.push({
      role: "user",
      content: toolResults,
    });
  }

  yield { type: "done" };
}

/** Rebuild an Anthropic MessageParam from a persisted row. */
function rehydrateMessage(row: {
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolResultJson: string | null;
}): MessageParam {
  if (row.role === "assistant") {
    // Assistant turn may carry text + tool_use blocks.
    const parts: (TextBlock | ToolUseBlock)[] = [];
    if (row.content) {
      parts.push({
        type: "text",
        text: row.content,
        citations: null,
      });
    }
    if (row.toolCallsJson) {
      try {
        const decoded = JSON.parse(row.toolCallsJson) as ToolUseBlock[];
        if (Array.isArray(decoded)) parts.push(...decoded);
      } catch {
        // ignore — malformed row, skip the tool_use portion
      }
    }
    return { role: "assistant", content: parts };
  }
  // role === "user"
  if (row.toolResultJson) {
    try {
      const decoded = JSON.parse(row.toolResultJson) as ToolResultBlockParam;
      return { role: "user", content: [decoded] };
    } catch {
      // fall through to plain-text user message
    }
  }
  return { role: "user", content: row.content };
}

/**
 * System prompt for the agent (Commit 4 placeholder — Commit 5
 * layers in the full SOP-trained version).
 *
 * Right now just names the environment + the fact that Flow tools
 * are available. The model will figure out what to call from the
 * tool schemas + user request. Not ideal for consistent Style 1
 * output — but proves the loop works.
 */
function buildSystemPrompt(): string {
  return [
    "You are an assistant helping a TikTok Shop operator generate short-form videos using Google Flow.",
    "",
    "You have access to a set of Google Flow tools (generate_video, generate_image, get_job, list_accounts, etc.) — call them as needed to complete the user's request. Poll asynchronous jobs to completion via google_flow_get_job.",
    "",
    "Rules:",
    "- Never fabricate a job id, media id, or URL. If a call fails, tell the user what happened.",
    "- Videos take 60-180 seconds. Poll every 10-15 seconds; don't retry a job in an error state.",
    "- If a tool returns a 596 error, the user's Google session is broken and needs to be reconnected — tell them to visit Settings → Google Flow account.",
    "- Prefer veo-3.1-lite (10 credits) over veo-3.1-quality (100) unless the user explicitly asks for quality.",
    "- When you finish, summarize what was generated with links to any resulting media URLs.",
  ].join("\n");
}
