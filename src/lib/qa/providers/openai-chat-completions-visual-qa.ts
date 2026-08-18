/**
 * OpenAI Chat Completions visual QA provider.
 *
 * Uses the standard OpenAI SDK against the same endpoint the
 * existing openaiIpRiskVision (src/lib/ai/ip-risk-ai.ts:557)
 * uses — proven pattern, vision-capable models, response_format
 * = json_object for structured output.
 *
 * Credential source: `ResolvedCredential` with
 * apiShape="chat_completions". That covers both `user_key` mode
 * (workspace-configured OpenAI API key) and `app_key` mode
 * (env-based fallback). See src/lib/llm/credentials.ts.
 *
 * Default model: DEFAULT_MODELS.openai (currently "gpt-4o-mini")
 * — the cheapest vision-capable model in the OpenAI catalogue.
 * Callers can pass an explicit override (workspaceSettings.
 * openaiModel) at construction time.
 *
 * Error contract:
 *   - Network / API failures  → ProviderError (with cause)
 *   - Model output not parseable → ProviderValidationError
 *   - Never returns a "default" on failure — the orchestrator
 *     relies on typed exceptions to route to FAILED lifecycle.
 */

import OpenAI from "openai";
import { DEFAULT_MODELS } from "@/lib/ai/types";
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

export interface OpenAiChatCompletionsVisualQaOptions {
  /** API key (from ResolvedCredential.authHeader stripped of
   *  "Bearer " prefix). Trimmed by caller. */
  apiKey: string;
  /** Optional model override. Falls back to DEFAULT_MODELS.openai
   *  ("gpt-4o-mini" as of this file's writing — cheap + vision). */
  model?: string;
  /** Max output tokens. QA output is small (~500-1500 tokens);
   *  we over-provision so chatty responses aren't truncated. */
  maxTokens?: number;
}

export function createOpenAiChatCompletionsVisualQaProvider(
  opts: OpenAiChatCompletionsVisualQaOptions,
): VisualQaProvider {
  const apiKey = (opts.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "OpenAiChatCompletionsVisualQaProvider requires a non-empty apiKey.",
    );
  }
  const model = (opts.model ?? "").trim() || DEFAULT_MODELS.openai;
  const maxTokens = opts.maxTokens ?? 2048;
  const client = new OpenAI({ apiKey });

  return {
    identifier: `openai-chat:${model}`,
    async evaluate(input: VisualQaInput): Promise<VisualQaEvaluation> {
      const system = buildQaSystemPrompt(input.rubric);
      const userText = buildQaUserText(input);

      // Chat Completions vision content shape:
      //   { role, content: [ { type: "text", text }, { type: "image_url", image_url: { url: "data:..;base64,..." } }, ... ] }
      // We use data-URL base64 so the API doesn't try to fetch
      // external URLs (avoids the SSRF surface + matches how
      // ip-risk-ai composes its image inputs when needed).
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      > = [{ type: "text", text: userText }];

      if (input.referenceImage) {
        content.push(dataUrlBlock(input.referenceImage));
      }
      if (input.asset.kind === "image") {
        content.push(dataUrlBlock(input.asset.image));
      } else {
        for (const frame of input.asset.frames) {
          content.push(dataUrlBlock(frame));
        }
      }

      const startMs = Date.now();
      let resp: Awaited<ReturnType<typeof client.chat.completions.create>>;
      try {
        resp = await client.chat.completions.create({
          model,
          max_tokens: maxTokens,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content },
          ],
        });
      } catch (err) {
        throw new ProviderError(
          `OpenAI chat.completions.create failed: ${(err as Error).message?.slice(0, 300) ?? "unknown error"}`,
          { cause: err },
        );
      }
      const elapsedMs = Date.now() - startMs;

      const rawText = (resp.choices?.[0]?.message?.content ?? "").trim();
      if (!rawText) {
        throw new ProviderValidationError(
          "OpenAI returned no text content in the response.",
          JSON.stringify(resp.choices?.[0] ?? {}).slice(0, 500),
        );
      }

      // response_format=json_object should give us clean JSON,
      // but we still run it through the fence-stripper for
      // parity with the Anthropic provider (belt and braces).
      const jsonText = stripJsonFences(rawText);
      const parsed = parseVisualQaResult(jsonText);
      if (!parsed.ok) {
        throw new ProviderValidationError(
          `Model output failed schema validation: ${parsed.error}`,
          rawText,
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

function dataUrlBlock(img: {
  data: string;
  mediaType: FetchedImage["mediaType"];
}): { type: "image_url"; image_url: { url: string } } {
  return {
    type: "image_url",
    image_url: { url: `data:${img.mediaType};base64,${img.data}` },
  };
}
