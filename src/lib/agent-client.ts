/**
 * Local agent HTTP client.
 *
 * Talks to the Flow BOF Local Agent (sibling repo flow-bof-automation,
 * src/agent_server.py). The agent exposes:
 *
 *   GET  /                — identity + auth_required flag.
 *   GET  /health          — runs the underlying health_check job.
 *   GET  /jobs/types      — list of registered job types.
 *   POST /jobs/run        — submit a full job envelope, await final result.
 *   POST /jobs/run-stream — same, but streams NDJSON progress events.
 *
 * Job envelope shape (all calls):
 *
 *   {
 *     "protocol_version": "0.1",
 *     "job_id": "<id>",
 *     "job_type": "<type>",
 *     "payload": {...}
 *   }
 *
 * This module is transport-only. It does NOT touch the database. Server
 * actions wrap it to persist results.
 */

export const PROTOCOL_VERSION = "0.1";

export type JobType =
  | "health_check"
  | "check_flow_connection"
  | "scan_favorited_images"
  | "generate_flow_images"
  | "generate_flow_videos_from_favorites";

export interface JobEnvelopeRequest {
  protocol_version: typeof PROTOCOL_VERSION;
  job_id: string;
  job_type: string;
  payload: Record<string, unknown>;
}

export interface JobEnvelopeResponse {
  protocol_version: string;
  job_id: string;
  job_type: string;
  status: "succeeded" | "failed";
  result: Record<string, unknown> | null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } | null;
}

export interface ProgressEvent {
  protocol_version: string;
  job_id: string;
  job_type: string;
  event_type: "progress";
  stage: string;
  message: string;
  current: number | null;
  total: number | null;
  details: Record<string, unknown>;
}

export interface ResultEvent {
  event_type: "result";
  envelope: JobEnvelopeResponse;
}

export type StreamEvent = ProgressEvent | ResultEvent;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function normalizeBase(url: string): string {
  return (url || "").replace(/\/+$/, "");
}

/** Build a job envelope from (type, payload, id?). */
export function buildEnvelope(
  jobType: string,
  payload: Record<string, unknown> = {},
  jobId?: string,
): JobEnvelopeRequest {
  return {
    protocol_version: PROTOCOL_VERSION,
    job_id: jobId ?? `saas-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    job_type: jobType,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * GET /health on the agent. Always returns a structured envelope; the
 * envelope's `status` field tells you whether the underlying
 * health_check job succeeded.
 *
 * Throws only on transport failure (agent not reachable / refused
 * connection). HTTP 4xx/5xx errors return an envelope-shaped object.
 */
export async function getHealth(
  agentBaseUrl: string,
  token?: string,
): Promise<JobEnvelopeResponse> {
  const url = `${normalizeBase(agentBaseUrl)}/health`;
  const r = await fetch(url, {
    headers: authHeaders(token),
    // Don't cache — health is a live signal.
    cache: "no-store",
  });
  if (!r.ok) {
    return {
      protocol_version: PROTOCOL_VERSION,
      job_id: "client-health",
      job_type: "health_check",
      status: "failed",
      result: null,
      error: {
        code: "AGENT_HTTP_ERROR",
        message: `Agent returned HTTP ${r.status}`,
        details: { url, body: (await r.text()).slice(0, 400) },
      },
    };
  }
  return (await r.json()) as JobEnvelopeResponse;
}

/** GET /jobs/types — list of job types the agent currently understands. */
export async function getJobTypes(
  agentBaseUrl: string,
  token?: string,
): Promise<{
  protocol_version: string;
  agent_version: string;
  job_types: string[];
}> {
  const url = `${normalizeBase(agentBaseUrl)}/jobs/types`;
  const r = await fetch(url, { headers: authHeaders(token), cache: "no-store" });
  if (!r.ok) {
    throw new Error(`/jobs/types failed: HTTP ${r.status}`);
  }
  return (await r.json()) as {
    protocol_version: string;
    agent_version: string;
    job_types: string[];
  };
}

/**
 * POST /jobs/run with a full envelope. Awaits the final result.
 * Suitable for short jobs (health_check, scan_favorited_images) and
 * for long ones if you don't need progress.
 */
export async function runJob(
  agentBaseUrl: string,
  envelope: JobEnvelopeRequest,
  token?: string,
): Promise<JobEnvelopeResponse> {
  const url = `${normalizeBase(agentBaseUrl)}/jobs/run`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify(envelope),
    cache: "no-store",
  });
  if (!r.ok) {
    return {
      protocol_version: PROTOCOL_VERSION,
      job_id: envelope.job_id,
      job_type: envelope.job_type,
      status: "failed",
      result: null,
      error: {
        code: "AGENT_HTTP_ERROR",
        message: `Agent returned HTTP ${r.status}`,
        details: { url, body: (await r.text()).slice(0, 1000) },
      },
    };
  }
  return (await r.json()) as JobEnvelopeResponse;
}

/**
 * POST /jobs/run-stream — NDJSON streaming.
 *
 * Consumes the response body as a stream, parses one JSON object per
 * line, and invokes `onEvent` for each. Resolves with the final
 * envelope when the stream closes. Suitable for long jobs where you
 * want progress to land in the UI / persisted as JobEvent rows as
 * soon as the agent emits them.
 *
 * NOTE: this only works in environments with WHATWG ReadableStream
 * support — modern browsers and Node 18+ both qualify. If you call
 * this from a server action, the Vercel/Node runtime is fine.
 */
export async function runJobStream(
  agentBaseUrl: string,
  envelope: JobEnvelopeRequest,
  onEvent: (event: StreamEvent) => void | Promise<void>,
  token?: string,
): Promise<JobEnvelopeResponse> {
  const url = `${normalizeBase(agentBaseUrl)}/jobs/run-stream`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify(envelope),
    cache: "no-store",
  });
  if (!r.ok || !r.body) {
    return {
      protocol_version: PROTOCOL_VERSION,
      job_id: envelope.job_id,
      job_type: envelope.job_type,
      status: "failed",
      result: null,
      error: {
        code: "AGENT_HTTP_ERROR",
        message: `Agent returned HTTP ${r.status}`,
        details: { url },
      },
    };
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let finalEnvelope: JobEnvelopeResponse | null = null;

  // NDJSON parser: accumulate bytes, split on newlines, parse each
  // complete line as JSON. The final line is the `result` wrapper
  // whose `envelope` field is the job result we return.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as StreamEvent;
        // Await the callback so consumers can do async work (e.g.
        // a DB insert per event) in stream order. Sync callbacks
        // returning void just resolve immediately.
        await onEvent(evt);
        if (evt.event_type === "result") {
          finalEnvelope = (evt as ResultEvent).envelope;
        }
      } catch {
        // Skip malformed lines silently — better than killing the stream.
      }
    }
  }
  // Flush trailing buffer.
  const tail = buffer.trim();
  if (tail) {
    try {
      const evt = JSON.parse(tail) as StreamEvent;
      await onEvent(evt);
      if (evt.event_type === "result") {
        finalEnvelope = (evt as ResultEvent).envelope;
      }
    } catch {
      // ignored
    }
  }

  return (
    finalEnvelope ?? {
      protocol_version: PROTOCOL_VERSION,
      job_id: envelope.job_id,
      job_type: envelope.job_type,
      status: "failed",
      result: null,
      error: {
        code: "AGENT_STREAM_NO_RESULT",
        message: "stream closed without a final envelope",
      },
    }
  );
}
