/**
 * Error types and agent-facing error formatting.
 *
 * Every message here is written for an LLM reading a failed tool result: it
 * states what went wrong and what to do next, because a bare status code
 * usually sends an agent into a retry loop.
 */

export class GoogleFlowApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly endpoint: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GoogleFlowApiError";
  }
}

export class GoogleFlowTimeoutError extends Error {
  constructor(readonly endpoint: string, readonly timeoutMs: number) {
    super(`Request to ${endpoint} timed out after ${timeoutMs}ms`);
    this.name = "GoogleFlowTimeoutError";
  }
}

/** Pulls a human-readable message out of useapi.net's varied error shapes. */
export function extractApiMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.slice(0, 500);
  if (!body || typeof body !== "object") return undefined;

  const b = body as Record<string, unknown>;
  const candidates: unknown[] = [
    b["error"],
    b["message"],
    (b["response"] as Record<string, unknown> | undefined)?.["error"],
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.slice(0, 500);
    if (c && typeof c === "object") {
      const m = (c as Record<string, unknown>)["message"];
      if (typeof m === "string" && m.trim()) return m.slice(0, 500);
    }
  }
  return undefined;
}

/**
 * Converts any thrown error into the text an agent sees, with a concrete
 * next step attached wherever the status code implies one.
 */
export function formatToolError(error: unknown): string {
  if (error instanceof GoogleFlowTimeoutError) {
    return (
      `Error: the request to ${error.endpoint} timed out after ${Math.round(error.timeoutMs / 1000)}s. ` +
      "For video generation, submit with async=true and poll google_flow_get_job instead of waiting inline."
    );
  }

  if (error instanceof GoogleFlowApiError) {
    const detail = extractApiMessage(error.body);
    const suffix = detail ? ` API said: ${detail}` : "";

    switch (error.status) {
      case 400:
        return (
          `Error: the Google Flow API rejected the request (400 Bad Request).${suffix} ` +
          "Check parameter names, enum values, and that any mediaGenerationId you passed " +
          "belongs to the same Google Flow account. If the prompt was flagged " +
          "(PUBLIC_ERROR_UNSAFE_GENERATION), rewrite it and try again."
        );
      case 401:
        return (
          "Error: the useapi.net API token was rejected (401 Unauthorized). " +
          "This is a server configuration problem, not something the user did — " +
          "report it rather than retrying."
        );
      case 402:
        return (
          `Error: insufficient credits or subscription tier (402).${suffix} ` +
          "Call google_flow_get_account to check the remaining credit balance and paygate tier. " +
          "Some models (veo-3.1-quality, 4K upscale, veo-3.1-lite-low-priority) require a paid Google AI tier."
        );
      case 403:
        return (
          `Error: access denied (403).${suffix} ` +
          "This usually means the resource belongs to a different useapi.net user, " +
          "or the requested quality tier is not included in the account's Google AI plan."
        );
      case 404:
        return (
          `Error: not found (404).${suffix} ` +
          "Verify the jobId, mediaGenerationId, account email, or character/voice ref. " +
          "Signed asset URLs expire after roughly 6 hours; re-resolve with google_flow_get_asset."
        );
      case 408:
        return (
          `Error: Google Flow stopped polling before generation finished (408).${suffix} ` +
          "Resubmit with async=true and poll google_flow_get_job rather than waiting inline."
        );
      case 429: {
        const wait = error.retryAfterSeconds
          ? `Retry after about ${error.retryAfterSeconds} seconds.`
          : "Throttling windows are typically 60 seconds for traffic spikes and about 30 minutes for user quota.";
        return (
          `Error: rate limited (429).${suffix} ${wait} ` +
          "This throttle is on the user's own Google account, so there is no other account to route around it."
        );
      }
      case 502:
        return (
          `Error: Google returned an unexpected response (502).${suffix} ` +
          "This is transient — wait a few seconds and retry once."
        );
      case 503:
        return (
          `Error: service unavailable or media not ready (503).${suffix} ` +
          "Wait 15-30 seconds and retry. If this came from a captcha provider, the account may be out of captcha credits."
        );
      case 596:
        return (
          `Error: this user's Google Flow session has broken and could not be refreshed (596).${suffix} ` +
          "Nothing will generate until they reconnect their Google Flow account. This most often " +
          "happens because the account was opened directly in a browser, which invalidates the " +
          "session the API holds. Tell the user they need to reconnect; do not retry."
        );
      default:
        return `Error: Google Flow API request to ${error.endpoint} failed with status ${error.status}.${suffix}`;
    }
  }

  if (error instanceof Error) {
    // Validation errors thrown by tool bodies already read as "Error: ...".
    return /^error[:\s]/i.test(error.message)
      ? error.message
      : `Error: ${error.message}`;
  }
  return `Error: unexpected failure: ${String(error)}`;
}
