/**
 * Single chokepoint for all ProductImage table writes.
 *
 * Why this lib exists: the legacy fields `Product.referenceImageUrl`
 * + `Product.referenceImagePathLocal` are denormalised copies of the
 * primary ProductImage row. Every existing read path on the SaaS
 * side (product card thumbnail, GenerateImagesPanel dispatch payload,
 * mobile review QR thumbnail, ...) reads from those fields directly.
 *
 * Rather than rewrite every reader to do a join, we keep the legacy
 * fields and treat them as a cache of `ProductImage(role="primary")`.
 * Any code that creates / updates / deletes a primary ProductImage
 * MUST go through these helpers so the cache stays in sync. Writing
 * the ProductImage row by hand without updating Product is a bug
 * that surfaces as "the thumbnail doesn't match what the dispatch
 * sends to the runner."
 *
 * Phase 3 contract (matches runner's REFERENCE_ROLES):
 *   - role="primary"  — required for any product that has any refs
 *   - role="ref2"     — optional supplementary
 *   - role="ref3"     — optional supplementary
 */

import { db } from "@/lib/db";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The runner's reference roles, verbatim. Keep in lock-step with
 *  flow-bof-automation/src/batch_workflow.py:REFERENCE_ROLES. */
export const REFERENCE_ROLES = ["primary", "ref2", "ref3"] as const;
export type ReferenceRole = (typeof REFERENCE_ROLES)[number];

/** The role that gets denormalised onto Product.referenceImageUrl /
 *  .referenceImagePathLocal. Single-source-of-truth lookup so a
 *  rename of "primary" only touches this lib. */
export const PRIMARY_ROLE: ReferenceRole = "primary";

export interface UpsertProductImageInput {
  productId: string;
  role: ReferenceRole;
  /** Public URL (e.g. /uploads/...). Optional when only a local
   *  override path is supplied — rare. */
  url: string | null;
  /** Optional local-filesystem path the runner reads from directly. */
  pathLocal?: string | null;
  /** "kalodata" | "paste" | "upload" — where the image came from. */
  source: "kalodata" | "paste" | "upload";
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
}

/**
 * Insert or replace a ProductImage row, keyed on (productId, role).
 * If role==="primary", also writes back to Product.referenceImageUrl
 * + .referenceImagePathLocal so all existing read paths see the
 * change without joining.
 *
 * Returns the upserted row. Throws on Prisma error — caller decides
 * what to do with it.
 */
export async function upsertProductImage(
  input: UpsertProductImageInput,
): Promise<{ id: string; role: string; url: string | null }> {
  const row = await db.productImage.upsert({
    where: {
      productId_role: { productId: input.productId, role: input.role },
    },
    update: {
      url: input.url,
      pathLocal: input.pathLocal ?? null,
      source: input.source,
      width: input.width ?? null,
      height: input.height ?? null,
      bytes: input.bytes ?? null,
    },
    create: {
      productId: input.productId,
      role: input.role,
      url: input.url,
      pathLocal: input.pathLocal ?? null,
      source: input.source,
      width: input.width ?? null,
      height: input.height ?? null,
      bytes: input.bytes ?? null,
    },
    select: { id: true, role: true, url: true },
  });

  if (input.role === PRIMARY_ROLE) {
    await db.product.update({
      where: { id: input.productId },
      data: {
        referenceImageUrl: input.url,
        referenceImagePathLocal: input.pathLocal ?? null,
      },
    });
  }

  return row;
}

/**
 * Delete a ProductImage by role. If the deleted row was the primary,
 * also clears the denormalised Product.referenceImageUrl /
 * .referenceImagePathLocal so the thumbnail and dispatch see the
 * deletion immediately. Optionally promotes ref2 → primary so the
 * product still has *something* to show; pass {promoteNext: false}
 * if the caller wants the product left without a primary (rare —
 * usually only the "delete all images" path).
 *
 * Returns the new primary role (or null if the product has no
 * images left), so the caller can refresh its UI state.
 */
export async function removeProductImage({
  productId,
  role,
  promoteNext = true,
}: {
  productId: string;
  role: ReferenceRole;
  promoteNext?: boolean;
}): Promise<{ newPrimaryRole: ReferenceRole | null }> {
  // Delete the row. Use deleteMany to avoid throwing when the row
  // is already gone — the caller might be retrying.
  await db.productImage.deleteMany({
    where: { productId, role },
  });

  if (role !== PRIMARY_ROLE) {
    return { newPrimaryRole: PRIMARY_ROLE };
  }

  // Removed the primary. Try to promote the next role in order.
  if (promoteNext) {
    const remaining = await db.productImage.findMany({
      where: { productId, role: { in: ["ref2", "ref3"] } },
      orderBy: { role: "asc" }, // "ref2" < "ref3" lexicographically
      take: 1,
    });
    if (remaining.length > 0) {
      const next = remaining[0];
      await db.productImage.update({
        where: { id: next.id },
        data: { role: PRIMARY_ROLE },
      });
      await db.product.update({
        where: { id: productId },
        data: {
          referenceImageUrl: next.url,
          referenceImagePathLocal: next.pathLocal,
        },
      });
      return { newPrimaryRole: PRIMARY_ROLE };
    }
  }

  // Nothing left to promote — clear the denormalised cache.
  await db.product.update({
    where: { id: productId },
    data: { referenceImageUrl: null, referenceImagePathLocal: null },
  });
  return { newPrimaryRole: null };
}

/**
 * List all ProductImage rows for a product, ordered by role
 * (primary first, ref2, ref3). Returns an empty list for a product
 * with no images.
 */
export async function listProductImages(
  productId: string,
): Promise<
  Array<{
    id: string;
    role: ReferenceRole;
    url: string | null;
    pathLocal: string | null;
    source: string;
    width: number | null;
    height: number | null;
    bytes: number | null;
  }>
> {
  const rows = await db.productImage.findMany({
    where: { productId },
    orderBy: { role: "asc" },
  });
  // Sort by REFERENCE_ROLES order rather than lexicographic — works
  // out the same today (primary < ref2 < ref3) but defensive against
  // role renames.
  const byRole = new Map(rows.map((r) => [r.role, r]));
  const out: typeof rows = [];
  for (const r of REFERENCE_ROLES) {
    const hit = byRole.get(r);
    if (hit) out.push(hit);
  }
  return out.map((r) => ({
    id: r.id,
    role: r.role as ReferenceRole,
    url: r.url,
    pathLocal: r.pathLocal,
    source: r.source,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
  }));
}

/**
 * Pick the next available reference role for a product, in
 * REFERENCE_ROLES order. Returns null if all three roles are taken.
 *
 * Used by the paste/upload handler: "user just pasted an image — pick
 * a role for it." Always prefers primary if empty so a product with
 * a missing hero gets one immediately.
 */
export async function pickNextAvailableRole(
  productId: string,
): Promise<ReferenceRole | null> {
  const taken = await db.productImage.findMany({
    where: { productId },
    select: { role: true },
  });
  const takenSet = new Set(taken.map((t) => t.role));
  for (const r of REFERENCE_ROLES) {
    if (!takenSet.has(r)) return r;
  }
  return null;
}

/**
 * Delete the on-disk file backing a ProductImage. Best-effort — a
 * missing file is fine (we may never have downloaded it). Pass the
 * absolute filesystem path, not the public URL.
 *
 * Why this is separate from removeProductImage: a paste-upload that
 * fails halfway can leave a file on disk without a DB row, and the
 * "rotate paste" UX overwrites the same path with a new file. The DB
 * write and the file delete don't share a single transaction; we
 * accept that and let the next sweep / Kalodata re-import clean up.
 */
export async function tryDeleteFile(absPath: string | null): Promise<void> {
  if (!absPath) return;
  try {
    await fs.unlink(absPath);
  } catch {
    // ENOENT or permission — fine, nothing to do.
  }
}

/**
 * Resolve a public /uploads/... URL into the absolute on-disk path
 * that backs it. Returns null when the URL is external (http/https)
 * or doesn't live under /uploads/. Used by tryDeleteFile.
 */
export function publicUrlToDiskPath(
  publicUrl: string | null | undefined,
): string | null {
  if (!publicUrl) return null;
  if (/^https?:\/\//i.test(publicUrl)) return null;
  if (!publicUrl.startsWith("/uploads/")) return null;
  const rel = publicUrl.replace(/^\/+/, "");
  return path.join(process.cwd(), "public", rel);
}
