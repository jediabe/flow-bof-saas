/**
 * Upload path + URL helpers. Single source of truth.
 *
 * On-disk layout (relative to `process.cwd()/public`):
 *
 *   uploads/
 *   ├─ workspaces/
 *   │   └─ <workspaceId>/
 *   │       └─ batches/
 *   │           └─ <batchId>/
 *   │               └─ <productId>_primary.<ext>      ← product reference image
 *   ├─ imports/                                       ← (reserved) temp Kalodata staging
 *   ├─ batches/                                       ← legacy (alpha-1) layout, read-only
 *   └─ _tmp/                                          ← generic scratch
 *
 * Stored on Product rows:
 *   - `referenceImageUrl` = browser-usable public URL path, e.g.
 *       /uploads/workspaces/<wsId>/batches/<bId>/<pId>_primary.jpg
 *     ALWAYS starts with "/uploads/". Never a filesystem path.
 *   - `imageUrl` = original remote Kalodata source URL (kept for
 *     debugging / "Source image URL" links). Not used for previews.
 *
 * When sending image jobs to the runner, the relative URL is turned
 * into an absolute one via toAgentAssetUrl() — the runner runs on
 * another network and needs a fully-qualified `https://…` URL.
 */

import path from "node:path";

/** Absolute path to Next's `public/` directory. */
export function getPublicDir(): string {
  return path.join(process.cwd(), "public");
}

/** Absolute path to the `uploads/` root. */
export function getUploadRoot(): string {
  return path.join(getPublicDir(), "uploads");
}

/** Absolute path to `uploads/workspaces/<wsId>/`. */
export function getWorkspaceUploadDir(workspaceId: string): string {
  return path.join(getUploadRoot(), "workspaces", workspaceId);
}

/** Absolute path to `uploads/workspaces/<wsId>/batches/<batchId>/`. */
export function getBatchUploadDir(workspaceId: string, batchId: string): string {
  return path.join(getWorkspaceUploadDir(workspaceId), "batches", batchId);
}

/** Absolute path to `uploads/imports/<wsId>/<batchId>/` (scratch). */
export function getImportUploadDir(
  workspaceId: string,
  batchId: string,
): string {
  return path.join(getUploadRoot(), "imports", workspaceId, batchId);
}

/**
 * Compose the *public-URL* form of an uploaded asset. Accepts either
 * a string of joined segments or an array of segments. Returns a
 * path of the shape `/uploads/<...segments>` with forward slashes,
 * regardless of host OS.
 *
 * Example:
 *   publicUploadUrlFor("workspaces", "ws1", "batches", "b1", "p1.jpg")
 *   → "/uploads/workspaces/ws1/batches/b1/p1.jpg"
 */
export function publicUploadUrlFor(...parts: string[]): string {
  const clean = parts
    .flatMap((p) => p.split(/[\\/]/g))
    .filter((p) => p.length > 0);
  return `/uploads/${clean.join("/")}`;
}

/**
 * Convert a stored public URL (`/uploads/…`) into the absolute URL
 * the local runner uses to download a reference image. Hosted prod
 * derives the host from AGENT_ASSET_BASE_URL — set it on the VPS to
 * the same domain Caddy serves. Falls back to NEXT_PUBLIC_APP_URL,
 * then to localhost for dev.
 *
 * Pass-through behaviour: already-absolute http/https URLs are
 * returned verbatim so future signed-URL transports work without
 * code changes here.
 */
export function toAgentAssetUrl(publicPath: string): string {
  if (!publicPath) return publicPath;
  if (/^https?:\/\//i.test(publicPath)) return publicPath;

  const base =
    process.env.AGENT_ASSET_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";
  const baseClean = base.replace(/\/+$/, "");
  if (publicPath.startsWith("/")) return `${baseClean}${publicPath}`;
  return `${baseClean}/${publicPath}`;
}
