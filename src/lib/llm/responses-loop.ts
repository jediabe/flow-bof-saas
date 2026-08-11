/**
 * OpenAI Responses API tool-use loop — the LLM driver for the
 * user_oauth (ChatGPT-subscription) credential mode.
 *
 * Structurally mirrors the Anthropic Messages loop in
 * agent-runner.ts, but speaks a completely different wire
 * protocol:
 *
 *   Anthropic Messages                | OpenAI Responses
 *   ----------------------------------+-------------------------------
 *   POST /v1/messages                 | POST /codex/responses
 *   { messages: [{role, content:[]}]}| { input: [...items...], tools }
 *   content blocks (text, tool_use,   | output items (message,
 *   tool_result)                       |  function_call, reasoning)
 *   tools: [{name, input_schema}]     | tools: [{type:"function",
 *                                     |          name, parameters}]
 *   role="user" + tool_result block   | {type:"function_call_output",
 *                                     |  call_id, output}
 *   stop_reason: "tool_use"|"end_turn"| Terminate when the last
 *                                     |  response has zero
 *                                     |  function_call items
 *
 * The loop persists to the SAME DB message shape the Anthropic
 * loop uses (role + content + toolCallsJson + toolResultJson) —
 * translated on read/write — so the chat transcript UI doesn't
 * need to know which provider drove any given turn.
 *
 * Auth: caller passes the ResolvedCredential from
 * resolveLlmCredential(); we use its endpoint, authHeader, and
 * extraHeaders verbatim. The chatgpt-account-id header is
 * required by the Codex backend and is set by the resolver.
 *
 * Tool schemas: the caller hands us Anthropic-shape tool
 * schemas (input_schema); we translate to OpenAI function-call
 * shape (parameters) before sending, and translate the
 * function_call output items back to our dispatchTool() call
 * shape. Tool RESULTS get stringified back into
 * function_call_output items.
 *
 * Async job polling: the caller's dispatchTool() is already
 * wrapped with the same auto-poll logic used by the Anthropic
 * path — no extra work here.
 */

import type { AgentEvent } from "@/lib/generate/agent-runner";
import type { ResolvedCredential } from "./credentials";

/* ==================================================================
 * Types
 * ================================================================ */

/**
 * MCP + local tool schema the caller hands us — same shape the
 * Anthropic SDK's `Tool` type uses so agent-runner doesn't have
 * to convert.
 */
export interface AnthropicShapeTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/**
 * Persisted DB row → for rehydrating into Responses input items.
 * Same fields as agent-runner's rehydrateMessage() reads.
 */
export interface StoredMessage {
  role: "user" | "assistant" | string;
  content: string;
  toolCallsJson: string | null;
  toolResultJson: string | null;
  attachedImagesJson: string | null;
}

/**
 * Persistence + dispatch hooks the loop calls back into. Kept as
 * callbacks so the loop stays independent of Prisma / MCP client.
 */
export interface ResponsesLoopHooks {
  /** Persist an assistant turn (text + optional function_calls).
   *  Returns the created message id for the message_saved event. */
  persistAssistant: (input: {
    content: string;
    toolCalls: OpenAiFunctionCallOutput[];
  }) => Promise<{ id: string }>;
  /** Persist a paired tool-result row (role="user" with
   *  toolResultJson populated). Returns the id. */
  persistToolResult: (input: {
    callId: string;
    toolName: string;
    output: string;
    isError: boolean;
  }) => Promise<{ id: string }>;
  /** Dispatch a tool call by name — the caller's shared
   *  local_tool + MCP dispatcher, including auto-poll. */
  dispatchTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: string; isError: boolean }>;
}

/** A function_call item pulled out of a Responses output. */
export interface OpenAiFunctionCallOutput {
  callId: string;
  name: string;
  /** JSON-string arguments per the OpenAI spec — we forward as-is
   *  to the transcript UI and JSON.parse before dispatching. */
  arguments: string;
}

export interface ResponsesLoopInput {
  cred: ResolvedCredential;
  model: string;
  systemPrompt: string;
  tools: AnthropicShapeTool[];
  /** Full DB message history to rehydrate — must include the
   *  fresh user turn already persisted so the model sees it. */
  storedHistory: StoredMessage[];
  hooks: ResponsesLoopHooks;
  /** Optional reasoning effort — passed through to the API. The
   *  Codex config uses "medium" as the default; ChatGPT plan
   *  models accept "low" | "medium" | "high" | "xhigh" | "none". */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "none";
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 30;

/* ==================================================================
 * The loop
 * ================================================================ */

export async function* runResponsesLoop(
  input: ResponsesLoopInput,
): AsyncGenerator<AgentEvent, void, void> {
  const inputItems: ResponsesInputItem[] = [
    { role: "system", content: input.systemPrompt },
    ...rehydrateToInputItems(input.storedHistory),
  ];
  const openaiTools: OpenAiTool[] = input.tools.map(anthropicToolToOpenAi);

  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    console.log(
      `[responses-loop] iter=${iter} → POST ${input.cred.endpoint} model=${input.model} input_items=${inputItems.length} tools=${openaiTools.length}`,
    );

    // Codex requires streaming responses ("Stream must be set
    // to true" 400 otherwise). We stream, parse SSE frames as
    // they arrive, forward text deltas straight to the client
    // for a live-typing effect, and accumulate the finalized
    // output items to drive the tool-dispatch phase after.
    let textContent = "";
    const functionCalls: OpenAiFunctionCallOutput[] = [];
    // Assemble function_call arguments from streamed deltas.
    // The Codex Responses stream emits arguments piecewise:
    // response.function_call_arguments.delta events, then a
    // response.output_item.done event carries the full item.
    // Both paths accumulate into this map keyed by call_id.
    const fcInProgress = new Map<
      string,
      { name: string; args: string }
    >();

    let streamOk = false;
    try {
      for await (const evt of streamResponsesApi({
        cred: input.cred,
        body: {
          model: input.model,
          input: inputItems,
          tools: openaiTools,
          store: false,
          stream: true,
          ...(input.reasoningEffort
            ? { reasoning: { effort: input.reasoningEffort } }
            : {}),
        },
      })) {
        streamOk = true;
        const type = typeof evt.type === "string" ? evt.type : "";

        // Text streaming — forward the delta to the client so
        // it renders live, and accumulate for the persisted
        // assistant row.
        if (type === "response.output_text.delta") {
          const delta = typeof evt.delta === "string" ? evt.delta : "";
          if (delta) {
            textContent += delta;
            yield { type: "text_delta", delta };
          }
          continue;
        }

        // Function-call arguments streaming — accumulate.
        if (type === "response.function_call_arguments.delta") {
          const callId =
            typeof evt.item_id === "string"
              ? evt.item_id
              : typeof evt.id === "string"
                ? evt.id
                : "";
          if (!callId) continue;
          const chunk = typeof evt.delta === "string" ? evt.delta : "";
          const existing = fcInProgress.get(callId) ?? { name: "", args: "" };
          existing.args += chunk;
          fcInProgress.set(callId, existing);
          continue;
        }

        // A finalized output item — could be a message (already
        // captured via deltas), function_call (finalize into
        // functionCalls[]), or reasoning (ignore).
        if (type === "response.output_item.done" && evt.item) {
          const item = evt.item as {
            type?: string;
            id?: string;
            call_id?: string;
            name?: string;
            arguments?: string;
          };
          if (item.type === "function_call") {
            const callId = item.call_id ?? item.id ?? `fc-${Date.now()}`;
            const args =
              typeof item.arguments === "string"
                ? item.arguments
                : (fcInProgress.get(callId)?.args ?? "{}");
            functionCalls.push({
              callId,
              name: item.name ?? "unknown_tool",
              arguments: args || "{}",
            });
          }
          continue;
        }

        // Error events sent by the server mid-stream.
        if (type === "error" || type === "response.error") {
          const message =
            typeof evt.error === "object" && evt.error && "message" in evt.error
              ? String((evt.error as { message: unknown }).message)
              : "unknown streaming error";
          throw new Error(`stream error: ${message}`);
        }

        // response.completed / response.created / lifecycle
        // events — nothing to do; keep reading until the
        // stream naturally ends.
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      console.warn(
        `[responses-loop] iter=${iter} fetch error: ${message.slice(0, 2000)}`,
      );
      yield {
        type: "error",
        message: `OpenAI Responses error: ${message.slice(0, 400)}`,
      };
      return;
    }

    console.log(
      `[responses-loop] iter=${iter} ← stream_ok=${streamOk} text=${textContent.length}ch function_calls=${functionCalls.length}`,
    );

    // Empty-response guard.
    if (
      iter === 0 &&
      textContent.length === 0 &&
      functionCalls.length === 0
    ) {
      console.warn(
        `[responses-loop] iter=0 empty output. stream_ok=${streamOk}`,
      );
      yield {
        type: "error",
        message:
          "The OpenAI Responses API stream ended without any text or tool calls. The model may have refused the prompt, or the account/plan doesn't have access to this model. Check the docker logs.",
      };
      return;
    }

    for (const fc of functionCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(fc.arguments) as Record<string, unknown>;
      } catch {
        // Model emitted invalid JSON. Yield the tool_call so the
        // UI shows something, then let dispatchTool fail cleanly.
      }
      yield {
        type: "tool_call",
        toolUseId: fc.callId,
        name: fc.name,
        input: parsedArgs,
      };
    }

    // Persist the assistant turn. Even if empty text, keep the
    // row so the tool_use pill shows in the transcript.
    const assistant = await input.hooks.persistAssistant({
      content: textContent,
      toolCalls: functionCalls,
    });
    yield {
      type: "message_saved",
      messageId: assistant.id,
      role: "assistant",
    };

    // Feed the assistant's raw message + function_call items
    // back into the input array for the next iteration.
    if (textContent) {
      inputItems.push({
        role: "assistant",
        content: textContent,
      });
    }
    for (const fc of functionCalls) {
      inputItems.push({
        type: "function_call",
        call_id: fc.callId,
        name: fc.name,
        arguments: fc.arguments,
      });
    }

    if (functionCalls.length === 0) {
      // Terminal — no more tools to run.
      break;
    }

    // Dispatch each function_call in parallel — same as the
    // Anthropic loop's Promise.all pattern. dispatchTool
    // includes auto-poll for async jobs.
    const results = await Promise.all(
      functionCalls.map(async (fc) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(fc.arguments) as Record<string, unknown>;
        } catch (err) {
          return {
            fc,
            output: `Tool call failed: invalid JSON arguments: ${(err as Error).message}`,
            isError: true,
          };
        }
        try {
          const r = await input.hooks.dispatchTool(fc.name, args);
          return { fc, output: r.content || "(empty)", isError: r.isError };
        } catch (err) {
          return {
            fc,
            output: `Tool call failed: ${(err as Error).message?.slice(0, 300)}`,
            isError: true,
          };
        }
      }),
    );

    // Emit tool_result + persist + append to input items.
    for (const r of results) {
      yield {
        type: "tool_result",
        toolUseId: r.fc.callId,
        isError: r.isError,
        preview: r.output.slice(0, 200),
      };
      const row = await input.hooks.persistToolResult({
        callId: r.fc.callId,
        toolName: r.fc.name,
        output: r.output,
        isError: r.isError,
      });
      yield { type: "message_saved", messageId: row.id, role: "user" };
      inputItems.push({
        type: "function_call_output",
        call_id: r.fc.callId,
        output: r.output,
      });
    }
  }

  yield { type: "done" };
}

/* ==================================================================
 * Wire-shape types + HTTP call
 * ================================================================ */

interface OpenAiTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

type ResponsesInputItem =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

/**
 * Streaming variant of the Codex Responses POST. The endpoint
 * REQUIRES `stream: true` — a non-streaming request comes back
 * with { detail: "Stream must be set to true" } as a 400.
 *
 * Yields parsed SSE event objects as they arrive. Each event's
 * shape depends on its .type — the caller does the typed
 * dispatch (response.output_text.delta,
 * response.function_call_arguments.delta,
 * response.output_item.done, response.completed, error, ...).
 *
 * The stream terminates on either "data: [DONE]" (OpenAI's
 * end-of-stream sentinel) or when the underlying fetch body
 * closes. HTTP errors (non-2xx) throw synchronously before the
 * first event is yielded.
 */
async function* streamResponsesApi(input: {
  cred: ResolvedCredential;
  body: Record<string, unknown>;
}): AsyncGenerator<Record<string, unknown>, void, void> {
  const resp = await fetch(input.cred.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: input.cred.authHeader,
      ...input.cred.extraHeaders,
    },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(600_000), // 10 min cap for very long turns
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new Error(
      `HTTP ${resp.status} from ${input.cred.endpoint}: ${bodyText.slice(0, 400)}`,
    );
  }
  if (!resp.body) {
    throw new Error("Response has no body — streaming not supported by transport");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames separated by "\n\n". Each frame is 1+ lines
      // like "event: ...\ndata: {...}". We only consume the
      // data line — the event type is inside the JSON payload
      // as .type anyway.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        // Concatenate ALL "data:" lines in the frame (SSE
        // allows multi-line data payloads).
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("data:")) {
            data += line.slice(5).trim();
          }
        }
        if (!data) continue;
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          yield parsed;
        } catch {
          // Malformed frame — log & skip rather than crash the
          // whole turn.
          console.warn(
            `[responses-loop] skipping malformed SSE frame: ${data.slice(0, 200)}`,
          );
        }
      }
    }
  } finally {
    // Best-effort cancel — if we broke out early the reader
    // holds the socket open until GC.
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

/* ==================================================================
 * Translation: Anthropic tool schema → OpenAI function tool
 * ================================================================ */

function anthropicToolToOpenAi(t: AnthropicShapeTool): OpenAiTool {
  return {
    type: "function",
    name: t.name,
    description: t.description ?? "",
    // input_schema is already a JSON schema object with
    // {type: "object", properties, required, ...} — same shape
    // OpenAI's `parameters` expects.
    parameters: t.input_schema,
  };
}

/* ==================================================================
 * Rehydrate DB rows → Responses input items
 *
 * The DB schema stores messages in an Anthropic-flavored shape:
 *   assistant row  → content (text) + toolCallsJson (array of
 *                    Anthropic tool_use blocks)
 *   user row       → content (text) OR toolResultJson (a single
 *                    Anthropic tool_result block)
 *
 * We translate each row into 1+ Responses input items:
 *   assistant text            → { role: "assistant", content }
 *   assistant tool_use[]      → { type: "function_call", call_id, name, arguments } per tool
 *   user text                 → { role: "user", content }
 *   user tool_result          → { type: "function_call_output", call_id, output }
 * ================================================================ */

function rehydrateToInputItems(rows: StoredMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const row of rows) {
    if (row.role === "assistant") {
      if (row.content && row.content.trim()) {
        out.push({ role: "assistant", content: row.content });
      }
      const toolUses = safeParseToolUses(row.toolCallsJson);
      for (const tu of toolUses) {
        out.push({
          type: "function_call",
          call_id: tu.id,
          name: tu.name,
          arguments: JSON.stringify(tu.input ?? {}),
        });
      }
      continue;
    }
    // user
    if (row.toolResultJson) {
      const decoded = safeParseToolResult(row.toolResultJson);
      if (decoded) {
        out.push({
          type: "function_call_output",
          call_id: decoded.tool_use_id,
          output: decoded.content,
        });
        continue;
      }
    }
    // Plain user turn — prepend attached-image URLs the way the
    // Anthropic rehydrator does, so both providers see the same
    // context.
    const imageUrls = safeParseImages(row.attachedImagesJson);
    if (imageUrls.length > 0) {
      const preamble =
        "[Reference images the operator attached to this turn]:\n" +
        imageUrls.map((u, i) => `${i + 1}. ${u}`).join("\n");
      out.push({
        role: "user",
        content: row.content ? `${preamble}\n\n${row.content}` : preamble,
      });
    } else if (row.content && row.content.trim()) {
      out.push({ role: "user", content: row.content });
    }
  }
  return out;
}

interface AnthropicToolUse {
  id: string;
  name: string;
  input: unknown;
}

function safeParseToolUses(json: string | null): AnthropicToolUse[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is AnthropicToolUse =>
        x && typeof x === "object" &&
        typeof x.id === "string" &&
        typeof x.name === "string",
    );
  } catch {
    return [];
  }
}

function safeParseToolResult(
  json: string,
): { tool_use_id: string; content: string } | null {
  try {
    const v = JSON.parse(json) as {
      tool_use_id?: string;
      content?: unknown;
    };
    if (typeof v.tool_use_id !== "string") return null;
    const content =
      typeof v.content === "string"
        ? v.content
        : JSON.stringify(v.content ?? "");
    return { tool_use_id: v.tool_use_id, content };
  } catch {
    return null;
  }
}

function safeParseImages(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
