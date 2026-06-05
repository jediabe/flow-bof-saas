/**
 * Content-type + magic-byte sniffing for incoming image bytes.
 *
 * Used by:
 *   - Kalodata downloader: CDN may lie about Content-Type, so we
 *     also peek at the first few bytes before trusting it.
 *   - Paste/upload pipeline: browsers report MIME on the Blob, but
 *     a stripped-down clipboard image may arrive as
 *     `application/octet-stream`; magic-byte sniffing rescues it.
 *
 * Supported formats: jpg, png, webp, gif, bmp. Everything else gets
 * rejected at the boundary — Flow itself only consumes these.
 */

import { Buffer } from "node:buffer";
import path from "node:path";

export const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "image/jpeg":  "jpg",
  "image/jpg":   "jpg",
  "image/pjpeg": "jpg",
  "image/png":   "png",
  "image/webp":  "webp",
  "image/gif":   "gif",
  "image/bmp":   "bmp",
};

/** Returns the canonical extension if `body` starts with a known
 *  image magic prefix; "" otherwise. */
export function sniffImageMagic(body: Buffer): string {
  if (body.length < 4) return "";
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "jpg";
  if (
    body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
  ) return "png";
  if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) return "gif";
  if (body[0] === 0x42 && body[1] === 0x4d) return "bmp";
  // WEBP: "RIFF<size>WEBP"
  if (
    body.length >= 12 &&
    body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 &&
    body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50
  ) return "webp";
  return "";
}

/**
 * Best-effort extension inference: content-type → magic bytes → URL
 * suffix → jpg fallback. Returns the canonical (jpeg→jpg) form.
 *
 * `url` is optional — the paste pipeline has no URL, only a blob.
 */
export function inferImageExt(
  contentType: string | null,
  body: Buffer,
  url?: string | null,
): string {
  if (contentType) {
    const ct = contentType.split(";", 1)[0].trim().toLowerCase();
    if (CONTENT_TYPE_TO_EXT[ct]) return CONTENT_TYPE_TO_EXT[ct];
  }
  const magic = sniffImageMagic(body);
  if (magic) return magic;
  if (url) {
    try {
      const u = new URL(url);
      const suffix = path.extname(u.pathname).toLowerCase().replace(/^\./, "");
      if (suffix === "jpeg") return "jpg";
      if (["jpg", "png", "webp", "gif", "bmp"].includes(suffix)) return suffix;
    } catch {
      // malformed URL — fall through to jpg
    }
  }
  return "jpg";
}

/** Loose "is this image-ish" sniff used to reject obvious junk
 *  payloads (HTML error pages, redirects to login walls, etc.). */
export function looksLikeImage(contentType: string | null, body: Buffer): boolean {
  if (contentType) {
    const ct = contentType.split(";", 1)[0].trim().toLowerCase();
    if (ct.startsWith("image/")) return true;
  }
  return sniffImageMagic(body).length > 0;
}
