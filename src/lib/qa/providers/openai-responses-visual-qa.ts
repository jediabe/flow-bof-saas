/**
 * OpenAI Responses API visual QA provider — the ChatGPT-OAuth
 * (Codex Responses) variant.
 *
 * Uses the user's ChatGPT subscription credentials (mode=
 * user_oauth from resolveLlmCredential) so QA runs against the
 * same plan the chat agent uses. No separate API key required.
 *
 * WIRE PROTOCOL:
 *   POST <cred.endpoint>    (Codex Responses URL from
 *                            src/lib/llm/openai-oauth.ts)
 *   Auth: Bearer <access_token>              (from cred.authHeader)
 *   +   chatgpt-account-id: <account_id>     (from cred.extraHeaders)
 *   +   x-openai-internal-codex-responses-lite: true (baked in)
 *   +   OpenAI-Beta: responses=experimental
 *   +   originator: codex_cli_rs
 *
 * Body (per src/lib/llm/responses-loop.ts:190-210 conventions):
 *   {
 *     model,
 *     input: [
 *       { role: "system", content: <system prompt> },
 *       { role: "user", content: [ input_text, input_image, ... ] }
 *     ],
 *     stream: true,                              // required by Codex
 *     store: false,                              // no server-side history
 *     reasoning: { context: "all_turns" },       // co-required
 *     parallel_tool_calls: false                 // co-required
 *   }
 *
 * IMAGE SUPPORT DISCLAIMER:
 *   OpenAI's Responses API accepts input_image content items in
 *   principle. Whether the Codex-lite variant specifically
 *   passes images through to the underlying vision model is
 *   NOT documented and has not been proven in this codebase.
 *   If Codex rejects images with a 400, we surface a clear
 *   ProviderError telling the operator to fall back to
 *   configuring an OpenAI or Anthropic API key in Settings.
 *
 * MODEL CHOICE:
 *   Default "gpt-5.6-sol" — the model the chat agent uses on
 *   the Codex path. If OAuth vision doesn't route to a vision-
 *   capable backend, this may return an error along the lines
 *   of "This model does not support image input" — same
 *   fallback story.
 */

import type { ResolvedCredential } from "@/lib/llm/credentials";
import { ProviderError, ProviderValidationError } from "../errors";
import { parseVisualQaResult } from "../schema";
import type { FetchedImage } from "@/lib/media/fetch-image";
import { buildQaSystemPrompt, buildQaUserText } from "../qa-prompt";
import type {
  VisualQaEvaluation,
  VisualQaInput,
  VisualQaProvider,
} from "../visual-qa-provider";
import { stripJsonFences } from "./anthropic-visual-qa";

export const DEFAULT_CODEX_RESPONSES_MODEL = "gpt-5.6-sol";

export interface OpenAiResponsesVisualQaOptions {
  /** ResolvedCredential from resolveLlmCredential — must have
   *  apiShape="responses" (i.e. mode="user_oauth"). Carries the
   *  endpoint URL, Bearer access token, and chatgpt-account-id
   *  header the Codex backend requires. */
  cred: ResolvedCredential;
  /** Optional model override. Defaults to
   *  DEFAULT_CODEX_RESPONSES_MODEL. */
  model?: string;
}

export function createOpenAiResponsesVisualQaProvider(
  opts: OpenAiResponsesVisualQaOptions,
): VisualQaProvider {
  if (opts.cred.apiShape !== "responses") {
    throw new Error(
      `OpenAiResponsesVisualQaProvider requires apiShape="responses"; got "${opts.cred.apiShape}".`,
    );
  }
  const model = (opts.model ?? "").trim() || DEFAULT_CODEX_RESPONSES_MODEL;
  const cred = opts.cred;

  return {
    identifier: `openai-responses:${model}`,
    async evaluate(input: VisualQaInput): Promise<VisualQaEvaluation> {
      const system = buildQaSystemPrompt(input.rubric);
      const userText = buildQaUserText(input);

      const userContent: ResponsesContentItem[] = [
        { type: "input_text", text: userText },
      ];
      if (input.referenceImage) {
        userContent.push(imageItem(input.referenceImage));
      }
      if (input.asset.kind === "image") {
        userContent.push(imageItem(input.asset.image));
      } else {
        for (const frame of input.asset.frames) {
          userContent.push(imageItem(frame));
        }
      }

      const body: Record<string, unknown> = {
        model,
        input: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
        stream: true,
        store: false,
        reasoning: { context: "all_turns" },
        parallel_tool_calls: false,
      };

      const startMs = Date.now();
      let assembledText: string;
      try {
        assembledText = await streamResponsesText({ cred, body });
      } catch (err) {
        // Surface as ProviderError; caller (orchestrator) catches
        // typed and records a FAILED QaAttempt.
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(
          `Codex Responses call failed: ${(err as Error).message?.slice(0, 300) ?? "unknown error"}`,
          { cause: err },
        );
      }
      const elapsedMs = Date.now() - startMs;

      if (!assembledText.trim()) {
        throw new ProviderValidationError(
          "Codex Responses returned no text content.",
          "<empty stream>",
        );
      }

      const jsonText = stripJsonFences(assembledText);
      const parsed = parseVisualQaResult(jsonText);
      if (!parsed.ok) {
        throw new ProviderValidationError(
          `Model output failed schema validation: ${parsed.error}`,
          assembledText,
        );
      }

      return {
        result: parsed.value,
        providerModel: model,
        elapsedMs,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

type ResponsesContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

function imageItem(img: {
  data: string;
  mediaType: FetchedImage["mediaType"];
}): ResponsesContentItem {
  return {
    type: "input_image",
    image_url: `data:${img.mediaType};base64,${img.data}`,
  };
}

/**
 * Fire one Codex Responses request and stream-assemble the text
 * output. Only handles the shape we need — text output only, no
 * tool calls — so this is a much smaller helper than the tool-
 * loop in src/lib/llm/responses-loop.ts.
 *
 * Codex REQUIRES streaming ("Stream must be set to true" 400
 * otherwise). We consume the SSE, concatenate
 * response.output_text.delta events, and return the finished
 * string when the stream closes.
 *
 * Non-2xx responses throw ProviderError. Empty text throws
 * ProviderValidationError upstream (checked by the caller).
 */
async function streamResponsesText(input: {
  cred: ResolvedCredential;
  body: Record<string, unknown>;
}): Promise<string> {
  const resp = await fetch(input.cred.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: input.cred.authHeader,
      ...input.cred.extraHeaders,
    },
    body: JSON.stringify(input.body),
  });
  if (!resp.ok) {
    // Read up to ~1KB of error body for the operator-facing
    // message. Common failure modes worth naming inline:
    //   400 { detail: "Stream must be set to true" }   ← should not happen; we set it
    //   400 { detail: "This model does not support image input" } ← Codex vision unsupported
    //   401                                            ← OAuth expired mid-request
    //   429                                            ← rate limited
    const bodyText = await safeReadBody(resp, 1024);
    throw new ProviderError(
      `Codex Responses returned HTTP ${resp.status} ${resp.statusText}. ` +
        `Body: ${bodyText || "<empty>"}` +
        (looksLikeImageRejection(resp.status, bodyText)
          ? " — this looks like an image-input rejection. Falling back to another QA provider likely requires an OpenAI or Anthropic API key in workspace Settings."
          : ""),
    );
  }
  if (!resp.body) {
    throw new ProviderError(
      "Codex Responses returned a 2xx but no response body to stream.",
    );
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let assembled = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split on SSE frame separator ("\n\n").
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const delta = parseSseFrame(frame);
        if (delta) assembled += delta;
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  return assembled;
}

/**
 * Parse ONE SSE frame and return the text delta if this is a
 * `response.output_text.delta` event. Returns null for any
 * other event type (function calls, reasoning, etc. — QA never
 * uses tools so we can ignore them).
 */
function parseSseFrame(frame: string): string | null {
  // Ignore comments + heartbeats.
  const dataLines = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return null;
  let evt: unknown;
  try {
    evt = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    evt &&
    typeof evt === "object" &&
    "type" in evt &&
    (evt as { type?: unknown }).type === "response.output_text.delta"
  ) {
    const delta = (evt as { delta?: unknown }).delta;
    if (typeof delta === "string") return delta;
  }
  return null;
}

async function safeReadBody(resp: Response, cap: number): Promise<string> {
  try {
    const text = await resp.text();
    return text.length > cap ? text.slice(0, cap) + "…" : text;
  } catch {
    return "";
  }
}

function looksLikeImageRejection(status: number, body: string): boolean {
  if (status !== 400) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("image") &&
    (lower.includes("not support") ||
      lower.includes("unsupported") ||
      lower.includes("invalid"))
  );
}
