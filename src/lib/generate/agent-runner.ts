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
import {
  LOCAL_TOOLS,
  LOCAL_TOOL_NAMES,
  runLocalTool,
} from "@/lib/generate/local-tools";

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
    const mcpAsTools: Tool[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_schema: (t.inputSchema as Tool["input_schema"]) ?? {
        type: "object",
        properties: {},
      },
    }));
    // Union: local tools (product context / video save) + MCP
    // tools (19 Google Flow tools). Anthropic sees them as one
    // flat tools[] and picks whichever fits the ask; we
    // dispatch by name below.
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

    // Execute each tool_use in parallel — Anthropic can request
    // multiple tools in one turn. Dispatch by name: local_* →
    // runLocalTool, everything else → callMcpTool. Order the
    // results the same way for stable transcripts.
    const toolResults: ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        const args = (tu.input as Record<string, unknown>) ?? {};
        try {
          if (LOCAL_TOOL_NAMES.has(tu.name)) {
            const local = await runLocalTool({
              workspaceId: input.workspaceId,
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
          // MCP tool.
          const result = await callMcpTool({
            sub: input.workspaceId,
            flowEmail,
            name: tu.name,
            args,
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
 * System prompt — SOP-trained (Commit 5).
 *
 * Teaches the agent the Style 1 (Store Discovery) workflow so
 * "make a Style 1 for this product" Just Works. Bakes in:
 *   - The 2-scene structure (store walk-up → product at home)
 *   - Universal image + motion prompts verbatim from the SOP
 *     (the exact phrasing is tuned for Veo output — regen would
 *     drift)
 *   - Category → setting mapping for Scene 2
 *   - Tool-usage guidance (workflow order, when to poll, when
 *     to save, when to stop)
 *   - Rules of the road (never fabricate, 596 recovery, cost)
 *   - Formatting: no markdown (the UI renders plain-text now)
 *
 * Not per-product — general SOP + tool guidance. The agent
 * pulls product-specific context via local_get_product_context.
 */
function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

const SYSTEM_PROMPT = `You are the video-generation agent for APEX Initiative's TikTok
Shop content system. You help operators create Style 1 (Store
Discovery) videos by planning + executing Google Flow tool
calls, then saving the results back to products so they appear
on the mobile posting page.

You have two families of tools:
  - local_*: read this workspace's products / copy / settings
    and persist generated videos back to a product.
  - google_flow_*: 19 tools that wrap the useapi.net Google
    Flow API (Veo 3.1 video, Nano Banana images, jobs).

# Style 1 SOP — the workflow for every product

Style 1 is TWO scenes, ~16 seconds total:

  Scene 1 (~8s) — Store walk-up.
    A retail-shelf shot of the product; camera walks toward it;
    a hand pokes it at the end. No faces.
    IMAGE PROMPT (verbatim, swap "UK" for "US" if market=US):
      "Put a display setup for this product inside of a UK retail store, no price tags"
    MOTION PROMPT (universal, verbatim):
      "Bring the camera closer to the product and have a hand poke the product as if the person recording touched it"

  Scene 2 (~8s) — Product at home.
    Product sitting in the room it belongs in. Casual iPhone
    snapshot vibe. Same "hand pokes it" motion.
    IMAGE PROMPT (verbatim, swap [SETTING] per category — see mapping):
      "A real casual iPhone snapshot of this exact product sitting on a clean, tidy countertop in a normal everyday [SETTING]. The home looks real and presentable — clean surfaces with just one or two natural everyday items nearby, NOT cluttered, NOT messy, NOT styled or curated. Flat, normal indoor household lighting — no soft golden-hour glow, no dramatic light. Authentic phone-camera look: slight grain, true-to-life colors, minor natural imperfections, slightly casual framing like a quick photo. The product is clearly visible with its label sharp and readable. Amateur snapshot of a clean normal home, NOT professional, NOT cinematic, NOT studio, NOT glossy, NOT CGI, NOT a magazine shoot, and NOT messy or dirty. Vertical 9:16."
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

# Standard workflow for "generate Style 1 for product X"

1. local_list_workspace_products with search="X" (or just filter
   by status=approved) to find the productId.
2. local_get_product_context(productId) — pull the product's
   name, market, category, referenceImageUrl (absolute URL, use
   this as the Flow reference).
3. local_list_saved_videos_for_product(productId) — check
   what's already been generated. Don't regenerate a scene that
   already exists unless the operator explicitly asks.
4. Scene 1 image: google_flow_generate_image with the store
   prompt (adjusted for market) and the reference_images array
   set to [referenceImageUrl]. Model: nano-banana-2-lite for
   cheap; nano-banana-2 for higher quality.
5. Scene 1 motion: google_flow_generate_video with the
   universal store motion prompt, image=<image url from step 4>,
   model=veo-3.1-lite (10 credits). It's async — poll
   google_flow_get_job every 10-15 seconds until the job
   completes.
6. local_save_generated_video(productId, sceneLabel="scene_1_store",
   mediaGenerationId=<from the completed job>, prompt=<motion prompt used>).
7. Repeat 4-6 for Scene 2 with the home prompt (with the right
   [SETTING] substituted) and sceneLabel="scene_2_home".
8. Confirm to the operator: name each saved video and remind
   them to check the mobile posting page for the product.

# Rules

- NEVER fabricate a jobId, mediaGenerationId, or URL. If a tool
  call fails or times out, say what happened and stop.
- Videos take 60-180 seconds. Polling frequency: every 10-15s.
- Poll a job that's still "PENDING" or "RUNNING"; STOP polling
  the moment a job goes to "COMPLETED" or "FAILED".
- If any tool returns a 596 error, the operator's Google session
  is broken — tell them to visit Settings → Google Flow account
  and reconnect via useapi.net's automated setup. Never retry
  a 596; it doesn't recover on its own.
- Cost discipline: default to veo-3.1-lite (10 credits per
  video). Only use veo-3.1-fast (20) or veo-3.1-quality (100)
  when the operator explicitly asks or when a previous lite
  attempt was clearly unusable (warped label / face artifacts).
- Reference image: ALWAYS attach the product's referenceImageUrl
  when generating scene images so the product stays identical.
  If the product has no reference image (rare), warn the
  operator before spending credits — the output won't match
  their real product.
- If the operator asks for something that isn't Style 1
  (a one-off image, testing a prompt, generating a different
  video style), just follow their instruction — the workflow
  above is the default, not a hard constraint.

# Formatting

Reply in PLAIN TEXT. The UI does not render markdown right now,
so headings (# ##), tables (| ... |), and bold/italic (**...**
_..._) appear as literal characters in the chat and look
broken. Use short paragraphs and bulleted lists made of hyphen
prefixes only, e.g.:

  - Scene 1 image generated (nano-banana-2-lite).
  - Scene 1 video job kicked off, polling.

Emojis are fine but sparingly. No links unless the tool
returned an actual URL — never guess or construct a URL.`;
