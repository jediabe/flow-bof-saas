/**
 * Thin typed client over the useapi.net Google Flow v1 REST API.
 *
 * One instance is created per request, bound to that user's token, so a tool
 * handler can never accidentally act with another tenant's credentials.
 */

import {
  API_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
} from "../constants.js";
import { GoogleFlowApiError, GoogleFlowTimeoutError } from "./errors.js";
import type { MediaItem, NormalizedJob } from "../types.js";

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  /** JSON body. Undefined-valued keys are stripped before sending. */
  body?: Record<string, unknown>;
  /** Raw binary body, used only by POST /assets/{email}. */
  rawBody?: Buffer;
  /** Content-Type for a raw binary body. */
  rawContentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
}

/** Removes undefined/null values so we never send `"seed": null` upstream. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Expands `{ referenceImage: ["a","b"] }` into
 * `{ referenceImage_1: "a", referenceImage_2: "b" }`.
 *
 * The API uses numbered suffixes for its repeated slots; arrays are a far
 * better tool interface, so the translation happens here.
 */
export function expandSlots(
  prefix: string,
  values: readonly string[] | undefined,
  max: number,
): Record<string, string> {
  if (!values?.length) return {};
  const out: Record<string, string> = {};
  values.slice(0, max).forEach((value, i) => {
    out[`${prefix}_${i + 1}`] = value;
  });
  return out;
}

export class GoogleFlowClient {
  constructor(
    private readonly token: string,
    /**
     * The Google Flow account every call from this client is pinned to. It
     * comes from the signed request context, so tools cannot override it and
     * the model never sees it.
     */
    readonly email: string,
    private readonly baseUrl: string = API_BASE_URL,
  ) {}

  /**
   * GET a resource whose path contains an opaque identifier.
   *
   * jobIds and mediaGenerationIds embed ':' and '@' — both legal in a URL path
   * segment. useapi.net's own reference client and every curl example in their
   * docs pass these RAW, so that is what we do. Percent-encoding them yields a
   * 404, and it is an easy mistake to make: a mock that decodes whatever you
   * encoded will happily agree with you.
   *
   * Because the docs contradict themselves on this point — the assets page says
   * to URL-encode, the jobs page does not — a 404 on the raw form retries once
   * encoded. One wasted round trip on a read-only call is a fair price for not
   * having to guess per endpoint.
   */
  async requestById<T = unknown>(
    prefix: string,
    id: string,
    options: RequestOptions = {},
  ): Promise<T> {
    // The id goes into a path unescaped, so reject anything that could alter
    // the request's shape rather than merely name a resource.
    if (/[/?#\s]/.test(id)) {
      throw new Error(
        `Error: '${id}' contains a character that is not valid in an identifier ` +
          "(slash, question mark, hash, or whitespace). Check the value you passed.",
      );
    }

    try {
      return await this.request<T>(`${prefix}${id}`, options);
    } catch (err) {
      if (err instanceof GoogleFlowApiError && err.status === 404) {
        return await this.request<T>(`${prefix}${encodeURIComponent(id)}`, options);
      }
      throw err;
    }
  }

  async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const {
      method = "GET",
      body,
      rawBody,
      rawContentType,
      query,
      timeoutMs = rawBody ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    } = options;

    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };

    let payload: string | Uint8Array | undefined;
    if (rawBody) {
      headers["Content-Type"] = rawContentType ?? "application/octet-stream";
      payload = new Uint8Array(rawBody);
    } else if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(compact(body));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new GoogleFlowTimeoutError(path, timeoutMs);
      }
      throw new Error(
        `Network error calling ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const parsed: unknown = contentType.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text();

    if (!response.ok) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader
        ? Number.parseInt(retryAfterHeader, 10)
        : undefined;
      throw new GoogleFlowApiError(
        `Google Flow API ${method} ${path} failed with ${response.status}`,
        response.status,
        parsed,
        path,
        Number.isFinite(retryAfter) ? retryAfter : undefined,
      );
    }

    return parsed as T;
  }
}

/* ------------------------------------------------------------------ *
 * Response normalization
 *
 * The API returns the same conceptual data in several shapes:
 *   - sync video   -> { jobId,  media: [ { mediaGenerationId, videoUrl, ... } ] }
 *   - async submit -> { jobid,  status, response: { operations: [...] } }
 *   - job poll     -> { jobid,  status, response: { media: [...] } }
 *   - sync image   -> { jobId,  media: [ { image: { generatedImage: {...} } } ] }
 * Normalizing once here keeps every tool's output schema identical.
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reads the jobId regardless of which casing the endpoint used. */
export function readJobId(payload: unknown): string | undefined {
  const rec = asRecord(payload);
  if (!rec) return undefined;
  return str(rec["jobId"]) ?? str(rec["jobid"]);
}

/** Flattens one `media[]` entry from any of the API's response shapes. */
export function normalizeMediaItem(raw: unknown): MediaItem | null {
  const rec = asRecord(raw);
  if (!rec) return null;

  // Image shape: { image: { generatedImage: { ... } } }
  const generatedImage = asRecord(asRecord(rec["image"])?.["generatedImage"]);
  if (generatedImage) {
    const item: MediaItem = {
      kind: "image",
      ...(str(generatedImage["mediaGenerationId"]) !== undefined
        ? { mediaGenerationId: str(generatedImage["mediaGenerationId"])! }
        : {}),
      ...(str(generatedImage["fifeUrl"]) !== undefined
        ? { url: str(generatedImage["fifeUrl"])! }
        : {}),
      ...(num(generatedImage["seed"]) !== undefined
        ? { seed: num(generatedImage["seed"])! }
        : {}),
      ...(str(generatedImage["prompt"]) !== undefined
        ? { prompt: str(generatedImage["prompt"])! }
        : {}),
      ...(str(generatedImage["modelNameType"]) !== undefined
        ? { model: str(generatedImage["modelNameType"])! }
        : {}),
      ...(str(generatedImage["aspectRatio"]) !== undefined
        ? { aspectRatio: str(generatedImage["aspectRatio"])! }
        : {}),
    };
    if (str(rec["encodedImage"]) || str(generatedImage["encodedImage"])) {
      item.hasInlineBase64 = true;
    }
    return item;
  }

  // Video shape: { mediaGenerationId, videoUrl, thumbnailUrl, video: { generatedVideo: {...} } }
  const generatedVideo = asRecord(asRecord(rec["video"])?.["generatedVideo"]);
  const lengthRaw = asRecord(asRecord(rec["video"])?.["dimensions"])?.["length"];

  const item: MediaItem = {
    kind: "video",
    ...(str(rec["mediaGenerationId"]) !== undefined
      ? { mediaGenerationId: str(rec["mediaGenerationId"])! }
      : {}),
    ...(str(rec["videoUrl"]) !== undefined ? { url: str(rec["videoUrl"])! } : {}),
    ...(str(rec["thumbnailUrl"]) !== undefined
      ? { thumbnailUrl: str(rec["thumbnailUrl"])! }
      : {}),
    ...(num(generatedVideo?.["seed"]) !== undefined
      ? { seed: num(generatedVideo!["seed"])! }
      : {}),
    ...(str(generatedVideo?.["prompt"]) !== undefined
      ? { prompt: str(generatedVideo!["prompt"])! }
      : {}),
    ...(str(generatedVideo?.["model"]) !== undefined
      ? { model: str(generatedVideo!["model"])! }
      : {}),
    ...(str(generatedVideo?.["aspectRatio"]) !== undefined
      ? { aspectRatio: str(generatedVideo!["aspectRatio"])! }
      : {}),
  };

  if (typeof lengthRaw === "string") {
    const seconds = Number.parseFloat(lengthRaw.replace(/s$/, ""));
    if (Number.isFinite(seconds)) item.durationSeconds = seconds;
  }

  return item.mediaGenerationId || item.url ? item : null;
}

export function normalizeMediaList(raw: unknown): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeMediaItem)
    .filter((m): m is MediaItem => m !== null);
}

/** Normalizes a GET /jobs/{jobId} response, tolerating both id spellings. */
export function normalizeJob(raw: unknown): NormalizedJob {
  const rec = asRecord(raw) ?? {};
  return {
    jobId: readJobId(rec) ?? "",
    type: str(rec["type"]) ?? "unknown",
    status: str(rec["status"]) ?? "unknown",
    ...(str(rec["created"]) !== undefined ? { created: str(rec["created"])! } : {}),
    ...(str(rec["updated"]) !== undefined ? { updated: str(rec["updated"])! } : {}),
    ...(asRecord(rec["request"]) ? { request: asRecord(rec["request"])! } : {}),
    ...(asRecord(rec["response"]) ? { response: asRecord(rec["response"])! } : {}),
    ...(rec["error"] !== undefined ? { error: rec["error"] } : {}),
    ...(rec["code"] !== undefined ? { code: rec["code"] } : {}),
  };
}

/**
 * Best-effort check that a jobId belongs to the caller's Google Flow account.
 *
 * Job ids embed a masked email: `j1731859234567v-u12345-email:jo***@gmail.com-bot:google-flow`.
 * Jobs are scoped to the useapi.net token, which is shared across all users of
 * this deployment, so without this check one user could poll another's job by
 * guessing or replaying an id.
 *
 * Returns false only on a confident mismatch. If the id does not parse in the
 * expected shape, this returns true rather than blocking a legitimate poll —
 * the mask format is observed, not contractual.
 */
export function jobIdMatchesAccount(jobId: string, email: string): boolean {
  // Terminate on the literal '-bot:' rather than the first hyphen. A domain
  // containing a hyphen (apex-ai.io, my-co.co.uk) would otherwise truncate the
  // captured address and make every one of that account's jobs unreadable.
  const masked = /-email:(.+?)-bot:/.exec(jobId)?.[1];
  if (!masked) return true;

  const parts = /^(.*?)\*+(@.+)$/.exec(masked);
  if (!parts) return true;

  const [, prefix = "", domain = ""] = parts;
  const lower = email.toLowerCase();
  return (
    lower.startsWith(prefix.toLowerCase()) && lower.endsWith(domain.toLowerCase())
  );
}

/** Reads `remainingCredits` from either the top level or the nested response. */
export function readRemainingCredits(payload: unknown): number | undefined {
  const rec = asRecord(payload);
  if (!rec) return undefined;
  return (
    num(rec["remainingCredits"]) ??
    num(asRecord(rec["response"])?.["remainingCredits"])
  );
}
