/**
 * Helpers every tool module uses: building a per-request client, wrapping a
 * handler in uniform error handling, and rendering results.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { requireContext } from "../context.js";
import { GoogleFlowClient, readJobId, readRemainingCredits, normalizeMediaList } from "../services/client.js";
import { formatToolError } from "../services/errors.js";
import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat, type MediaItem } from "../types.js";

/**
 * The deployment-wide useapi.net token, set once at startup.
 * Kept module-level rather than in the request context because it is the same
 * for every request — only the Google Flow account varies per user.
 */
let useapiToken: string | null = null;
let useapiBaseUrl: string | undefined;

export function setUseapiConfig(token: string, baseUrl?: string | undefined): void {
  useapiToken = token;
  useapiBaseUrl = baseUrl;
}

/** Builds a client pinned to the current request's Google Flow account. */
export function clientForRequest(): GoogleFlowClient {
  if (!useapiToken) {
    throw new Error("useapi.net token was never configured — call setUseapiConfig() at startup.");
  }
  const { flowEmail } = requireContext();
  return new GoogleFlowClient(useapiToken, flowEmail, useapiBaseUrl);
}

/**
 * Runs a tool body, converting any thrown error into an `isError` result.
 *
 * Errors are reported inside the result rather than as JSON-RPC protocol errors
 * so the agent can read the guidance and correct itself.
 */
export async function runTool(
  fn: (client: GoogleFlowClient) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn(clientForRequest());
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: formatToolError(error) }],
    };
  }
}

/** Truncates oversized text with an explicit notice rather than silently cutting. */
export function capText(text: string, hint?: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const kept = text.slice(0, CHARACTER_LIMIT - 300);
  return (
    `${kept}\n\n---\n[Response truncated: ${text.length} characters exceeded the ` +
    `${CHARACTER_LIMIT}-character limit.${hint ? ` ${hint}` : ""}]`
  );
}

/** Standard result builder: text content plus machine-readable structuredContent. */
export function result(
  structured: Record<string, unknown>,
  markdown: string,
  format: ResponseFormat,
  truncationHint?: string,
): CallToolResult {
  const text =
    format === ResponseFormat.JSON
      ? JSON.stringify(structured, null, 2)
      : markdown;
  return {
    content: [{ type: "text", text: capText(text, truncationHint) }],
    structuredContent: structured,
  };
}

/** Renders a normalized media list as compact markdown. */
export function renderMedia(media: MediaItem[]): string {
  if (!media.length) return "_No media returned._";
  return media
    .map((m, i) => {
      const lines = [`**${i + 1}. ${m.kind}**`];
      if (m.mediaGenerationId) lines.push(`- mediaGenerationId: \`${m.mediaGenerationId}\``);
      if (m.url) lines.push(`- url: ${m.url}`);
      if (m.thumbnailUrl) lines.push(`- thumbnail: ${m.thumbnailUrl}`);
      if (m.seed !== undefined) lines.push(`- seed: ${m.seed}`);
      if (m.model) lines.push(`- model: ${m.model}`);
      if (m.aspectRatio) lines.push(`- aspectRatio: ${m.aspectRatio}`);
      if (m.durationSeconds !== undefined) lines.push(`- duration: ${m.durationSeconds}s`);
      if (m.hasInlineBase64) {
        lines.push("- note: returned as inline base64 rather than a signed URL");
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Shared post-processing for the four generation endpoints, all of which return
 * either an async job stub or a synchronous media payload.
 */
export function generationResult(
  raw: unknown,
  opts: {
    operation: string;
    isAsync: boolean;
    format: ResponseFormat;
  },
): CallToolResult {
  const jobId = readJobId(raw);
  const rawRecord = (raw ?? {}) as Record<string, unknown>;
  const media = normalizeMediaList(
    rawRecord["media"] ??
      (rawRecord["response"] as Record<string, unknown> | undefined)?.["media"],
  );
  const remainingCredits = readRemainingCredits(raw);

  const structured = {
    operation: opts.operation,
    mode: opts.isAsync ? "async" : "sync",
    jobId: jobId ?? null,
    status: (rawRecord["status"] as string | undefined) ?? (media.length ? "completed" : "unknown"),
    media,
    ...(remainingCredits !== undefined ? { remainingCredits } : {}),
    raw: rawRecord,
  };

  const md = opts.isAsync
    ? [
        `# ${opts.operation} submitted`,
        "",
        `- **jobId**: \`${jobId ?? "(not returned)"}\``,
        `- **status**: ${structured.status}`,
        "",
        jobId
          ? `Poll \`google_flow_get_job\` with this jobId. Video generation typically finishes in 60-180 seconds; wait ~15 seconds between polls.`
          : "No jobId was returned — inspect the raw payload.",
      ].join("\n")
    : [
        `# ${opts.operation} complete`,
        "",
        jobId ? `- **jobId**: \`${jobId}\`` : "",
        remainingCredits !== undefined ? `- **remaining credits**: ${remainingCredits}` : "",
        "",
        renderMedia(media),
        "",
        media.some((m) => m.url)
          ? "_Signed URLs expire in roughly 6-24 hours. Download promptly, or re-resolve with google_flow_get_asset._"
          : "",
      ]
        .filter(Boolean)
        .join("\n");

  return result(structured, md, opts.format, "Request response_format='markdown' for a shorter summary.");
}
