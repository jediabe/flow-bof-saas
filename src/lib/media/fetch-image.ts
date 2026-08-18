/**
 * Generic image fetcher — downloads a URL, verifies the response
 * is an image via Content-Type, caps size at 8 MiB, and returns
 * base64-encoded bytes plus a MIME type in the set Anthropic's
 * Messages API accepts (`image/jpeg | png | webp | gif`).
 *
 * Extracted from src/lib/ai/ip-risk-ai.ts (was a private helper
 * there) so QA and any future multimodal caller can share the
 * same envelope without pulling in IP-risk semantics. Behavior
 * is preserved verbatim — this is a MOVE, not a rewrite.
 *
 * Behaviors deliberately preserved:
 *  - No explicit timeout (inherits Node's fetch defaults). If a
 *    stricter deadline is ever needed, the caller wraps with
 *    AbortSignal.timeout(); this module stays timeout-agnostic.
 *  - Content-Type must start with "image/", case-insensitive.
 *  - Content-Type parameters (e.g. `; charset=binary`) are
 *    stripped by splitting on ";".
 *  - 8 MiB size cap. Anthropic's per-request image limit is
 *    ~5 MiB for most models; the 3 MiB headroom accounts for
 *    the difference between wire bytes and decoded pixel bytes
 *    and gives compression a chance to help.
 *  - Content-Types that pass the "image/*" gate but aren't one
 *    of the four Anthropic-accepted MIME types (e.g.
 *    `image/svg+xml`, `image/heic`) are COERCED to `image/jpeg`
 *    in the return value. The content-type check has already
 *    proven the bytes are an image; downstream Anthropic
 *    tolerance handles the label mismatch. Preserving this
 *    quirk because the IP-risk vision path has run in prod
 *    against TikTok CDN URLs (which occasionally serve
 *    heic/webp) with this behavior since it was written.
 *
 * SSRF caveat — deliberately unchanged:
 *   This helper does NOT validate that `url` points at a
 *   public / allowlisted host. Every current call site
 *   (IP-risk vision, QA visual evaluator) receives URLs from
 *   server-trusted sources — TikTok CDN, useapi.net signed URLs
 *   minted by our own MCP call — so there is no user-supplied
 *   URL in the trust boundary. If a future call site ever
 *   accepts a user-supplied URL, THAT caller must validate the
 *   URL against an allowlist BEFORE calling this helper. This
 *   module intentionally stays out of that policy call.
 */

export type SupportedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

export interface FetchedImage {
  /** base64-encoded image bytes, ready for Anthropic Messages API. */
  data: string;
  mediaType: SupportedImageMediaType;
}

/** Hard cap for a single image fetch. See module doc for
 *  rationale. Exported for tests + call-site sanity checks. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ANTHROPIC_ACCEPTED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const satisfies readonly SupportedImageMediaType[];

export async function fetchImageAsBase64(url: string): Promise<FetchedImage> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Image fetch failed: HTTP ${resp.status} ${resp.statusText}`,
    );
  }
  const ct = (resp.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (!ct.startsWith("image/")) {
    throw new Error(
      `Image fetch returned non-image content-type: ${ct || "?"}`,
    );
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image too large (${buf.byteLength} bytes, max ${MAX_IMAGE_BYTES}).`,
    );
  }
  const mediaType: SupportedImageMediaType = (
    ANTHROPIC_ACCEPTED_MEDIA_TYPES as readonly string[]
  ).includes(ct)
    ? (ct as SupportedImageMediaType)
    : "image/jpeg";
  return { data: buf.toString("base64"), mediaType };
}
