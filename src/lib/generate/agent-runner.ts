/**
 * APEX MCP chat agent runner — Anthropic Messages API tool-use
 * loop bridged to the APEX MCP server.
 *
 * Called by the SSE endpoint at
 *   /api/generate/stream/[conversationId]
 * with the caller's user turn text + any reference-image URLs
 * the operator selected in the chat panel's image picker. The
 * conversation is batch-scoped (see the /prompts chat-panel
 * refactor); this runner looks up the conversation, joins to its
 * Batch → Workspace to authorize, then runs the loop:
 *
 *   1. Persist the user turn (text + attached images)
 *   2. Load history + rehydrate into Anthropic MessageParam[]
 *   3. Load MCP tool schemas via JWT-authenticated listTools
 *   4. Loop:
 *      a. Send messages[] to Anthropic
 *      b. Emit text + tool_call events to the client
 *      c. Dispatch tool calls: local_* → runLocalTool, else MCP
 *      d. Persist assistant + tool_result rows, feed back
 *      e. Break when stop_reason !== "tool_use" or safety cap
 *
 * Emits events as an async generator so the SSE endpoint can
 * for-await + pipe. Never throws mid-stream — errors turn into
 * "error" events with a message.
 *
 * Reference images:
 *   The picker on the chat panel lets the operator attach one or
 *   more image URLs per user turn. We persist them under
 *   Message.attachedImagesJson and, when building the outgoing
 *   MessageParam, prepend a short "[Reference images: ...]"
 *   text block. Real multimodal image content blocks are a
 *   follow-up — the current setup keeps the API surface
 *   provider-agnostic (works via OpenRouter too) and gives the
 *   agent enough context to fetch the URLs via
 *   google_flow_generate_image's reference_images array.
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
import {
  resolveLlmCredential,
  LlmCredentialError,
  type ResolvedCredential,
} from "@/lib/llm/credentials";
import { runResponsesLoop } from "@/lib/llm/responses-loop";
import {
  LOCAL_TOOLS,
  LOCAL_TOOL_NAMES,
  runLocalTool,
} from "@/lib/generate/local-tools";

/** Default Anthropic model when hitting the Anthropic API
 *  directly. Overridable via WorkspaceSettings.anthropicModel. */
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** Default model when routing through OpenRouter. Claude Sonnet
 *  4.5 is picked because it has stable tool-use support on
 *  OpenRouter's Anthropic-compatible /api/v1/messages endpoint,
 *  which is what this SDK setup targets. `openrouter/auto` is a
 *  known bad default: it silently returns empty responses on
 *  /messages (it works on the OpenAI-compat /chat/completions
 *  endpoint, which we don't use). Set WorkspaceSettings.
 *  openrouterModel to pick a different model; the settings UI
 *  ships a preset dropdown with the common tool-use-capable
 *  options. Custom strings are accepted but a model without
 *  tool-use will fail the first time the agent calls a tool. */
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";

const MAX_LOOP_ITERATIONS = 30;
const MAX_TOKENS = 4096;

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
      preview: string;
    }
  | { type: "done" }
  | { type: "error"; message: string };

export interface RunAgentTurnInput {
  conversationId: string;
  /** Freeform text for the user turn (from the chat input box). */
  userText: string;
  /** Absolute or app-relative URLs of images the operator
   *  attached to THIS turn via the reference-image picker.
   *  Empty array = no attachments. */
  referenceImageUrls: string[];
}

export async function* runAgentTurn(
  input: RunAgentTurnInput,
): AsyncGenerator<AgentEvent, void, void> {
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

async function* runAgentTurnInner(
  input: RunAgentTurnInput,
): AsyncGenerator<AgentEvent, void, void> {
  // Look up the conversation + join batch → workspace. This is
  // the sole ownership check — any subsequent DB writes for the
  // turn are keyed off conv.id / batch.workspaceId, so a stolen
  // conversationId can't cross tenants.
  const conv = await db.conversation.findFirst({
    where: { id: input.conversationId, deletedAt: null },
    select: {
      id: true,
      batchId: true,
      currentProductId: true,
      batch: {
        select: {
          id: true,
          workspaceId: true,
          market: true,
          name: true,
          // Owner userId — used to resolve the user's LLM
          // credential row (LlmCredential is per-user, not
          // per-workspace). See src/lib/llm/credentials.ts.
          workspace: { select: { ownerId: true } },
        },
      },
    },
  });
  if (!conv) {
    yield { type: "error", message: "Conversation not found" };
    return;
  }
  const workspaceId = conv.batch.workspaceId;
  const batchId = conv.batch.id;
  const ownerUserId = conv.batch.workspace.ownerId;

  const settings = await loadOrCreateSettings(workspaceId);

  // Try the new credential resolver first (app_key + user_key +
  // user_oauth). Fall back to legacy workspace-scoped keys if
  // the resolver has nothing — required until the legacy
  // cleanup commit drops those columns.
  //
  // runMode is what actually picks the loop implementation below:
  //   "anthropic" → the Anthropic Messages loop in this file
  //                 (works for direct Anthropic, OpenRouter via
  //                 baseURL override, and Anthropic app_key/user_key)
  //   "responses" → runResponsesLoop in src/lib/llm/responses-loop.ts
  //                 (ChatGPT-subscription user_oauth)
  // chat_completions is deferred to a later commit.
  let apiKey: string;
  let baseURL: string | undefined;
  let modelName: string;
  let providerLabel: string;
  let defaultHeaders: Record<string, string> | undefined;
  let credSource: "resolver" | "legacy_workspace_key";
  let runMode: "anthropic" | "responses";
  let responsesCred: ResolvedCredential | null = null;

  const resolved = await tryResolveLlmCredential(ownerUserId);
  const anthropicKey  = (settings.anthropicApiKey  ?? "").trim();
  const openrouterKey = (settings.openrouterApiKey ?? "").trim();

  if (resolved && resolved.apiShape === "anthropic_messages") {
    // app_key or user_key Anthropic — extract the bearer token
    // out of the authHeader so the SDK can use it as apiKey.
    apiKey = resolved.authHeader.replace(/^Bearer\s+/i, "").trim();
    baseURL = undefined;
    modelName =
      (settings.anthropicModel ?? "").trim() || DEFAULT_ANTHROPIC_MODEL;
    providerLabel = `${resolved.mode}/anthropic`;
    credSource = "resolver";
    runMode = "anthropic";
  } else if (resolved && resolved.apiShape === "responses") {
    // user_oauth (ChatGPT subscription). Loop dispatch happens
    // after shared setup (MCP tools + system prompt) — see the
    // runResponsesLoop hand-off later in this function.
    apiKey = "";
    baseURL = undefined;
    // Default model per opencode's config — gpt-5.2 is the top
    // tier available to ChatGPT Plus subs. Workspace-level
    // override can pin a different variant.
    modelName =
      (settings.openrouterModel ?? "").trim() || "gpt-5.2";
    providerLabel = "user_oauth/openai_responses";
    credSource = "resolver";
    runMode = "responses";
    responsesCred = resolved;
  } else if (resolved && resolved.apiShape === "chat_completions") {
    yield {
      type: "error",
      message:
        "OpenAI Chat Completions credential resolved (mode=" +
        resolved.mode +
        ") but the OpenAI Chat Completions tool-use loop is not implemented yet. For now set APP_ANTHROPIC_API_KEY, use a workspace-scoped Anthropic/OpenRouter key, or connect a ChatGPT subscription via user_oauth.",
    };
    return;
  } else if (anthropicKey) {
    apiKey = anthropicKey;
    baseURL = undefined;
    modelName =
      (settings.anthropicModel ?? "").trim() || DEFAULT_ANTHROPIC_MODEL;
    providerLabel = "legacy_workspace/anthropic";
    credSource = "legacy_workspace_key";
    runMode = "anthropic";
  } else if (openrouterKey) {
    apiKey = openrouterKey;
    // Anthropic SDK appends "/v1/messages"; baseURL must NOT end
    // in /v1 or you get /v1/v1/messages → 404 HTML from OpenRouter.
    baseURL = "https://openrouter.ai/api";
    modelName =
      (settings.openrouterModel ?? "").trim() || DEFAULT_OPENROUTER_MODEL;
    providerLabel = "legacy_workspace/openrouter";
    credSource = "legacy_workspace_key";
    runMode = "anthropic";
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
        "No LLM credential is configured. Set APP_ANTHROPIC_API_KEY on the app, connect your ChatGPT subscription in Settings, or add a workspace-scoped Anthropic/OpenRouter key.",
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

  // Normalize attachments: dedupe, strip empty, cap at 8 (past
  // that the reference blob would swamp the prompt and Flow
  // itself only takes a handful of refs per generation).
  const cleanImages = Array.from(
    new Set(
      (input.referenceImageUrls ?? [])
        .map((u) => (typeof u === "string" ? u.trim() : ""))
        .filter(Boolean),
    ),
  ).slice(0, 8);
  const userText = (input.userText ?? "").trim();

  // Persist the user turn FIRST so the transcript reflects what
  // the operator sent even if the agent loop errors below.
  const userRow = await db.message.create({
    data: {
      conversationId: conv.id,
      role: "user",
      content: userText,
      attachedImagesJson:
        cleanImages.length > 0 ? JSON.stringify(cleanImages) : null,
    },
    select: { id: true },
  });
  yield { type: "message_saved", messageId: userRow.id, role: "user" };

  // Auto-derive the title from the first user message when the
  // conversation is still on the "New chat" default. Also bumps
  // updatedAt via @updatedAt so the batch's conversation list
  // sorts this thread to the top.
  const convForTitle = await db.conversation.findUnique({
    where: { id: conv.id },
    select: { title: true },
  });
  if (convForTitle?.title === "New chat" && userText) {
    const derived = userText.slice(0, 60).replace(/\s+/g, " ").trim();
    await db.conversation.update({
      where: { id: conv.id },
      data:  { title: derived || "New chat" },
    });
  } else {
    // No title change — still poke the row so updatedAt refreshes.
    await db.conversation.update({
      where: { id: conv.id },
      data:  { title: convForTitle?.title ?? "New chat" },
    });
  }

  // Load full history AFTER persisting the fresh user turn so
  // the model sees it in the messages[] payload.
  const stored = await db.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      content: true,
      toolCallsJson: true,
      toolResultJson: true,
      attachedImagesJson: true,
    },
  });
  const messages: MessageParam[] = stored.map(rehydrateMessage);

  // Load MCP tools once at loop start.
  let anthropicTools: Tool[];
  try {
    const mcpTools = await listMcpTools({
      sub: workspaceId,
      flowEmail,
    });
    const mcpAsTools: Tool[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: (t.inputSchema as Tool["input_schema"]) ?? {
        type: "object",
        properties: {},
      },
    }));
    // Union: local tools (batch products / video save) + MCP
    // tools (Google Flow). Dispatch is by name below.
    anthropicTools = [...LOCAL_TOOLS, ...mcpAsTools];
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
    `[agent-runner] source=${credSource} provider=${providerLabel} model=${modelName} workspace=${workspaceId} batch=${batchId} user=${ownerUserId}`,
  );
  // Has the operator picked (or the agent used) a Veo model in
  // this conversation already? Scan every prior assistant turn's
  // toolCallsJson for a google_flow_generate_video call. If yes,
  // the "ask which Veo model" preamble is unnecessary — the
  // agent should reuse whatever model it (or the operator) settled
  // on last time. If no, the system prompt tells the agent to
  // present the options before spending any Veo credits.
  const hasVideoBefore = stored.some((row) => {
    if (row.role !== "assistant" || !row.toolCallsJson) return false;
    try {
      const arr = JSON.parse(row.toolCallsJson) as Array<{ name?: string }>;
      return Array.isArray(arr) && arr.some((t) => t?.name === "google_flow_generate_video");
    } catch {
      return false;
    }
  });
  const systemPrompt = buildSystemPrompt({
    batchName: conv.batch.name,
    market: conv.batch.market,
    currentProductId: conv.currentProductId,
    hasVideoBefore,
  });

  // Shared tool-dispatch helper — used by both loop
  // implementations. Wraps local_* + MCP calls, applies the
  // auto-poll for async jobs, and normalizes the result shape
  // to { content: string, isError: boolean }. Extracting this
  // out means the Responses loop and the Anthropic loop share
  // one dispatch policy and the auto-poll logic doesn't
  // duplicate.
  const dispatchOneTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: string; isError: boolean }> => {
    try {
      if (LOCAL_TOOL_NAMES.has(name)) {
        const local = await runLocalTool({
          workspaceId,
          batchId,
          name,
          args,
        });
        return {
          content: local.result || "(empty result)",
          isError: local.isError,
        };
      }
      let result = await callMcpTool({
        sub: workspaceId,
        flowEmail,
        name,
        args,
      });
      if (name !== "google_flow_get_job") {
        result = await resolveAsyncJob(result, {
          sub: workspaceId,
          flowEmail,
          originatingTool: name,
        });
      }
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
        content: resultText || "(empty result)",
        isError: result.isError,
      };
    } catch (err) {
      return {
        content: `Tool call failed: ${(err as Error).message?.slice(0, 300)}`,
        isError: true,
      };
    }
  };

  // ---- Route by API shape ---------------------------------------
  // ChatGPT-subscription (user_oauth) uses the OpenAI Responses
  // API which has a completely different wire protocol. Hand off
  // to the dedicated loop and return.
  if (runMode === "responses" && responsesCred) {
    console.log(
      `[agent-runner] source=${credSource} provider=${providerLabel} model=${modelName} workspace=${workspaceId} batch=${batchId} user=${ownerUserId}`,
    );
    yield* runResponsesLoop({
      cred: responsesCred,
      model: modelName,
      systemPrompt,
      tools: anthropicTools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.input_schema as {
          type: "object";
          properties?: Record<string, unknown>;
          required?: string[];
        },
      })),
      storedHistory: stored.map((row) => ({
        role: row.role,
        content: row.content,
        toolCallsJson: row.toolCallsJson,
        toolResultJson: row.toolResultJson,
        attachedImagesJson: row.attachedImagesJson,
      })),
      reasoningEffort: "medium",
      hooks: {
        persistAssistant: async ({ content, toolCalls }) => {
          // Store OpenAI function_calls in the SAME JSON shape
          // Anthropic tool_use blocks use, so the transcript UI
          // (and future rehydration back into Anthropic format
          // if the user switches providers) works uniformly.
          const asToolUses = toolCalls.map((fc) => {
            let input: unknown = {};
            try {
              input = JSON.parse(fc.arguments);
            } catch {
              // fall through — store empty object
            }
            return {
              type: "tool_use" as const,
              id: fc.callId,
              name: fc.name,
              input,
            };
          });
          const row = await db.message.create({
            data: {
              conversationId: conv.id,
              role: "assistant",
              content,
              toolCallsJson:
                asToolUses.length > 0 ? JSON.stringify(asToolUses) : null,
            },
            select: { id: true },
          });
          return { id: row.id };
        },
        persistToolResult: async ({ callId, output, isError }) => {
          const row = await db.message.create({
            data: {
              conversationId: conv.id,
              role: "user",
              content: "",
              toolResultJson: JSON.stringify({
                type: "tool_result",
                tool_use_id: callId,
                content: output,
                is_error: isError,
              }),
            },
            select: { id: true },
          });
          return { id: row.id };
        },
        dispatchTool: dispatchOneTool,
      },
    });
    return;
  }

  for (let iter = 0; iter < MAX_LOOP_ITERATIONS; iter += 1) {
    let finalMessage: Message;
    try {
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

    // Log what the provider actually resolved. OpenRouter's meta
    // models (openrouter/auto, openrouter/nitro) come back with
    // the routed-to model in finalMessage.model — useful when
    // debugging "why did this reply come back empty?" scenarios.
    console.log(
      `[agent-runner] iter=${iter} model=${finalMessage.model ?? "(unknown)"} stop=${finalMessage.stop_reason ?? "(none)"} blocks=${finalMessage.content?.length ?? 0}`,
    );

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

    // Empty-response guard. OpenRouter's Anthropic-compat
    // endpoint (/api/v1/messages) does NOT support the
    // openrouter/auto meta-model — it comes back with zero
    // content blocks and stop_reason=end_turn, and the loop
    // would silently break without the user seeing anything.
    // Also catches the rare case where a tool-use-incapable
    // model just refuses. Surface it as a clear error and
    // stop instead of pretending the turn succeeded.
    if (
      iter === 0 &&
      textParts.length === 0 &&
      toolUses.length === 0
    ) {
      const routed = finalMessage.model ?? modelName;
      yield {
        type: "error",
        message:
          `The provider returned an empty response (routed to "${routed}", stop_reason="${finalMessage.stop_reason ?? "unknown"}"). ` +
          (modelName === "openrouter/auto" || modelName.includes("/auto")
            ? "OpenRouter's auto-routing is not supported on the Anthropic-compatible /messages endpoint that this app uses. Pick a specific model in Settings → AI Providers → OpenRouter (Claude Sonnet 4.5 is the safe default)."
            : "The model may not support tool-use. Try a different model in Settings → AI Providers."),
      };
      return;
    }

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
    messages.push({
      role: "assistant",
      content: finalMessage.content,
    });

    if (finalMessage.stop_reason !== "tool_use") {
      break;
    }
    if (toolUses.length === 0) {
      break;
    }

    const toolResults: ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        const args = (tu.input as Record<string, unknown>) ?? {};
        try {
          if (LOCAL_TOOL_NAMES.has(tu.name)) {
            const local = await runLocalTool({
              workspaceId,
              batchId,
              name: tu.name,
              args,
            });
            return {
              type: "tool_result" as const,
              tool_use_id: tu.id,
              content: local.result || "(empty result)",
              is_error: local.isError,
            };
          }
          let result = await callMcpTool({
            sub: workspaceId,
            flowEmail,
            name: tu.name,
            args,
          });
          // Auto-poll async jobs on the server so the LLM
          // doesn't burn credits calling google_flow_get_job in
          // a loop. See resolveAsyncJob() for the shape check —
          // any result stamped mode:"async" with a jobId gets
          // resolved here, and the completed job's payload
          // replaces the original stub before the LLM sees it.
          if (tu.name !== "google_flow_get_job") {
            result = await resolveAsyncJob(result, {
              sub: workspaceId,
              flowEmail,
              originatingTool: tu.name,
            });
          }
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

    messages.push({
      role: "user",
      content: toolResults,
    });
  }

  yield { type: "done" };
}

/** Rebuild an Anthropic MessageParam from a persisted row.
 *  When the user row has attached reference images, we prepend a
 *  short "[Reference images: ...]" text so the model has the URL
 *  available (it can then pass them to google_flow_generate_image
 *  or reference them in a Style 1 plan). */
function rehydrateMessage(row: {
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolResultJson: string | null;
  attachedImagesJson: string | null;
}): MessageParam {
  if (row.role === "assistant") {
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
        // malformed row — skip tool_use portion
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
      // fall through
    }
  }
  const imageUrls = parseAttachedImages(row.attachedImagesJson);
  if (imageUrls.length === 0) {
    return { role: "user", content: row.content };
  }
  const preamble =
    `[Reference images the operator attached to this turn — pass these to google_flow_generate_image's reference_images array when generating scene images for the picked product]:\n` +
    imageUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");
  const text = row.content ? `${preamble}\n\n${row.content}` : preamble;
  return { role: "user", content: text };
}

/* ------------------------------------------------------------------
 * Server-side async job polling
 *
 * Google Flow's video endpoints are async: generate_video and
 * friends return a jobId immediately, and the caller polls
 * google_flow_get_job every ~15s until status is completed or
 * failed. The naive path is to have the LLM drive the poll loop
 * — which we did originally — but each poll is a full LLM turn
 * + tool_call, and a 3-minute video means ~12 wasted turns of
 * agent context and provider credits.
 *
 * resolveAsyncJob detects an async result (mode:"async" + a
 * jobId) and takes over the polling on the server. The LLM
 * never sees the intermediate jobId; it gets the completed
 * job's payload as if generate_video returned synchronously.
 *
 * Cap at 10 minutes wall clock — long enough for veo-3.1-quality
 * with a hot queue but short enough to bail if the account is
 * genuinely stuck. On timeout we return the original stub with
 * an extra note so the LLM can decide what to do (typically:
 * tell the operator and ask whether to keep waiting).
 * ---------------------------------------------------------------- */

const POLL_INTERVAL_MS = 15_000;
const POLL_MAX_WAIT_MS = 10 * 60 * 1_000;

interface McpResult {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}

async function resolveAsyncJob(
  result: McpResult,
  ctx: { sub: string; flowEmail: string; originatingTool: string },
): Promise<McpResult> {
  const jobId = extractAsyncJobId(result);
  if (!jobId) return result;

  const started = Date.now();
  console.log(
    `[agent-runner] auto-polling ${ctx.originatingTool} jobId=${jobId}`,
  );
  while (Date.now() - started < POLL_MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    let poll: McpResult;
    try {
      poll = await callMcpTool({
        sub: ctx.sub,
        flowEmail: ctx.flowEmail,
        name: "google_flow_get_job",
        args: { job_id: jobId },
      });
    } catch (err) {
      console.warn(
        `[agent-runner] poll failed for jobId=${jobId}:`,
        (err as Error).message?.slice(0, 200),
      );
      continue;
    }
    const status = extractJobStatus(poll);
    if (status === "completed" || status === "failed") {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      console.log(
        `[agent-runner] job ${jobId} ${status} after ${elapsed}s`,
      );
      // Return the completed poll payload directly — it contains
      // the full media[] and any error detail. The LLM sees this
      // as if the original generate call returned synchronously.
      return poll;
    }
  }
  // Timed out. Give the LLM the original stub plus an autopoll
  // note so it can surface a clear "job still running after 10
  // min" message and ask the operator what to do.
  console.warn(
    `[agent-runner] job ${jobId} still not done after ${POLL_MAX_WAIT_MS / 1000}s — surfacing timeout`,
  );
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  return {
    ...result,
    structuredContent: {
      ...structured,
      _autopoll: {
        timedOut: true,
        elapsedSeconds: Math.floor((Date.now() - started) / 1000),
        note: "The runner polled google_flow_get_job for 10 minutes without completion. Tell the operator and ask whether to keep waiting or cancel.",
      },
    },
  };
}

/** Pull a jobId out of an MCP tool result if it looks async.
 *  Returns null for sync results, empty results, or completed
 *  jobs that don't need polling. */
function extractAsyncJobId(result: McpResult): string | null {
  const s = result.structuredContent;
  if (!s || typeof s !== "object") return null;
  const rec = s as Record<string, unknown>;
  if (rec.mode !== "async") return null;
  // Skip if the job is already done — some sync fallbacks stamp
  // status="completed" alongside mode:"async" (edge case).
  const status = rec.status;
  if (status === "completed" || status === "failed") return null;
  const jobId = rec.jobId;
  return typeof jobId === "string" && jobId.length > 0 ? jobId : null;
}

function extractJobStatus(result: McpResult): string | null {
  const s = result.structuredContent;
  if (!s || typeof s !== "object") return null;
  const rec = s as Record<string, unknown>;
  // get_job returns {job: {status, ...}} — the normalized shape.
  const job = rec.job;
  if (job && typeof job === "object") {
    const inner = job as Record<string, unknown>;
    if (typeof inner.status === "string") return inner.status;
  }
  // Fallback: top-level status (generation stub shape).
  if (typeof rec.status === "string") return rec.status;
  return null;
}

/**
 * Soft variant of resolveLlmCredential — returns null instead of
 * throwing when no credential exists. Used by the agent-runner to
 * decide whether to fall through to legacy workspace-scoped keys.
 * Errors OTHER than "no_usable_credential" (decrypt failure, bad
 * OAuth grant) are logged and treated as "credential broken → try
 * the next fallback" — we don't want a single corrupt row to
 * break a whole workspace's chat.
 */
async function tryResolveLlmCredential(
  userId: string,
): Promise<ResolvedCredential | null> {
  try {
    return await resolveLlmCredential(userId);
  } catch (err) {
    if (
      err instanceof LlmCredentialError &&
      err.code === "no_usable_credential"
    ) {
      // Expected — no user_key / user_oauth row AND no app_key
      // env vars. Fall through to legacy workspace key path.
      return null;
    }
    console.warn(
      `[agent-runner] resolveLlmCredential failed for user=${userId}:`,
      (err as Error).message?.slice(0, 200),
    );
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAttachedImages(json: string | null): string[] {
  if (!json) return [];
  try {
    const decoded = JSON.parse(json);
    if (Array.isArray(decoded)) {
      return decoded.filter((u): u is string => typeof u === "string");
    }
  } catch {
    // ignore
  }
  return [];
}

function buildSystemPrompt(ctx: {
  batchName: string;
  market: string;
  currentProductId: string | null;
  hasVideoBefore: boolean;
}): string {
  const marketLabel = ctx.market === "us" ? "US" : "UK";
  const focus = ctx.currentProductId
    ? `The operator is currently focused on product id "${ctx.currentProductId}". Call local_get_product_context on that id first unless they've asked about a different product by name.`
    : `No product is focused yet. If the operator names a product, call local_list_workspace_products with search=<their words> to find its id, then local_get_product_context.`;
  const videoModelPreamble = ctx.hasVideoBefore
    ? `Video model already picked earlier in this conversation — reuse the SAME model in every google_flow_generate_video call so the whole video stays consistent. Only switch if the operator explicitly asks.`
    : `**BEFORE your first google_flow_generate_video call in this conversation, ASK the operator which Veo model to use.** Do not fire the tool.

Step 1: call google_flow_get_account. In the response, look at models.videoModels — this is THE authoritative list of what THIS operator's Google AI subscription can actually run. Only present models whose accessType is "INCLUDED" (skip PAY_AS_YOU_GO / LOCKED / anything they can't use).

Step 2: present those Veo models to the operator as a numbered list. For each model, show its key, displayName, and creditCost. If a model's creditCost is 0, mark it as "free (Google AI Ultra tier)" so they know it's the free lane. Common Veo models and what they mean if they appear:
  - veo-3.1-lite               — cheapest paid tier, good default for iterating
  - veo-3.1-fast               — balanced quality / cost
  - veo-3.1-quality            — best fidelity; DOES NOT accept reference images or characters
  - veo-3.1-lite-low-priority  — FREE (Ultra tier only); slower queue but no credits spent

Step 3: wait for their reply. Remember their choice for the rest of the conversation and use that model on every subsequent google_flow_generate_video call. Only ask again if the operator asks to switch. If they answer with something ambiguous (e.g. "the fast one", "the free one"), match it to the closest option in the account's actual list and confirm before firing.`;
  return `You are the video-generation agent for APEX Initiative's TikTok
Shop content system. You help operators create Style 1 (Store
Discovery) videos by planning + executing Google Flow tool
calls, then saving the results back to products so they appear
on the mobile posting page.

You are scoped to ONE batch:
  Batch: "${ctx.batchName}"
  Market: ${marketLabel}
${focus}

# Video model — pick once per conversation
${videoModelPreamble}

# Image + video defaults
- google_flow_generate_image: default model=nano-banana-pro (highest quality). aspect_ratio: "9:16" ALWAYS (TikTok is vertical). Only fall back to nano-banana-2 or nano-banana-2-lite if the operator explicitly asks for a cheaper/faster generation.
- google_flow_generate_video: aspect_ratio: "portrait" (that's Veo's 9:16). Model = whatever the operator picked above.

You have two families of tools:
  - local_*: read this batch's products / copy / settings and
    persist generated videos back to a product.
  - google_flow_*: 19 tools that wrap the useapi.net Google
    Flow API (Veo 3.1 video, Nano Banana images, jobs).

# Style 1 SOP — the workflow for every product

Style 1 is TWO scenes, ~16 seconds total:

  Scene 1 (~8s) — Store walk-up.
    A retail-shelf shot of the product; camera walks toward it;
    a hand pokes it at the end. No faces.
    IMAGE PROMPT (verbatim, swap "UK" for "US" if market=US):
      "Put a display setup for this product inside of a ${marketLabel} retail store, no price tags"
    MOTION PROMPT (universal, verbatim):
      "Bring the camera closer to the product and have a hand poke the product as if the person recording touched it"

  Scene 2 (~8s) — Product at home.
    Product sitting in the room it belongs in, on the surface a
    real person would actually put it on. Casual iPhone snapshot
    vibe. Same "hand pokes it" motion.

    IMAGE PROMPT (fill in [SETTING] AND [SURFACE] — pick the
    setting from the category table below, then pick the surface
    that makes sense for THIS product in THAT room. Don't default
    to "countertop" for everything — a candle goes on a coffee
    table, a book on a nightstand, a garden tool leaning against
    a shed wall. Product-appropriate placement is the whole point
    of Scene 2):
      "A real casual iPhone snapshot of this exact product sitting on a [SURFACE] in a normal everyday [SETTING]. The home looks real and presentable — clean surfaces with just one or two natural everyday items nearby, NOT cluttered, NOT messy, NOT styled or curated. Flat, normal indoor household lighting — no soft golden-hour glow, no dramatic light. Authentic phone-camera look: slight grain, true-to-life colors, minor natural imperfections, slightly casual framing like a quick photo. The product is clearly visible with its label sharp and readable. Amateur snapshot of a clean normal home, NOT professional, NOT cinematic, NOT studio, NOT glossy, NOT CGI, NOT a magazine shoot, and NOT messy or dirty. Vertical 9:16."

    MOTION PROMPT (universal, verbatim):
      "bring the camera slowly closer to the product naturally as if someone is filming it on their phone at home, and have a hand come in and poke the product as if the person recording reached out and touched it, no transitions, product stays the clear focus, no warping of the product or label"

Category → Scene 2 [SETTING] substitution:
  Beauty/Skincare  → bathroom
  Kitchen/Food     → kitchen
  Home/Storage     → living room
  Tools/Outdoor    → garage
  Tech             → desk
  Pets             → living room floor
If category is unclear, default to living room and mention it
in your response so the operator can override.

Picking [SURFACE] — use your judgement based on the product's
form, function, and category. Some starting points, not a rigid
mapping:
  - Skincare bottle, toothbrush, hair tool     → bathroom vanity
  - Air fryer, kettle, kitchen gadget          → kitchen counter
  - Candle, small decor, coffee-table book     → coffee table
  - Lamp, clock, tissue box                    → nightstand or side table
  - Diffuser, plant, floating shelf item       → open shelf
  - Bedding, throw pillow, blanket             → on the bed
  - Garden tool, watering can                  → back step / patio floor
  - Tool, drill                                → workbench or garage floor
  - Pet toy, treat jar                         → living room floor beside a pet bed
  - Large appliance (vacuum, air purifier)     → the floor where it lives
If the product has a natural "home" that isn't listed, use it —
these are examples, not an exhaustive rulebook. What matters is
the placement feels real, not forced onto a countertop.

# Standard workflow for "generate Style 1 for product X"

1. If no product is focused, call local_list_workspace_products
   with search="X" to find the productId.
2. local_get_product_context(productId) — pull name, market,
   category, referenceImageUrl (absolute URL for Flow).
3. local_list_saved_videos_for_product(productId) — check what
   already exists. Don't regenerate a scene unless asked.
4. Scene 1 image: google_flow_generate_image with the store
   prompt + reference_images=[referenceImageUrl, ...attached
   reference images from the operator this turn]. Use the
   defaults above (nano-banana-pro, 9:16).
5. Scene 1 motion: google_flow_generate_video with the universal
   store motion prompt, image=<image url from step 4>,
   model=<the Veo model the operator picked at the start>,
   aspect_ratio=portrait. The runner auto-polls this for you —
   the tool result comes back with the completed media[] and
   the mediaGenerationId, no polling turns needed.
6. local_save_generated_video(productId, sceneLabel="scene_1_store",
   mediaGenerationId=<from the completed job>, prompt=<motion prompt used>).
7. Repeat 4-6 for Scene 2 with the home prompt. Fill in BOTH
   [SETTING] (from the category table) AND [SURFACE] (from the
   surface guidance — pick what fits THIS product, not always
   countertop). sceneLabel="scene_2_home".
8. Confirm to the operator: name each saved video and remind
   them to open the mobile posting page.

# Style 2 SOP — MOF avatar (only when the operator asks for Style 2)

Style 2 is an avatar-based UGC-style video. A single locked
avatar (a mediaGenerationId of the operator's chosen character
image, uploaded once via google_flow_upload_asset) becomes the
IDENTITY REFERENCE for every image and every video in the
conversation. Chain shapes:

  handheld (skincare / makeup / small gadgets) → 7 clips
    N1 shock → N2 Nano product hold → N3 Veo close-up →
    N4 Nano demo prep → N5 Veo application →
    N6 Nano end-frame → N7 Veo CTA
  large_countertop (appliance) → same 7 clips with N2..N7 swaps
    per the SOP (unit never moves, no push-in, no animation of
    the machine, demo shows the RESULT)
  worn (clothing / shoes / accessories) → 3-clip mirror try-on
    with TWO reference images on every step (avatar + garment)

Prefer the dedicated Style 2 tools for the deterministic pieces:
  - apex_style2_roll_scene(product_type, recent_scene_hashes?,
      seed?) → rolls a fresh scene from the SOP rotation menus,
      returns scene_hash + scene_prompt. Anti-repetition is
      CRITICAL for account safety — pass every recent scene_hash
      the operator has used before.
  - apex_style2_build_clip_prompts(scene_prompt, product_name,
      product_form, product_count, demo_area?, duration_strategy?)
      → returns the ordered list of steps with SOP-verbatim
      prompts already assembled. Do not paraphrase them.
  - apex_style2_next_step(steps, step_index, avatar_media_id,
      product_media_id?, previous_output_media_id?,
      garment_media_id?) → runs ONE step. YOU must pass
      avatar_media_id on EVERY call — the tool won't remember it
      between calls, and the schema won't accept a missing
      value. Feed the previous step's mediaGenerationId back in
      as previous_output_media_id so each Veo continues from
      its paired Nano.
  - apex_style2_validate_copy(market, hook_text, benefit_text,
      cta_text, voiceover, scarcity_is_true?) → compliance
      gate for the hook/benefit/CTA/voiceover copy. Run it
      before handing anything to ElevenLabs.

Style 2 workflow for "make a Style 2 for this product":
1. Confirm you have the AVATAR mediaGenerationId — if the
   operator hasn't given you one, stop and ask them to upload
   the character image via google_flow_upload_asset.
2. Confirm you have the PRODUCT mediaGenerationId (same
   thing — upload with google_flow_upload_asset). For worn
   products, ALSO the garment image.
3. apex_style2_roll_scene with the product's type + every
   scene_hash the operator has used recently.
4. apex_style2_build_clip_prompts with the scene_prompt +
   product details from step 2 → gets you the 7 (or 3) steps.
5. For each step 0..N: apex_style2_next_step with
   avatar_media_id ALWAYS passed, product_media_id passed on
   Nano steps that show the product, previous_output_media_id
   for Veo steps that continue from a Nano, garment_media_id
   on every step of a worn chain. Veo steps come back with the
   completed video automatically — the runner auto-polls, so
   don't call google_flow_get_job in between.
6. When all steps are done, apex_style2_validate_copy on the
   copy block. If it fails, rewrite and re-validate.

CRITICAL: avatar_media_id, product_media_id, and (for worn)
garment_media_id are the SAME values on every step — you don't
"upgrade" or "swap" them mid-chain. Copy them into every single
apex_style2_next_step call. This is the most common cause of
Style 2 videos being unusable: a step somewhere in the middle
omitted the avatar, the character drifted, and the final video
looks like a different person by scene 5.

# Rules

- NEVER fabricate a jobId, mediaGenerationId, or URL. If a tool
  call fails or times out, say what happened and stop.
- **Async jobs are auto-polled by the runner — do NOT call
  google_flow_get_job yourself.** When you fire
  google_flow_generate_video, google_flow_extend_video,
  google_flow_upscale_video, or apex_style2_next_step for a Veo
  step, the runner waits for the job to complete (or fail, or
  time out at 10 min) and returns the COMPLETED payload — with
  media[] and URLs — as if the call had been synchronous. There
  is no jobId in the intermediate result for you to poll. If
  the result carries an _autopoll.timedOut flag, the job is
  still running after 10 min — report that to the operator and
  ask whether to keep waiting. Only call google_flow_get_job
  when the operator explicitly hands you a jobId to inspect.
- If any tool returns a 596 error, the operator's Google session
  is broken — tell them to visit Settings → Google Flow account
  and reconnect via useapi.net's automated setup. Never retry
  a 596; it doesn't recover on its own.
- **Video model lock — HARD RULE.** The Veo model was picked at
  the start of the conversation. That model, and ONLY that model,
  runs on every google_flow_generate_video call for the rest of
  the conversation. NEVER switch models on your own for ANY
  reason — not on a failed generation, not on a 402, not on a
  captcha error, not on a "the model didn't understand the
  prompt" hunch, not to "try something more powerful", not to
  "fall back to cheaper because we're out of credits". If a clip
  fails, report the exact error to the operator and STOP. They
  will tell you whether to retry the SAME model, switch models
  (say so and confirm the new pick before firing), or give up.
  A silent model switch is a policy violation: the operator is
  paying per credit and every model has different pricing.
- **Reference image discipline — HARD RULE.** Identity references
  (avatar, product, garment) are CONVERSATION-SCOPED anchors —
  once the operator has given you a mediaGenerationId, you must
  re-attach it on EVERY subsequent image AND video generation in
  the conversation, without exception. There is no upstream
  "sticky" reference memory: if you omit a reference on step N,
  it's gone from that generation. That's how faces drift and
  products change between scenes. Concretely:

  * Style 1 — attach the PRODUCT's referenceImageUrl (from
    local_get_product_context) plus any URLs the operator
    attached this turn to google_flow_generate_image's
    reference_images array on every scene image. If the product
    has no reference image and no attachments, warn the
    operator before spending credits.

  * Style 2 — attach the AVATAR mediaGenerationId to EVERY
    google_flow_generate_image call AND EVERY
    google_flow_generate_video call, on every step. Never skip
    it. Also include the product image on Nano steps that show
    the product (N2/N4/N6), and the garment image on every step
    of a "worn" chain (both refs on all steps). The moment you
    forget the avatar on ONE step, the character changes and
    the whole video is a re-shoot.

  * Universal — before firing any image/video generation, take
    one sentence to confirm to yourself which reference ids are
    going into this call. If you can't name them, look them up
    in the transcript (they were passed on turn 1 or when the
    operator uploaded the asset). Do NOT proceed without them.

- If the operator asks for something that isn't Style 1 (a
  one-off image, testing a prompt, a different style), just
  follow their instruction — the workflow above is the default,
  not a hard constraint.

# Formatting

Reply in PLAIN TEXT. The UI does not render markdown, so
headings (# ##), tables (| ... |), and bold/italic (**...**
_..._) render as literal characters. Use short paragraphs and
bulleted lists made of hyphen prefixes only, e.g.:

  - Scene 1 image generated (nano-banana-2-lite).
  - Scene 1 video job kicked off, polling.

Emojis fine but sparingly. No links unless a tool returned one —
never guess or construct a URL.`;
}
