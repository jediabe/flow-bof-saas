/**
 * Shop product image fetcher — downloads TikTok CDN images and
 * stores them under public/uploads/shop-products/<workspaceId>/
 * so the /research surface can render stable URLs.
 *
 * TikTok CDN URLs (p16-*.tiktokcdn.*, p19-*.tiktokcdn-us.com, etc.)
 * are signed and expire — sometimes within hours, always within a
 * few days. Persisting the URL string on the ShopProduct row and
 * relying on it in the UI would rot immediately. We download the
 * bytes at discovery time, keep them on disk under `public/`, and
 * store only the local `/uploads/shop-products/...` URL.
 *
 * Separate from src/lib/uploads.ts (batch reference images) so the
 * two path lineages stay independent — shop-product images are
 * marketplace research data, not part of the content-gen pipeline.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { getUploadRoot, publicUploadUrlFor } from "@/lib/uploads";

/** Browser-like User-Agent. Bare fetch with no UA gets 403'd by
 *  some TikTok CDN edges — this matches a common desktop Chrome
 *  header the CDN treats as a legitimate image request. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB — generous for high-res product shots

export interface ShopImageDownloadResult {
  /** Public URL (`/uploads/shop-products/<ws>/<file>`) to store on
   *  the ShopProduct row. */
  publicUrl: string;
  /** Absolute filesystem path — useful for downstream cleanup / logs. */
  diskPath: string;
  /** Bytes written. */
  size: number;
  /** MIME type extracted from Content-Type or inferred from extension.
   *  Purely informational; the file itself is what matters. */
  contentType: string;
}

/** Absolute dir for a workspace's shop-product images. */
export function getShopProductImageDir(workspaceId: string): string {
  return path.join(getUploadRoot(), "shop-products", workspaceId);
}

/**
 * Download a TikTok product image and store it under
 * `public/uploads/shop-products/<workspaceId>/<externalId>.<ext>`.
 *
 * Idempotent: if the file already exists on disk, we skip the network
 * hit and return the existing path. This matters because discovery
 * scans re-encounter the same product across days; we don't want to
 * re-download the image on every run.
 *
 * Never throws for "download failed" — returns null. The caller
 * writes a ShopProduct row with imageUrl=null in that case, and the
 * UI renders a placeholder. Only truly programmatic errors (invalid
 * workspaceId etc.) bubble up.
 */
export async function downloadShopProductImage(input: {
  workspaceId: string;
  externalId: string;
  remoteUrl: string;
}): Promise<ShopImageDownloadResult | null> {
  const { workspaceId, externalId, remoteUrl } = input;
  if (!workspaceId || !externalId || !remoteUrl) return null;

  const dir = getShopProductImageDir(workspaceId);
  const ext = extractExtension(remoteUrl);
  const filename = `${externalId}.${ext}`;
  const diskPath = path.join(dir, filename);
  const publicUrl = publicUploadUrlFor("shop-products", workspaceId, filename);

  // Idempotent check — cached image on disk short-circuits.
  try {
    const stat = await fs.stat(diskPath);
    if (stat.size > 0) {
      return {
        publicUrl,
        diskPath,
        size: stat.size,
        contentType: contentTypeFromExt(ext),
      };
    }
  } catch {
    // File doesn't exist yet — proceed with download.
  }

  let resp: Response;
  try {
    resp = await fetch(remoteUrl, {
      method: "GET",
      headers: {
        "User-Agent": BROWSER_UA,
        // Some CDN edges 403 without an Accept header. Broad image
        // preferences pass consistently.
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        // Referer isn't strictly required but reduces bot-flagging
        // on the paranoid edges. Empty string is a valid header
        // for a cross-origin image request.
        "Referer": "",
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure — never fatal, caller writes null imageUrl.
    console.warn(
      "[shop-product-image] fetch failed for",
      externalId,
      ":",
      (err as Error).message?.slice(0, 200),
    );
    return null;
  }

  if (!resp.ok) {
    console.warn(
      "[shop-product-image] non-200 for",
      externalId,
      ":",
      resp.status,
    );
    return null;
  }
  const contentType = (resp.headers.get("content-type") ?? "").split(";")[0].trim()
    || contentTypeFromExt(ext);

  const arrayBuf = await resp.arrayBuffer();
  const bytes = Buffer.from(arrayBuf);
  if (bytes.byteLength === 0) {
    console.warn("[shop-product-image] empty body for", externalId);
    return null;
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    console.warn(
      "[shop-product-image] oversize for",
      externalId,
      ":",
      bytes.byteLength,
      "bytes",
    );
    return null;
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(diskPath, bytes);

  return {
    publicUrl,
    diskPath,
    size: bytes.byteLength,
    contentType,
  };
}

/** Extract file extension from a URL path, minus query string. Falls
 *  back to "jpg" — the safest default for TikTok CDN images which
 *  are ~always JPEG. */
function extractExtension(url: string): string {
  try {
    const u = new URL(url);
    const pathname = u.pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot < 0 || dot === pathname.length - 1) return "jpg";
    const raw = pathname.slice(dot + 1).toLowerCase();
    // Sanity — reject anything weird, cap length.
    if (!/^[a-z0-9]{2,5}$/.test(raw)) return "jpg";
    return raw;
  } catch {
    return "jpg";
  }
}

function contentTypeFromExt(ext: string): string {
  switch (ext) {
    case "png":  return "image/png";
    case "webp": return "image/webp";
    case "gif":  return "image/gif";
    case "avif": return "image/avif";
    case "jpg":
    case "jpeg":
    default:     return "image/jpeg";
  }
}
