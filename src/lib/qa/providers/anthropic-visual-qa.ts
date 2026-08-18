/**
 * Anthropic-backed VisualQaProvider.
 *
 * Uses the existing @anthropic-ai/sdk pattern (see
 * src/lib/ai/ip-risk-ai.ts anthropicIpRiskVision for the sister
 * implementation) — same client construction, same content-block
 * shape, same JSON-only system-prompt convention.
 *
 * Model default: DEFAULT_MODELS.anthropic (currently
 * claude-3-5-sonnet-latest). Vision-capable. The orchestrator
 * can pass an explicit override at construction time if the
 * workspace's WorkspaceSettings.anthropicModel is set — same
 * fallback pattern IP-risk uses.
 *
 * ERROR CONTRACT (see visual-qa-provider.ts):
 *   - Network / API failures  → throw ProviderError (with cause)
 *   - Model output not parseable → throw ProviderValidationError
 *   - Wraps SDK errors so callers see ProviderError instances,
 *     not raw Anthropic SDK errors.
 */

import Anthropic from "@anthropic-ai/sdk";
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

export interface AnthropicVisualQaOptions {
  /** Workspace's Anthropic API key. Trimmed by the caller. */
  apiKey: string;
  /** Optional workspace override; falls back to DEFAULT_MODELS.anthropic. */
  model?: string;
  /**
   * Max output tokens. QA output is small (~500-1500 tokens for
   * a 10-criterion result with a handful of issues) — but we
   * over-provision so a chatty response doesn't get truncated.
   */
  maxTokens?: number;
}

export function createAnthropicVisualQaProvider(
  opts: AnthropicVisualQaOptions,
): VisualQaProvider {
  const apiKey = (opts.apiKey ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "AnthropicVisualQaProvider requires a non-empty apiKey.",
    );
  }
  const model = (opts.model ?? "").trim() || DEFAULT_MODELS.anthropic;
  const maxTokens = opts.maxTokens ?? 2048;
  const client = new Anthropic({ apiKey });

  return {
    identifier: `anthropic:${model}`,
    async evaluate(input: VisualQaInput): Promise<VisualQaEvaluation> {
      const system = buildQaSystemPrompt(input.rubric);
      const userText = buildQaUserText(input);

      const contentBlocks: Array<
        | { type: "text"; text: string }
        | {
            type: "image";
            source: {
              type: "base64";
              media_type: FetchedImage["mediaType"];
              data: string;
            };
          }
      > = [{ type: "text", text: userText }];

      if (input.referenceImage) {
        contentBlocks.push(imageBlock(input.referenceImage));
      }
      if (input.asset.kind === "image") {
        contentBlocks.push(imageBlock(input.asset.image));
      } else {
        // Video: each frame becomes its own image block. Order
        // preserved — the user-text told the model these are in
        // chronological order.
        for (const frame of input.asset.frames) {
          contentBlocks.push(imageBlock(frame));
        }
      }

      const startMs = Date.now();
      let message: Awaited<ReturnType<typeof client.messages.create>>;
      try {
        message = await client.messages.create({
          model,
          max_tokens: maxTokens,
          // Low temperature — deterministic-ish scoring is more
          // useful than creative variance for a rubric task.
          temperature: 0.1,
          system,
          messages: [{ role: "user", content: contentBlocks }],
        });
      } catch (err) {
        throw new ProviderError(
          `Anthropic messages.create failed: ${(err as Error).message?.slice(0, 300) ?? "unknown error"}`,
          { cause: err },
        );
      }
      const elapsedMs = Date.now() - startMs;

      // Flatten every text block returned. The system prompt
      // tells the model "JSON only, no markdown" but some models
      // still slip a stray backtick fence in — the extract helper
      // handles that.
      const rawText = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();

      if (!rawText) {
        throw new ProviderValidationError(
          "Anthropic returned no text content in the response.",
          JSON.stringify(message.content).slice(0, 500),
        );
      }

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

function imageBlock(img: {
  data: string;
  mediaType: FetchedImage["mediaType"];
}): {
  type: "image";
  source: {
    type: "base64";
    media_type: FetchedImage["mediaType"];
    data: string;
  };
} {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: img.mediaType,
      data: img.data,
    },
  };
}

/**
 * The system prompt tells the model to emit raw JSON. In
 * practice some responses arrive wrapped in ```json ... ```
 * fences or with leading/trailing prose. Strip the common
 * variants; leave the rest to the Zod validator.
 *
 * Exported for tests — the extraction logic is worth pinning
 * because a regression here silently converts model chatter
 * into ProviderValidationError instead of clean parsing.
 */
export function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  // ```json ... ```  or  ``` ... ```
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // Occasionally the model emits `{ ... }` with prose before/after.
  // Grab the first {...} balanced block if the whole string doesn't
  // start with {.
  if (!trimmed.startsWith("{")) {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }
  }
  return trimmed;
}
