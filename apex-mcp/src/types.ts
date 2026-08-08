/** Shared TypeScript types for the Google Flow MCP server. */

/**
 * Per-request context established by the auth middleware.
 *
 * `flowEmail` is the security boundary of this server. It arrives inside a
 * signed token from your backend, never from the model, and every upstream call
 * is pinned to it — so one user's prompt can never spend another user's Google
 * Flow credits.
 */
export interface RequestContext {
  userId: string;
  flowEmail: string;
  requestId: string;
}

/** Normalized job record, tolerant of the API's `jobId`/`jobid` casing split. */
export interface NormalizedJob {
  jobId: string;
  type: "video" | "image" | string;
  status: "created" | "started" | "completed" | "failed" | string;
  created?: string;
  updated?: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  error?: unknown;
  code?: unknown;
}

/** A single generated asset, flattened from the API's several nesting shapes. */
export interface MediaItem {
  mediaGenerationId?: string;
  kind: "video" | "image";
  url?: string;
  thumbnailUrl?: string;
  seed?: number;
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  /** Present when the API inlined base64 instead of returning a signed URL. */
  hasInlineBase64?: boolean;
}

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}
