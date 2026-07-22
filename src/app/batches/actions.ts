"use server";

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import {
  parseKalodataWorkbook,
  downloadProductImage,
} from "@/lib/kalodata";
import { buildUkRetailPrompt } from "@/lib/uk-retailers";
import {
  loadOrCreateSettings,
  toServerSettings,
} from "@/lib/workspace-settings";
import { callProvider } from "@/lib/ai/providers";
import { encodeJson } from "@/lib/json-column";
import type { AiOverwriteMode } from "@/lib/ai/types";
import {
  upsertProductImage,
  removeProductImage,
  pickNextAvailableRole,
  publicUrlToDiskPath,
  tryDeleteFile,
} from "@/lib/product-images";
import { getBatchUploadDir, publicUploadUrlFor } from "@/lib/uploads";
import { inferImageExt, looksLikeImage } from "@/lib/image-sniff";

export async function createBatch(formData: FormData): Promise<void> {
  const name = String(formData.get("name") || "").trim();
  if (!name) return;
  // Market is optional on the form for backward compat with any
  // older client that doesn't surface the selector — defaults to
  // "uk" (the workflow we shipped first). Anything not in MARKETS
  // also collapses to "uk" rather than erroring, so a stale client
  // can't break batch creation.
  const marketRaw = String(formData.get("market") || "").trim().toLowerCase();
  const market = MARKETS.has(marketRaw as "uk" | "us") ? marketRaw : "uk";
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.create({
    data: { workspaceId: workspace.id, name, market },
  });
  revalidatePath("/batches");
  revalidatePath("/dashboard");
  redirect(`/batches/${batch.id}`);
}

export async function deleteBatch(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  if (!id) return;
  const { workspace } = await getCurrentWorkspace();
  await db.batch.deleteMany({ where: { id, workspaceId: workspace.id } });
  revalidatePath("/batches");
  revalidatePath("/dashboard");
  redirect("/batches");
}

/** Coerce an empty / whitespace-only string to null for optional DB columns. */
function nullable(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/**
 * revalidatePath() but silent when called during a Server Component
 * render. Next.js 15 forbids revalidate calls during render — they
 * throw with "used revalidatePath during render which is
 * unsupported". Some helpers here (e.g. getOrCreateBatchReviewToken)
 * are legitimately called from both server actions (where revalidate
 * is required) AND from server-component data loaders (where it's
 * disallowed but harmless to skip). This wrapper picks whichever
 * behaviour the current context supports.
 *
 * When we can't revalidate here, no correctness is lost: the calling
 * render will already return fresh data, and the next navigation to
 * the affected route re-renders it via `dynamic = "force-dynamic"`.
 */
function revalidatePathSafe(path: string): void {
  try {
    revalidatePath(path);
  } catch {
    // Called from render context — skip.
  }
}

/**
 * Trim the query string out of a URL for logging. Kalodata's image
 * URLs are public CDN today, but the source feed may switch to signed
 * URLs at any time; logging them verbatim into stdout makes those
 * signatures fish-able from container logs / log aggregators forever.
 * Preserve scheme/host/path so the log is still actionable; replace
 * the query with a sentinel so the reader knows it existed.
 */
function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}${u.search ? "?<redacted>" : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

export async function addProduct(formData: FormData): Promise<void> {
  const batchId = String(formData.get("batchId") || "");
  const productName = String(formData.get("productName") || "").trim();
  if (!batchId || !productName) return;
  const { workspace } = await getCurrentWorkspace();
  // Confirm batch belongs to this workspace before mutating.
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
  });
  if (!batch) return;
  await db.product.create({
    data: {
      batchId,
      productName,
      originalTitle:      nullable(formData.get("originalTitle")),
      tiktokUrl:          nullable(formData.get("tiktokUrl")),
      category:           nullable(formData.get("category")),
      retailerName:       nullable(formData.get("retailerName")),
      imageUrl:           nullable(formData.get("imageUrl")),
      referenceImageUrl:  nullable(formData.get("referenceImageUrl")),
      referenceImagePathLocal: nullable(formData.get("referenceImagePathLocal")),
      imagePrompt:        nullable(formData.get("imagePrompt")),
    },
  });
  revalidatePath(`/batches/${batchId}`);
}

/**
 * Patch an existing product. Only fields present in the form data
 * are touched — the editor sends just the fields the user changed
 * (or a full row when they hit Save), so this is both a partial and
 * a full update.
 *
 * Workspace-scoped: we re-resolve the batch each call so a stale
 * client can't write to another tenant's product.
 */
export async function updateProduct(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  const batchId = String(formData.get("batchId") || "");
  if (!id || !batchId) return;
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return;

  // Whitelist of fields the editor can patch. Anything not here is
  // ignored — keeps callers from injecting unexpected columns.
  const FIELDS = [
    "productName",
    "originalTitle",
    "tiktokUrl",
    "category",
    "retailerName",
    "imageUrl",
    "referenceImageUrl",
    "referenceImagePathLocal",
    "imagePrompt",
  ] as const;
  const data: Record<string, string | null> = {};
  for (const f of FIELDS) {
    if (formData.has(f)) {
      const v = nullable(formData.get(f));
      // productName is required — silently drop empty-string clears.
      if (f === "productName" && !v) continue;
      data[f] = v;
    }
  }
  if (Object.keys(data).length === 0) return;

  await db.product.updateMany({
    where: { id, batchId: batch.id },
    data,
  });
  revalidatePath(`/batches/${batchId}`);
}

/**
 * Soft-delete a product. Sets `deletedAt = now` so the row stays in
 * the DB (preserves linked Job / JobEvent audit trail) but disappears
 * from default queries and from generation eligibility.
 *
 * Use `restoreProduct` to undo.
 */
export async function deleteProduct(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  const batchId = String(formData.get("batchId") || "");
  if (!id || !batchId) return;
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return;
  await db.product.updateMany({
    where: { id, batchId: batch.id },
    data: { deletedAt: new Date() },
  });
  revalidatePath(`/batches/${batchId}`);
}

// ---------------------------------------------------------------------------
// Phase 3 — multi-reference image attach / remove / promote
// ---------------------------------------------------------------------------
//
// These actions back the paste-anywhere / drag-drop / file-picker UX
// on the product card. The blob arrives via FormData (a Server Action
// can carry binary files in FormData natively in Next 15). We sniff
// the bytes for an image-ish content type, save to the existing
// per-batch upload tree, and write through the ProductImage helper
// so the denormalised Product.referenceImageUrl cache stays in sync.

/** Max bytes accepted for a single pasted/uploaded reference image.
 *  20 MiB matches the Kalodata downloader's cap — comfortably above
 *  any reasonable phone photo or full-res product shot. */
const MAX_PRODUCT_IMAGE_BYTES = 20 * 1024 * 1024;

/** Allowed roles. Mirrors REFERENCE_ROLES on the runner side; we
 *  re-export the set here so this file doesn't have to import the
 *  helper just for a runtime check. */
const PRODUCT_IMAGE_ROLES = new Set(["primary", "ref2", "ref3"] as const);
type ProductImageRole = "primary" | "ref2" | "ref3";

const PRODUCT_IMAGE_SOURCES = new Set(["kalodata", "paste", "upload"] as const);
type ProductImageSource = "kalodata" | "paste" | "upload";

export interface AttachProductImageResult {
  ok: boolean;
  message: string;
  /** When ok, the role the image was written to (caller may have
   *  asked for "auto" and we picked the first available). */
  role?: ProductImageRole;
  /** When ok, the public /uploads/... URL the row now points at. */
  url?: string;
}

/**
 * Save a pasted/uploaded image blob to disk and write the
 * ProductImage row. The client calls this from the paste-anywhere /
 * drop-zone / file-picker handler on the product card.
 *
 * FormData fields:
 *   - productId  (required)
 *   - batchId    (required, for workspace scope check + revalidate)
 *   - role       (optional: "primary" | "ref2" | "ref3" | "auto").
 *                 "auto" picks the first empty role in REFERENCE_ROLES
 *                 order; useful for the paste handler when the user
 *                 hasn't aimed at a specific slot.
 *   - source     (optional: "paste" | "upload" — defaults to "upload")
 *   - image      (required: a File / Blob of the image bytes)
 *
 * Throws nothing — returns a structured result so the client can
 * render an inline error without a try/catch.
 */
export async function attachProductImageFromBlob(
  formData: FormData,
): Promise<AttachProductImageResult> {
  const productId = String(formData.get("productId") || "");
  const batchId = String(formData.get("batchId") || "");
  const roleRaw = String(formData.get("role") || "auto");
  const sourceRaw = String(formData.get("source") || "upload");
  const blob = formData.get("image");

  if (!productId || !batchId) {
    return { ok: false, message: "Missing productId or batchId" };
  }
  if (!(blob instanceof Blob) || blob.size === 0) {
    return { ok: false, message: "No image attached" };
  }
  if (blob.size > MAX_PRODUCT_IMAGE_BYTES) {
    return {
      ok: false,
      message: `Image too large (${blob.size} bytes, max ${MAX_PRODUCT_IMAGE_BYTES})`,
    };
  }

  const source = PRODUCT_IMAGE_SOURCES.has(sourceRaw as ProductImageSource)
    ? (sourceRaw as ProductImageSource)
    : "upload";

  // Workspace scope check via batch — re-resolves on every call so a
  // stale client can't write images to another tenant's product.
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return { ok: false, message: "Batch not found" };

  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id },
    select: { id: true },
  });
  if (!product) return { ok: false, message: "Product not found" };

  // Resolve the role. "auto" → first available; otherwise validate.
  let role: ProductImageRole;
  if (roleRaw === "auto") {
    const next = await pickNextAvailableRole(productId);
    if (!next) {
      return {
        ok: false,
        message: "All 3 reference image slots are full",
      };
    }
    role = next;
  } else if (PRODUCT_IMAGE_ROLES.has(roleRaw as ProductImageRole)) {
    role = roleRaw as ProductImageRole;
  } else {
    return { ok: false, message: `Invalid role: ${roleRaw}` };
  }

  // Read + sniff. Reject non-image blobs at the boundary — a stray
  // text or video paste should fail loudly, not save garbage.
  const ab = await blob.arrayBuffer();
  const buf = Buffer.from(ab);
  const ct = blob.type || null;
  if (!looksLikeImage(ct, buf)) {
    return {
      ok: false,
      message: `Blob doesn't look like an image (content-type=${ct ?? "?"})`,
    };
  }
  const ext = inferImageExt(ct, buf, null);

  // Save to the existing per-batch upload directory. Filename is
  // <productId>_<role>.<ext> — overwrites on re-attach with the same
  // role, which is the right behaviour (rotate paste, etc.).
  const dir = getBatchUploadDir(workspace.id, batch.id);
  await fs.mkdir(dir, { recursive: true });
  const fname = `${productId}_${role}.${ext}`;
  const filePath = path.join(dir, fname);
  try {
    await fs.writeFile(filePath, buf);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      return {
        ok: false,
        message:
          "Upload directory is not writable. Run scripts/fix-upload-perms.sh on the server.",
      };
    }
    return { ok: false, message: e.message || "write failed" };
  }
  const relUrl = publicUploadUrlFor(
    "workspaces",
    workspace.id,
    "batches",
    batch.id,
    fname,
  );

  await upsertProductImage({
    productId,
    role,
    url: relUrl,
    source,
    bytes: buf.length,
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: `Attached as ${role}`, role, url: relUrl };
}

/**
 * Remove a ProductImage row by role, including its on-disk file.
 * When the deleted row was the primary, removeProductImage() in
 * lib/product-images.ts auto-promotes the next available role to
 * primary and syncs the denormalised Product cache.
 *
 * Returns ok + the new primary role (or null if the product has no
 * images left).
 */
export async function removeProductImageByRole(
  formData: FormData,
): Promise<{ ok: boolean; message: string; newPrimaryRole?: string | null }> {
  const productId = String(formData.get("productId") || "");
  const batchId = String(formData.get("batchId") || "");
  const roleRaw = String(formData.get("role") || "");

  if (!productId || !batchId) {
    return { ok: false, message: "Missing productId or batchId" };
  }
  if (!PRODUCT_IMAGE_ROLES.has(roleRaw as ProductImageRole)) {
    return { ok: false, message: `Invalid role: ${roleRaw}` };
  }
  const role = roleRaw as ProductImageRole;

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return { ok: false, message: "Batch not found" };

  // Get the row before we delete it so we can clean up the file.
  const existing = await db.productImage.findUnique({
    where: { productId_role: { productId, role } },
    select: { url: true },
  });
  if (existing) {
    await tryDeleteFile(publicUrlToDiskPath(existing.url));
  }

  const { newPrimaryRole } = await removeProductImage({
    productId,
    role,
    promoteNext: true,
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: `Removed ${role}`, newPrimaryRole };
}

/**
 * Promote a non-primary image to primary; demote the current primary
 * (if any) into the now-empty role. This is the "right-click → Make
 * primary" UX on the image stack.
 *
 * No-op if `role` is already primary.
 */
export async function promoteProductImageRole(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const productId = String(formData.get("productId") || "");
  const batchId = String(formData.get("batchId") || "");
  const roleRaw = String(formData.get("role") || "");

  if (!productId || !batchId) {
    return { ok: false, message: "Missing productId or batchId" };
  }
  if (!PRODUCT_IMAGE_ROLES.has(roleRaw as ProductImageRole)) {
    return { ok: false, message: `Invalid role: ${roleRaw}` };
  }
  const role = roleRaw as ProductImageRole;
  if (role === "primary") {
    return { ok: true, message: "Already primary" };
  }

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return { ok: false, message: "Batch not found" };

  // Workspace scope: verify the product belongs to this batch before
  // we shuffle its images.
  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id },
    select: { id: true },
  });
  if (!product) return { ok: false, message: "Product not found" };

  // The unique constraint on (productId, role) means a straight swap
  // would conflict with itself. We do it in three steps inside a
  // transaction:
  //   1. Park the row we're promoting at a temporary role.
  //   2. Move the existing primary (if any) to the freed role.
  //   3. Move the parked row to primary, then sync the Product cache.
  const TEMP_ROLE = "__swap__";
  const targetRole = role;
  await db.$transaction(async (tx) => {
    const promoting = await tx.productImage.findUnique({
      where: { productId_role: { productId, role: targetRole } },
    });
    if (!promoting) {
      throw new Error(`No image at role ${targetRole}`);
    }
    const currentPrimary = await tx.productImage.findUnique({
      where: { productId_role: { productId, role: "primary" } },
    });

    // Step 1 — park the row we're promoting under a temp role.
    await tx.productImage.update({
      where: { id: promoting.id },
      data: { role: TEMP_ROLE },
    });

    // Step 2 — move the existing primary into the freed slot.
    if (currentPrimary) {
      await tx.productImage.update({
        where: { id: currentPrimary.id },
        data: { role: targetRole },
      });
    }

    // Step 3 — promote the parked row to primary, sync Product cache.
    await tx.productImage.update({
      where: { id: promoting.id },
      data: { role: "primary" },
    });
    await tx.product.update({
      where: { id: productId },
      data: {
        referenceImageUrl: promoting.url,
        referenceImagePathLocal: promoting.pathLocal,
      },
    });
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: `Promoted ${role} to primary` };
}

/** Reverse `deleteProduct`. Clears `deletedAt`. */
export async function restoreProduct(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  const batchId = String(formData.get("batchId") || "");
  if (!id || !batchId) return;
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return;
  await db.product.updateMany({
    where: { id, batchId: batch.id },
    data: { deletedAt: null },
  });
  revalidatePath(`/batches/${batchId}`);
}

const REVIEW_STATUSES = new Set([
  "needs_review",
  "approved",
  "rejected",
  "maybe",
] as const);
type ReviewStatus = "needs_review" | "approved" | "rejected" | "maybe";

/**
 * Set the review status on a single product. Used by the Approve /
 * Reject / Maybe / Reset buttons on the batch page and on the
 * Phase-4 mobile review page.
 *
 * Workspace-scoped: re-resolves the batch on every call so a stale
 * client can't flip status on a row in another tenant.
 */
export async function setProductReviewStatus(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  const batchId = String(formData.get("batchId") || "");
  const status = String(formData.get("status") || "");
  if (!id || !batchId) return;
  if (!REVIEW_STATUSES.has(status as ReviewStatus)) return;

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return;
  await db.product.updateMany({
    where: { id, batchId: batch.id },
    data: { reviewStatus: status },
  });
  revalidatePath(`/batches/${batchId}`);
}

/**
 * Bulk-set review status on multiple products. `productIds` arrives
 * as a single comma-separated string on the form so the action can
 * be called from a plain `<form>` without JS.
 */
export async function bulkSetReviewStatus(formData: FormData): Promise<void> {
  const batchId = String(formData.get("batchId") || "");
  const status = String(formData.get("status") || "");
  const productIdsRaw = String(formData.get("productIds") || "");
  if (!batchId || !productIdsRaw) return;
  if (!REVIEW_STATUSES.has(status as ReviewStatus)) return;

  const productIds = productIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (productIds.length === 0) return;

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return;
  await db.product.updateMany({
    where: { id: { in: productIds }, batchId: batch.id },
    data: { reviewStatus: status },
  });
  revalidatePath(`/batches/${batchId}`);
}

const MARKETS = new Set(["uk", "us"] as const);

/**
 * Change the batch's market (UK vs US). Drives which prompt template
 * the AI generator uses (Phase 2) and which copy the posting-assist
 * page shows (Phase 5). Per-product overrides win when set.
 */
export async function setBatchMarket(formData: FormData): Promise<void> {
  const batchId = String(formData.get("batchId") || "");
  const market = String(formData.get("market") || "");
  if (!batchId || !MARKETS.has(market as "uk" | "us")) return;

  const { workspace } = await getCurrentWorkspace();
  const updated = await db.batch.updateMany({
    where: { id: batchId, workspaceId: workspace.id },
    data: { market },
  });
  if (updated.count > 0) {
    revalidatePath(`/batches/${batchId}`);
    revalidatePath("/batches");
    revalidatePath("/dashboard");
  }
}

// ---------------------------------------------------------------------
// Phase-4 mobile product-review QR
// ---------------------------------------------------------------------

/**
 * Generate a URL-safe random token for mobile review / posting URLs.
 * 32 bytes of crypto-random → 43-char base64url string. Long enough
 * that brute-forcing the URL is intractable; short enough to fit on
 * a phone screen if the user needs to type it manually.
 */
function _generateReviewToken(): string {
  // base64url encode 32 random bytes. Replace + / = so the token
  // survives in URLs without percent-encoding.
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Ensure the batch has a mobile-review token; create one if not.
 *
 * Token lives on Batch.reviewToken (added in Phase 1) and is the
 * anyone-with-URL credential for the phone review page. Per the
 * v0.7 spec choice ("Anyone-with-URL"), tokens never expire on
 * their own — caller invokes `rotateBatchReviewToken` to mint a
 * new one and invalidate the old.
 *
 * Returns the token (existing or freshly minted). Caller composes
 * the user-facing URL with `/mobile-review/<token>`.
 */
export async function getOrCreateBatchReviewToken(
  batchId: string,
): Promise<{ ok: boolean; token: string | null; message?: string }> {
  if (!batchId) return { ok: false, token: null, message: "missing batchId" };
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true, reviewToken: true },
  });
  if (!batch) return { ok: false, token: null, message: "batch not found" };

  if (batch.reviewToken) {
    return { ok: true, token: batch.reviewToken };
  }

  // Mint a new one. Loop on the (vanishingly unlikely) collision
  // with another batch's existing reviewToken — the @unique
  // constraint on Batch.reviewToken means we'd hit a Prisma error
  // if we tried to save a colliding value.
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = _generateReviewToken();
    try {
      await db.batch.update({
        where: { id: batch.id },
        data:  { reviewToken: token },
      });
      // Silent revalidate — this helper is called from both
      // server actions (e.g. importKalodataForPrompts, where
      // revalidate is required) and from render-time data
      // loaders (getBatchPromptsState via /prompts?batch=<id>,
      // where revalidate throws). See revalidatePathSafe.
      revalidatePathSafe(`/batches/${batchId}`);
      return { ok: true, token };
    } catch (err) {
      // Prisma unique-constraint violation — try again with a new
      // random token. Any other error bubbles up.
      const code = (err as { code?: string }).code;
      if (code !== "P2002") throw err;
      continue;
    }
  }
  return {
    ok: false,
    token: null,
    message:
      "Could not allocate a unique review token after 4 attempts. " +
      "Try again.",
  };
}

/**
 * Force-mint a new review token, invalidating the existing one.
 * Used by the "Rotate token" button on the batch page when the
 * user wants to revoke a previously-shared link.
 */
export async function rotateBatchReviewToken(
  formData: FormData,
): Promise<void> {
  const batchId = String(formData.get("batchId") || "");
  if (!batchId) return;
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return;

  for (let attempt = 0; attempt < 4; attempt++) {
    const token = _generateReviewToken();
    try {
      await db.batch.update({
        where: { id: batch.id },
        data:  { reviewToken: token },
      });
      revalidatePath(`/batches/${batchId}`);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "P2002") throw err;
      continue;
    }
  }
}

/**
 * Public review action invoked from the phone page. Authenticates
 * by token (NOT session cookie) — anyone with the token URL can
 * approve/reject any product in the matching batch.
 *
 * Returns ok:false with a generic message if the token doesn't
 * match or the product isn't in that batch, so a stolen-token
 * holder can't probe for valid product IDs.
 */
export async function setProductReviewStatusViaToken(input: {
  token: string;
  productId: string;
  status: string;
  /**
   * TikTok Shop discount percentage the reviewer captured on the
   * mobile card (integer 1..100). Only meaningful when
   * status === "approved" — feeds the APEX prompt generator's
   * %-dependent hook variants when we auto-generate below. Any
   * non-int / out-of-range value is coerced to null so we never
   * pass garbage to the LLM.
   */
  discountPercent?: number | null;
}): Promise<{ ok: boolean; message?: string }> {
  const { token, productId, status } = input;
  if (!token || !productId) {
    return { ok: false, message: "missing parameters" };
  }
  if (!REVIEW_STATUSES.has(status as ReviewStatus)) {
    return { ok: false, message: "invalid status" };
  }

  // Resolve the batch by token. NO workspace check — the token IS
  // the auth surface. db.batch.findUnique on a unique field is the
  // standard way to do anonymous lookups.
  const batch = await db.batch.findUnique({
    where: { reviewToken: token },
    select: { id: true, workspaceId: true },
  });
  if (!batch) {
    // Don't leak whether the token format was valid vs. just
    // unknown — return the same opaque error either way.
    return { ok: false, message: "invalid review link" };
  }

  // Verify the product belongs to that batch. Stops a stolen
  // token from mutating products in unrelated batches by guessing
  // ids.
  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id, deletedAt: null },
    select: { id: true },
  });
  if (!product) {
    return { ok: false, message: "product not found in batch" };
  }

  // Sanitize discountPercent. Must be an integer 1..100. Anything
  // else (NaN, negative, >100, non-int) → null.
  const pctRaw = input.discountPercent;
  const discountPercent =
    typeof pctRaw === "number" &&
    Number.isFinite(pctRaw) &&
    pctRaw > 0 &&
    pctRaw <= 100
      ? Math.round(pctRaw)
      : null;

  // Write in a try/catch so a schema mismatch (e.g. dev DB
  // hasn't been `prisma db push`'d yet after adding
  // discountPercent) surfaces as a real error the mobile UI can
  // show, rather than a silent 500 that leaves the reviewer
  // thinking the tap worked when nothing was persisted.
  //
  // Fallback: if the write fails specifically because
  // discountPercent isn't a known column (P2022 / unknown-arg
  // 2018 depending on engine version), retry WITHOUT
  // discountPercent so at least the status change persists. The
  // caller message flags that the % couldn't be saved and points
  // at the fix.
  try {
    await db.product.update({
      where: { id: product.id },
      data:  { reviewStatus: status, discountPercent },
    });
  } catch (err) {
    const msg = (err as Error).message || "";
    const looksLikeMissingColumn =
      msg.includes("discountPercent") ||
      msg.includes("P2022") ||
      msg.includes("Unknown arg `discountPercent`") ||
      msg.includes("no such column");
    if (looksLikeMissingColumn) {
      try {
        await db.product.update({
          where: { id: product.id },
          data:  { reviewStatus: status },
        });
        return {
          ok: true,
          message:
            "Status saved, but the discount % column is missing on this deployment. Run `prisma db push` (dev) or the equivalent prod migration to enable capturing discounts.",
        };
      } catch (err2) {
        return {
          ok: false,
          message: `Could not save: ${(err2 as Error).message.slice(0, 200)}`,
        };
      }
    }
    return {
      ok: false,
      message: `Could not save: ${msg.slice(0, 200)}`,
    };
  }

  // Post-approve auto-generation. Fire-and-forget: kick off the
  // generator in the background so the mobile-swipe UI doesn't
  // wait for the LLM round-trip (a reviewer swiping through 30
  // products at 3s each would spend 90s waiting).
  //
  // Why a plain unawaited Promise instead of Next 15's `after()`:
  // in 15.0.x `after` is behind an experimental.after flag and
  // silently drops the callback when the flag is unset — the
  // exact failure mode that stranded every product on
  // "generating…" the first time this shipped. Our production
  // runs in a long-lived Node.js container (docker-compose), so
  // unawaited promises reliably continue running after the
  // response is sent. `Promise.resolve().then(...)` yields one
  // microtask first so revalidatePath's writes complete before
  // the generator queries the row.
  if (status === "approved") {
    const bgBatchId = batch.id;
    const bgProductId = product.id;
    console.log(
      `[mobile-review] queueing post-approve generation for product=${bgProductId}`,
    );
    Promise.resolve().then(async () => {
      try {
        const r = await generateAiPromptForProduct({
          batchId: bgBatchId,
          productId: bgProductId,
          force: true,
        });
        if (r.ok) {
          console.log(
            `[mobile-review] generation OK for product=${bgProductId} via ${r.provider}`,
          );
        } else {
          console.error(
            `[mobile-review] generation returned not-ok for product=${bgProductId}: ${r.message}`,
          );
        }
      } catch (err) {
        console.error(
          `[mobile-review] generation threw for product=${bgProductId}:`,
          err,
        );
      }
    });
  }

  // Revalidate both the mobile page (so subsequent loads see the
  // new status if the reviewer hits Back) AND the owner-facing
  // batch page (so the counts on the desktop side update).
  revalidatePath(`/mobile-review/${token}`);
  revalidatePath(`/batches/${batch.id}`);
  return { ok: true };
}

/**
 * Public soft-delete from the mobile review page. Same auth model
 * as setProductReviewStatusViaToken — token alone is the credential.
 */
export async function softDeleteProductViaToken(input: {
  token: string;
  productId: string;
}): Promise<{ ok: boolean; message?: string }> {
  const { token, productId } = input;
  if (!token || !productId) {
    return { ok: false, message: "missing parameters" };
  }
  const batch = await db.batch.findUnique({
    where: { reviewToken: token },
    select: { id: true },
  });
  if (!batch) return { ok: false, message: "invalid review link" };

  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id, deletedAt: null },
    select: { id: true },
  });
  if (!product) return { ok: false, message: "product not found in batch" };

  await db.product.update({
    where: { id: product.id },
    data:  { deletedAt: new Date() },
  });
  revalidatePath(`/mobile-review/${token}`);
  revalidatePath(`/batches/${batch.id}`);
  return { ok: true };
}

// ---------------------------------------------------------------------
// Phase-5 mobile posting-assist QR
// ---------------------------------------------------------------------

const POSTING_STATUSES = new Set([
  "needs_posting",
  "posted",
  "skipped",
] as const);
type PostingStatus = "needs_posting" | "posted" | "skipped";

/**
 * Ensure the batch has a mobile-posting token; mint one if not.
 * Mirror of getOrCreateBatchReviewToken — same anyone-with-URL
 * auth model, separate token field on Batch.postingToken so
 * rotating the review token doesn't invalidate the posting URL
 * or vice versa.
 */
export async function getOrCreateBatchPostingToken(
  batchId: string,
): Promise<{ ok: boolean; token: string | null; message?: string }> {
  if (!batchId) return { ok: false, token: null, message: "missing batchId" };
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true, postingToken: true },
  });
  if (!batch) return { ok: false, token: null, message: "batch not found" };

  if (batch.postingToken) {
    return { ok: true, token: batch.postingToken };
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const token = _generateReviewToken();
    try {
      await db.batch.update({
        where: { id: batch.id },
        data:  { postingToken: token },
      });
      // Silent revalidate — same reason as getOrCreateBatchReviewToken:
      // /prompts calls this during render via getBatchPromptsState,
      // which forbids revalidatePath. Action callers still get the
      // revalidation they need.
      revalidatePathSafe(`/batches/${batchId}`);
      return { ok: true, token };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "P2002") throw err;
      continue;
    }
  }
  return {
    ok: false,
    token: null,
    message:
      "Could not allocate a unique posting token after 4 attempts. " +
      "Try again.",
  };
}

/** Force-mint a new posting token, invalidating the existing URL. */
export async function rotateBatchPostingToken(
  formData: FormData,
): Promise<void> {
  const batchId = String(formData.get("batchId") || "");
  if (!batchId) return;
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return;

  for (let attempt = 0; attempt < 4; attempt++) {
    const token = _generateReviewToken();
    try {
      await db.batch.update({
        where: { id: batch.id },
        data:  { postingToken: token },
      });
      revalidatePath(`/batches/${batchId}`);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "P2002") throw err;
      continue;
    }
  }
}

/**
 * Public posting-status action invoked from the mobile posting
 * page. Authenticates by token, not session cookie. Sets
 * Product.postingStatus to one of:
 *   needs_posting | posted | skipped
 *
 * Optional notes are persisted to Product.postingNotes — the
 * shopper-style page lets the user leave a remark without
 * exposing it on the owner-facing dashboard until they want it.
 */
export async function setProductPostingStatusViaToken(input: {
  token: string;
  productId: string;
  status: string;
  notes?: string | null;
}): Promise<{ ok: boolean; message?: string }> {
  const { token, productId, status, notes } = input;
  if (!token || !productId) {
    return { ok: false, message: "missing parameters" };
  }
  if (!POSTING_STATUSES.has(status as PostingStatus)) {
    return { ok: false, message: "invalid status" };
  }

  const batch = await db.batch.findUnique({
    where: { postingToken: token },
    select: { id: true },
  });
  if (!batch) {
    return { ok: false, message: "invalid posting link" };
  }

  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id, deletedAt: null },
    select: { id: true },
  });
  if (!product) {
    return { ok: false, message: "product not found in batch" };
  }

  const updateData: { postingStatus: string; postingNotes?: string | null } = {
    postingStatus: status,
  };
  // Only touch postingNotes when the caller explicitly passes one;
  // undefined means "leave existing notes alone." Empty string
  // means "clear the notes" (intentional clear).
  if (notes !== undefined) {
    updateData.postingNotes =
      typeof notes === "string" && notes.trim().length > 0
        ? notes.trim()
        : null;
  }

  await db.product.update({
    where: { id: product.id },
    data:  updateData,
  });
  revalidatePath(`/mobile-posting/${token}`);
  revalidatePath(`/batches/${batch.id}`);
  return { ok: true };
}

// ---------------------------------------------------------------------
// Kalodata import
// ---------------------------------------------------------------------

export interface KalodataImportReport {
  ok: boolean;
  message: string;
  sheetName: string | null;
  productsFound: number;
  productsCreated: number;
  imagesDownloaded: number;
  imagesFailed: number;
  /**
   * Subset of imagesFailed that hit EACCES / EPERM when the app
   * tried to mkdir / write into public/uploads. Surfaced
   * separately so the UI can show an operator-friendly "run
   * fix-upload-perms.sh" hint instead of N copies of the same
   * permissions error.
   */
  permissionErrors: number;
  failures: Array<{
    productName: string;
    reason: string;
  }>;
}

/**
 * Parse a Kalodata workbook, create one Product per row, and download
 * each row's image into `public/uploads/batches/<batchId>/`. Returns
 * a small import report the UI shows back to the user.
 *
 * Skipped failures are non-fatal: a row whose image download fails
 * still becomes a Product (so the user can hand-edit it) — the image
 * URLs are just left null. The report lists every download failure so
 * the user can decide whether to retry.
 *
 * This action runs entirely server-side; the .xlsx bytes never leave
 * the server-action invocation, and the downloaded images go straight
 * to the filesystem (no signed URL hand-off yet).
 */
export async function importKalodataXlsx(
  formData: FormData,
): Promise<KalodataImportReport> {
  const batchId = String(formData.get("batchId") || "");
  const file = formData.get("file") as File | null;
  if (!batchId || !file) {
    return failReport("Missing batch or file.");
  }

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return failReport("Batch not found in this workspace.");

  // Parse the workbook into typed rows. Anything malformed at the
  // XLSX level surfaces as a single import-level failure, not a
  // per-row issue — the rows are unreadable in that case.
  let parsed;
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    parsed = parseKalodataWorkbook(bytes);
  } catch (err) {
    return failReport(
      `Could not read workbook: ${(err as Error).message}`,
    );
  }

  let imagesDownloaded = 0;
  let imagesFailed = 0;
  let permissionErrors = 0;
  let productsCreated = 0;
  const failures: KalodataImportReport["failures"] = [];

  for (const row of parsed.rows) {
    // Create the Product *first* so we can use its id in the filename.
    // If the download fails the row still survives with
    // referenceImageUrl=null — the user can re-import or hand-edit it
    // later, and the UI renders a "Image download failed" placeholder
    // instead of a broken image icon.
    const product = await db.product.create({
      data: {
        batchId: batch.id,
        productName:   row.productName,
        originalTitle: row.originalTitle || row.productName,
        tiktokUrl:     row.tiktokUrl || null,
        category:      row.category || null,
        imageUrl:      row.imgUrl || null,
      },
    });
    productsCreated += 1;

    if (!row.imgUrl) {
      imagesFailed += 1;
      failures.push({
        productName: row.productName,
        reason: "no image URL in source row",
      });
      continue;
    }

    // Server-side log gives us a per-product audit trail without
    // leaking sensitive payloads — product id, name, and the source
    // URL are already in the user's own data.
    console.log(
      `[kalodata] downloading image for product=${product.id} (${row.productName.slice(0, 60)}) src=${redactUrlForLog(row.imgUrl)}`,
    );

    try {
      const dl = await downloadProductImage({
        url: row.imgUrl,
        workspaceId: workspace.id,
        batchId: batch.id,
        productId: product.id,
      });
      // Phase 3: write through the ProductImage helper so the primary
      // ProductImage row + the denormalised Product.referenceImageUrl
      // cache stay in lockstep. upsertProductImage handles both writes
      // in the right order.
      await upsertProductImage({
        productId: product.id,
        role: "primary",
        url: dl.relUrl,
        source: "kalodata",
        bytes: dl.size,
      });
      console.log(
        `[kalodata]   ↳ saved ${dl.size}B as ${dl.relUrl}`,
      );
      imagesDownloaded += 1;
    } catch (err) {
      const e = err as Error;
      const msg = e.message || "download failed";
      if (msg.includes("Upload directory is not writable")) {
        permissionErrors += 1;
      }
      imagesFailed += 1;
      console.warn(
        `[kalodata]   ↳ failed: ${msg}`,
      );
      failures.push({
        productName: row.productName,
        reason: msg,
      });
    }
  }

  revalidatePath(`/batches/${batchId}`);
  revalidatePath("/dashboard");

  return {
    ok: true,
    message:
      permissionErrors > 0
        ? `Imported ${productsCreated} product(s) but ${permissionErrors} image(s) failed with permission errors. ` +
            `Run scripts/fix-upload-perms.sh on the server and re-import.`
        : productsCreated > 0
          ? `Imported ${productsCreated} product(s) from "${parsed.sheetName}".`
          : "No product rows found in the workbook.",
    sheetName: parsed.sheetName,
    productsFound: parsed.rows.length,
    productsCreated,
    imagesDownloaded,
    imagesFailed,
    permissionErrors,
    failures: failures.slice(0, 20),
  };
}

function failReport(message: string): KalodataImportReport {
  return {
    ok: false,
    message,
    sheetName: null,
    productsFound: 0,
    productsCreated: 0,
    imagesDownloaded: 0,
    imagesFailed: 0,
    permissionErrors: 0,
    failures: [],
  };
}

// ---------------------------------------------------------------------
// Bulk UK store prompt generation
// ---------------------------------------------------------------------

export interface BulkPromptReport {
  ok: boolean;
  message: string;
  generated: number;
  skipped: number;
}

/**
 * Apply `buildUkRetailPrompt` to every product in the batch that
 * doesn't already have a prompt (or, when `overwrite=true`, to all
 * products). Also fills in `retailerName` when the auto-picker found
 * a better match than what's stored.
 *
 * Deterministic — no AI calls. The full AI provider integration is a
 * later phase (see ROADMAP.md).
 */
export async function generateUkStorePrompts(input: {
  batchId: string;
  overwrite?: boolean;
}): Promise<BulkPromptReport> {
  const { batchId, overwrite = false } = input;
  if (!batchId) {
    return { ok: false, message: "missing batchId", generated: 0, skipped: 0 };
  }
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) {
    return { ok: false, message: "batch not found", generated: 0, skipped: 0 };
  }

  const products = await db.product.findMany({
    where: { batchId: batch.id },
    select: {
      id: true,
      productName: true,
      category: true,
      retailerName: true,
      imagePrompt: true,
    },
  });

  let generated = 0;
  let skipped = 0;
  for (const p of products) {
    if (p.imagePrompt && !overwrite) {
      skipped += 1;
      continue;
    }
    const { prompt, retailerKey } = buildUkRetailPrompt({
      productName: p.productName,
      category:    p.category,
      retailerName: p.retailerName,
    });
    await db.product.update({
      where: { id: p.id },
      data: {
        imagePrompt:  prompt,
        retailerName: p.retailerName || retailerKey,
      },
    });
    generated += 1;
  }

  revalidatePath(`/batches/${batchId}`);
  return {
    ok: true,
    message: `Generated ${generated} prompt(s), skipped ${skipped}.`,
    generated,
    skipped,
  };
}

// ---------------------------------------------------------------------
// AI prompt generation (bulk, per batch)
// ---------------------------------------------------------------------

export interface AiBulkReport {
  ok: boolean;
  message: string;
  provider: string;
  generated: number;
  skipped: number;
  failed: number;
  failures: Array<{ productName: string; reason: string }>;
}

/**
 * Run the configured AI provider against every product in the batch
 * that is missing an imagePrompt (or all of them, when `mode = "all"`).
 *
 * Per-product failures don't stop the run — they get recorded on
 * `Product.aiPromptError` and counted into the report. Successful
 * products clear that error and store the new prompt + retailer +
 * supporting copy.
 *
 * Manual provider: deterministic, no API key, never fails.
 * Remote providers: depend on whichever settings the workspace has saved.
 */
export async function generateAiPrompts(input: {
  batchId: string;
  mode: AiOverwriteMode;
  /** Opt-in vision-enabled generation. When true AND a product has
   *  a referenceImageUrl AND the provider isn't "manual", the AI
   *  receives the product image alongside the text and can
   *  describe specific visible details. More expensive per call. */
  useVision?: boolean;
}): Promise<AiBulkReport> {
  const { batchId, mode, useVision = false } = input;
  if (!batchId) {
    return emptyAiReport("missing batchId");
  }

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    // Pull the batch market so we can pass it through to the AI
    // provider. Phase-2 wiring — without this every prompt fell
    // back to UK regardless of the batch's selected market.
    select: { id: true, market: true },
  });
  if (!batch) return emptyAiReport("batch not found");

  // Normalise to one of the AiMarket values. Defaults to "uk"
  // for any batch row that still carries an unrecognised value
  // (defensive — Phase-1 default is already "uk").
  const batchMarket: "uk" | "us" = batch.market === "us" ? "us" : "uk";

  const settingsRow = await loadOrCreateSettings(workspace.id);
  const settings = toServerSettings(settingsRow);

  const products = await db.product.findMany({
    // Skip soft-deleted rows so we don't burn AI credits on
    // products the user has already removed from the batch.
    where: { batchId: batch.id, deletedAt: null },
    select: {
      id: true,
      productName: true,
      originalTitle: true,
      category: true,
      retailerName: true,
      tiktokUrl: true,
      referenceImageUrl: true,
      imagePrompt: true,
      // Per-product market override. Falls back to the batch
      // market when null (or when set to something we don't
      // recognise).
      market: true,
    },
  });

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const failures: AiBulkReport["failures"] = [];

  for (const p of products) {
    if (p.imagePrompt && mode !== "all") {
      skipped += 1;
      continue;
    }

    // Per-product market override wins when present; otherwise
    // inherit the batch's market.
    const effectiveMarket: "uk" | "us" =
      p.market === "us" ? "us" : p.market === "uk" ? "uk" : batchMarket;

    try {
      // For vision, the AI needs an absolute URL it can fetch.
      // Product.referenceImageUrl is `/uploads/...`; promote it
      // via toAgentAssetUrl (same helper the runner dispatch
      // uses). Skip vision when there's no reference image.
      const visionUrl =
        useVision && p.referenceImageUrl
          ? toAgentAssetUrl(p.referenceImageUrl)
          : null;
      const { output } = await callProvider(
        {
          productName:       p.productName,
          originalTitle:     p.originalTitle,
          category:          p.category,
          retailerName:      p.retailerName,
          tiktokUrl:         p.tiktokUrl,
          referenceImageUrl: visionUrl ?? p.referenceImageUrl,
          market:            effectiveMarket,
        },
        settings,
        { useVision: visionUrl !== null },
      );
      await db.product.update({
        where: { id: p.id },
        data: {
          imagePrompt:         output.imagePrompt,
          retailerName:        output.retailerName,
          hook:                output.hook ?? null,
          hookVariants:        output.hookVariants && output.hookVariants.length > 0
            ? encodeJson(output.hookVariants)
            : null,
          caption:             output.caption ?? null,
          hashtags:            output.hashtags
            ? encodeJson(output.hashtags)
            : null,
          // Phase-2: persist the new productDescription field.
          // Used by the posting-assist QR page (Phase 5). Null
          // when the provider didn't return one — UK workflow
          // still doesn't.
          productDescription:  output.productDescription ?? null,
          aiPromptError:       null,
          aiPromptGeneratedAt: new Date(),
        },
      });
      generated += 1;
    } catch (err) {
      const e = err as Error;
      const reason = `${e.name}: ${String(e.message ?? e).slice(0, 200)}`;
      failed += 1;
      failures.push({ productName: p.productName, reason });
      // Record the failure on the product row so the user sees it
      // inline next to the chip. We never overwrite a previously
      // working imagePrompt on failure.
      try {
        await db.product.update({
          where: { id: p.id },
          data: { aiPromptError: reason },
        });
      } catch {
        // Best-effort; if the row vanished mid-run we just skip.
      }
    }
  }

  revalidatePath(`/batches/${batchId}`);
  return {
    ok: true,
    message:
      generated === 0 && failed === 0
        ? `Nothing to generate. (${skipped} skipped — already had a prompt.)`
        : `Generated ${generated}, skipped ${skipped}, failed ${failed}.`,
    provider: settings.provider,
    generated,
    skipped,
    failed,
    failures: failures.slice(0, 20),
  };
}

function emptyAiReport(message: string): AiBulkReport {
  return {
    ok: false,
    message,
    provider: "",
    generated: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
}

// ---------------------------------------------------------------------
// AI prompt generation — single product
// ---------------------------------------------------------------------
//
// Counterpart to generateAiPrompts (bulk). Lets the client drive
// per-product progress: fire N of these in parallel (with a small
// concurrency cap), update a Map<productId, status> as each
// resolves, and show a live progress list. Also powers the inline
// "Regenerate" button on each product card.

export interface AiSingleResult {
  ok: boolean;
  /** When ok, the productId we updated (echoed back so the client
   *  can route the result to the right row without re-deriving). */
  productId: string;
  /** Free-form summary — "generated", "skipped (already had prompt)",
   *  or the failure reason. Surfaced in the per-product progress UI. */
  message: string;
  /** Provider that was actually used (echoes settings.provider). */
  provider: string;
}

/**
 * Run the configured AI provider against ONE product. The client
 * orchestrates parallelism + progress; this action is intentionally
 * focused on a single row.
 *
 * `force` controls "regenerate even if there's already a prompt"
 * (the regenerate button on the product card sets it; the bulk
 * "missing only" mode doesn't).
 *
 * Workspace-scoped via the batch — re-resolves so a stale client
 * can't drive AI generation on a product in another tenant.
 */
export async function generateAiPromptForProduct(input: {
  batchId: string;
  productId: string;
  /** When true, regenerate even if the product already has a prompt.
   *  When false (default), products with a prompt are skipped — useful
   *  for the bulk "missing only" mode driven from the client. */
  force?: boolean;
  /** Phase 9.5 — opt-in vision: send the product's reference image
   *  alongside the text so the AI can describe specific visible
   *  details (colors, branding placement, hardware) in the
   *  image_prompt instead of guessing from the product name. */
  useVision?: boolean;
}): Promise<AiSingleResult> {
  const { batchId, productId, force = false, useVision = false } = input;
  if (!batchId || !productId) {
    return {
      ok: false,
      productId,
      message: "missing batchId or productId",
      provider: "",
    };
  }

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true, market: true },
  });
  if (!batch) {
    return { ok: false, productId, message: "batch not found", provider: "" };
  }

  const batchMarket: "uk" | "us" = batch.market === "us" ? "us" : "uk";

  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id, deletedAt: null },
    select: {
      id: true,
      productName: true,
      originalTitle: true,
      category: true,
      retailerName: true,
      tiktokUrl: true,
      referenceImageUrl: true,
      imagePrompt: true,
      market: true,
      // Feeds the APEX prompt generator's %-dependent hook
      // variants. Captured on the mobile review card at approval
      // time. Null when the reviewer didn't type a %.
      discountPercent: true,
    },
  });
  if (!product) {
    return { ok: false, productId, message: "product not found", provider: "" };
  }

  const settingsRow = await loadOrCreateSettings(workspace.id);
  const settings = toServerSettings(settingsRow);

  if (product.imagePrompt && !force) {
    return {
      ok: true,
      productId,
      message: "skipped (already had a prompt)",
      provider: settings.provider,
    };
  }

  const effectiveMarket: "uk" | "us" =
    product.market === "us"
      ? "us"
      : product.market === "uk"
        ? "uk"
        : batchMarket;

  try {
    const visionUrl =
      useVision && product.referenceImageUrl
        ? toAgentAssetUrl(product.referenceImageUrl)
        : null;
    const { output } = await callProvider(
      {
        productName:       product.productName,
        originalTitle:     product.originalTitle,
        category:          product.category,
        retailerName:      product.retailerName,
        tiktokUrl:         product.tiktokUrl,
        referenceImageUrl: visionUrl ?? product.referenceImageUrl,
        market:            effectiveMarket,
        discountPercent:   product.discountPercent ?? null,
      },
      settings,
      { useVision: visionUrl !== null },
    );
    await db.product.update({
      where: { id: productId },
      data: {
        imagePrompt:         output.imagePrompt,
        retailerName:        output.retailerName,
        hook:                output.hook ?? null,
        hookVariants:        output.hookVariants && output.hookVariants.length > 0
          ? encodeJson(output.hookVariants)
          : null,
        caption:             output.caption ?? null,
        hashtags:            output.hashtags
          ? encodeJson(output.hashtags)
          : null,
        productDescription:  output.productDescription ?? null,
        aiPromptError:       null,
        aiPromptGeneratedAt: new Date(),
      },
    });
    revalidatePath(`/batches/${batchId}`);
    return {
      ok: true,
      productId,
      message: "generated",
      provider: settings.provider,
    };
  } catch (err) {
    const e = err as Error;
    const reason = `${e.name}: ${String(e.message ?? e).slice(0, 200)}`;
    // Best-effort: record the failure on the row so the user sees it
    // even after the client-side progress UI clears.
    try {
      await db.product.update({
        where: { id: productId },
        data: { aiPromptError: reason },
      });
    } catch {
      // row vanished mid-run; nothing to do
    }
    revalidatePath(`/batches/${batchId}`);
    return {
      ok: false,
      productId,
      message: reason,
      provider: settings.provider,
    };
  }
}

// ---------------------------------------------------------------------
// Phase 9 — IP / trademark risk screening
// ---------------------------------------------------------------------
//
// Server actions:
//   - checkProductIpRisk        — run heuristic (always) + optional AI
//                                  check on a single product. Higher
//                                  score wins on merge. Client
//                                  parallelises for batch checks.
//   - setProductIpRiskOverride   — record / clear the per-product
//                                  override that lets a high-risk
//                                  product through generation. High
//                                  risk override requires a reason.
//
// Hard rules preserved from the Phase 9 spec:
//   - Messaging says "potential risk", never "illegal".
//   - High and needs_manual_review excluded from generation by default.
//   - High override requires a written reason logged with timestamp.
//   - AI call sends ONLY product text — no API keys, no runner tokens,
//     no cookies.

import {
  assessProductIpRisk,
  mergeIpRisk,
  type IpRiskAssessment,
  type IpRiskStatus,
} from "@/lib/ip-risk";
import {
  aiAssessIpRisk,
  aiAssessIpRiskWithVision,
} from "@/lib/ai/ip-risk-ai";
import { toAgentAssetUrl } from "@/lib/uploads";

export interface CheckProductIpRiskResult {
  ok: boolean;
  productId: string;
  /** Final merged verdict (heuristic ∪ AI, higher score wins). */
  status: IpRiskStatus;
  /** Concatenated reasons — heuristic first, then AI-prefixed reasons. */
  reasons: string[];
  /** "approve" / "review" / "reject" — non-binding; gating uses status. */
  recommendation: IpRiskAssessment["recommendation"];
  /** Provider that handled the AI half (or "manual" / "heuristic-only"). */
  provider: string;
  /** Free-form transport error message when ok=false. */
  message: string;
}

/**
 * Run the IP/trademark risk screen on one product. Heuristic always
 * runs; AI runs only when `useAi` is true AND the workspace has a
 * non-manual provider configured.
 *
 * Persists the merged verdict to the product row:
 *   - ipRiskStatus
 *   - ipRiskReasons (JSON-encoded string[])
 *   - ipRiskCheckedAt (now)
 *
 * Does NOT modify ipRiskOverride or its reason/timestamp — those are
 * user-driven and stay sticky across re-runs.
 */
export async function checkProductIpRisk(input: {
  batchId: string;
  productId: string;
  useAi?: boolean;
  /** Phase 9 v2 — when true AND useAi is true AND the product has
   *  a reference image, runs the vision-assisted AI check
   *  (catches misspellings on packaging, fake logos, etc. that
   *  text-only can't see). Falls back to text-only AI on failure. */
  useVision?: boolean;
}): Promise<CheckProductIpRiskResult> {
  const {
    batchId,
    productId,
    useAi = false,
    useVision = false,
  } = input;
  if (!batchId || !productId) {
    return _emptyIpRiskResult(productId, "missing batchId or productId");
  }

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return _emptyIpRiskResult(productId, "batch not found");

  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id, deletedAt: null },
    select: {
      id: true,
      productName: true,
      originalTitle: true,
      category: true,
      tiktokUrl: true,
      // Phase 9 v2 — fetch the primary image URL for vision check.
      referenceImageUrl: true,
    },
  });
  if (!product) return _emptyIpRiskResult(productId, "product not found");

  // Heuristic always runs — it's pure, cheap, no API key needed.
  const heuristic = assessProductIpRisk({
    productName:   product.productName,
    originalTitle: product.originalTitle,
    category:      product.category,
    tiktokUrl:     product.tiktokUrl,
  });

  // AI check is opt-in. Manual provider returns null (no AI to call).
  let aiVerdict: IpRiskAssessment | null = null;
  let providerLabel = "heuristic-only";
  if (useAi) {
    const settingsRow = await loadOrCreateSettings(workspace.id);
    const settings = toServerSettings(settingsRow);

    // Vision-assisted check needs an absolute, publicly fetchable
    // image URL. Fall back to text-only when vision is requested
    // but no image is available (don't make the user re-click).
    const visionImageUrl =
      useVision && product.referenceImageUrl
        ? toAgentAssetUrl(product.referenceImageUrl)
        : null;
    const visionWanted = useVision && visionImageUrl !== null;

    try {
      const aiResult = visionWanted
        ? await aiAssessIpRiskWithVision(
            {
              productName:   product.productName,
              originalTitle: product.originalTitle,
              category:      product.category,
              tiktokUrl:     product.tiktokUrl,
            },
            settings,
            visionImageUrl!,
          )
        : await aiAssessIpRisk(
            {
              productName:   product.productName,
              originalTitle: product.originalTitle,
              category:      product.category,
              tiktokUrl:     product.tiktokUrl,
            },
            settings,
          );
      if (aiResult) {
        aiVerdict = aiResult.verdict;
        const visionTag = visionWanted ? " + vision" : "";
        providerLabel = `heuristic + ${aiResult.provider}${visionTag} (${aiResult.model})`;
      } else {
        // Provider was "manual" — no AI call to make.
        providerLabel = "heuristic-only (manual provider)";
      }
    } catch (err) {
      const e = err as Error;
      // Vision failure → try text-only as a graceful fallback
      // before giving up. A bad image URL or rate-limited vision
      // model shouldn't block the AI check entirely.
      if (visionWanted) {
        try {
          const fallback = await aiAssessIpRisk(
            {
              productName:   product.productName,
              originalTitle: product.originalTitle,
              category:      product.category,
              tiktokUrl:     product.tiktokUrl,
            },
            settings,
          );
          if (fallback) {
            aiVerdict = fallback.verdict;
            providerLabel = `heuristic + ${fallback.provider} (${fallback.model}) [vision failed: ${e.name}]`;
            // Skip the heuristic-error pushback below; we got a
            // successful text-only verdict.
            heuristic.reasons.push(
              `Vision check failed (${e.name}: ${String(e.message ?? e).slice(0, 120)}); fell back to text-only AI.`,
            );
          } else {
            providerLabel = "heuristic-only (AI call failed)";
          }
        } catch (fallbackErr) {
          const fe = fallbackErr as Error;
          heuristic.reasons.push(
            `AI check failed: ${fe.name}: ${String(fe.message ?? fe).slice(0, 160)}`,
          );
          providerLabel = "heuristic-only (AI call failed)";
        }
      } else {
        heuristic.reasons.push(
          `AI check failed: ${e.name}: ${String(e.message ?? e).slice(0, 160)}`,
        );
        providerLabel = "heuristic-only (AI call failed)";
      }
    }
  }

  const merged = mergeIpRisk(heuristic, aiVerdict);

  // Persist. ipRiskReasons stores the JSON-encoded merged reasons —
  // decode helper in lib/ip-risk.ts.
  await db.product.update({
    where: { id: productId },
    data: {
      ipRiskStatus:    merged.status,
      ipRiskReasons:   encodeJson(merged.reasons),
      ipRiskCheckedAt: new Date(),
    },
  });

  revalidatePath(`/batches/${batchId}`);

  return {
    ok: true,
    productId,
    status:         merged.status,
    reasons:        merged.reasons,
    recommendation: merged.recommendation,
    provider:       providerLabel,
    message:        `Risk verdict: ${merged.status}.`,
  };
}

function _emptyIpRiskResult(
  productId: string,
  message: string,
): CheckProductIpRiskResult {
  return {
    ok:             false,
    productId,
    status:         "unchecked",
    reasons:        [],
    recommendation: "review",
    provider:       "",
    message,
  };
}

/**
 * Set or clear the per-product override. Override lets a high-risk
 * product through image generation; for "high" or
 * "needs_manual_review" rows, an override REQUIRES a written reason
 * (per the Phase 9 spec).
 *
 * To clear an override: pass override=false; reason is ignored.
 */
export async function setProductIpRiskOverride(formData: FormData): Promise<{
  ok: boolean;
  message: string;
}> {
  const productId = String(formData.get("productId") || "");
  const batchId = String(formData.get("batchId") || "");
  const overrideRaw = String(formData.get("override") || "");
  const reason = String(formData.get("reason") || "").trim();

  if (!productId || !batchId) {
    return { ok: false, message: "Missing productId or batchId" };
  }
  const override = overrideRaw === "true" || overrideRaw === "on";

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return { ok: false, message: "Batch not found" };

  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id },
    select: { id: true, ipRiskStatus: true },
  });
  if (!product) return { ok: false, message: "Product not found" };

  // High-risk override requires a reason. Low/medium can be
  // overridden without one (rare path — you'd only override low/
  // medium if you wanted to FORCE generation past the
  // "approve-only" gate, but that gate doesn't filter low/medium
  // anyway, so override on those is a no-op).
  if (
    override &&
    (product.ipRiskStatus === "high" ||
      product.ipRiskStatus === "needs_manual_review") &&
    reason.length === 0
  ) {
    return {
      ok: false,
      message:
        "An override reason is required for high-risk or needs-review products.",
    };
  }

  if (override) {
    await db.product.update({
      where: { id: productId },
      data: {
        ipRiskOverride:       true,
        ipRiskOverrideReason: reason || null,
        ipRiskOverrideAt:     new Date(),
      },
    });
  } else {
    // Clearing: wipe reason and timestamp too, so a future re-check
    // doesn't see stale audit data.
    await db.product.update({
      where: { id: productId },
      data: {
        ipRiskOverride:       false,
        ipRiskOverrideReason: null,
        ipRiskOverrideAt:     null,
      },
    });
  }

  revalidatePath(`/batches/${batchId}`);
  return {
    ok: true,
    message: override ? "Override recorded." : "Override cleared.",
  };
}

// Note: decodeIpRiskReasons and IP_RISK_STATUSES are pure values,
// not server actions. Client / server-component consumers should
// import them directly from "@/lib/ip-risk".

// ---------------------------------------------------------------------
// Phase 10 — pipeline drag-and-drop server action
// ---------------------------------------------------------------------
//
// One action that turns "the user dropped product X on lane Y" into
// the right state transition. The mapping:
//
//   targetStage = "needs_review" → setReviewStatus("needs_review")
//                                  (rework path — useful from any
//                                  later stage back to the start)
//   targetStage = "ready"        → setReviewStatus("approved")
//                                  Note: the product may not
//                                  actually appear in "ready" if
//                                  it's still missing a prompt or
//                                  a ref image; the stage helper
//                                  will keep it in needs_review
//                                  with the gates surfaced. That's
//                                  correct UX: dropping on ready
//                                  expresses intent, not magic.
//   targetStage = "generating"   → NOT a valid drop target. A
//                                  product enters "generating"
//                                  because a job is running, not
//                                  because the user dragged it
//                                  there. Returns an error.
//   targetStage = "generated"    → NOT a valid drop target either.
//                                  Generated state is derived from
//                                  having a bound FlowItem.
//   targetStage = "posted"       → setPostingStatus("posted")
//                                  Marks the product as posted
//                                  (mirrors the mobile-posting QR
//                                  button).
//
// Workspace-scoped via the batch lookup. Returns a structured
// result so the client can render a toast on rejection.

export async function moveProductToStage(formData: FormData): Promise<{
  ok: boolean;
  message: string;
}> {
  const batchId = String(formData.get("batchId") || "");
  const productId = String(formData.get("productId") || "");
  const targetStage = String(formData.get("targetStage") || "");

  if (!batchId || !productId || !targetStage) {
    return {
      ok: false,
      message: "Missing batchId / productId / targetStage",
    };
  }

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return { ok: false, message: "Batch not found" };

  const product = await db.product.findFirst({
    where: { id: productId, batchId: batch.id, deletedAt: null },
    select: { id: true },
  });
  if (!product) return { ok: false, message: "Product not found" };

  switch (targetStage) {
    case "needs_review":
      await db.product.update({
        where: { id: productId },
        data: { reviewStatus: "needs_review" },
      });
      revalidatePath(`/batches/${batchId}`);
      return { ok: true, message: "Sent back to review." };

    case "ready":
      await db.product.update({
        where: { id: productId },
        data: { reviewStatus: "approved" },
      });
      revalidatePath(`/batches/${batchId}`);
      return {
        ok: true,
        message:
          "Approved. If the card stays in 'Needs review', it's missing a prompt, a reference image, or has unresolved IP risk.",
      };

    case "generating":
      return {
        ok: false,
        message:
          "Can't drop a product into Generating directly. Use the 'Generate' button on a Ready card to start a generation job.",
      };

    case "generated":
      return {
        ok: false,
        message:
          "Generated is set when Flow produces an image for this product. Drag works in either direction across the other stages.",
      };

    case "posted":
      await db.product.update({
        where: { id: productId },
        data: { postingStatus: "posted" },
      });
      revalidatePath(`/batches/${batchId}`);
      return { ok: true, message: "Marked as posted." };

    default:
      return {
        ok: false,
        message: `Unknown target stage: ${targetStage}`,
      };
  }
}

// ---------------------------------------------------------------------
// Kill switch — cancel all queued / running jobs in a batch
// ---------------------------------------------------------------------
//
// User clicks "Stop generation" → all running + queued jobs in the
// batch get marked status="cancelled". Effects:
//
//   - Queued jobs: never claimed by the runner (it filters by
//     status="queued" on the /next route).
//   - Running job: the runner is mid-loop. On its next /events POST
//     (one per item), the API returns {cancelled: true} in the
//     response body and the runner-side image loop exits cleanly
//     at the next iteration boundary. The runner's /complete call
//     then reports the partial result.
//   - Currently in-flight item: cannot be interrupted mid-Playwright
//     action. User waits up to ~30s for the current item to finish.
//
// Workspace-scoped via the batch.
export async function cancelBatchJobs(formData: FormData): Promise<{
  ok: boolean;
  cancelled: number;
  message: string;
}> {
  const batchId = String(formData.get("batchId") || "");
  if (!batchId) return { ok: false, cancelled: 0, message: "Missing batchId" };

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return { ok: false, cancelled: 0, message: "Batch not found" };

  // Update queued + running together. The runner sees the new
  // status through its next /events POST (running) or skips
  // the job entirely (queued).
  const result = await db.job.updateMany({
    where: {
      workspaceId: workspace.id,
      batchId: batch.id,
      status: { in: ["queued", "running"] },
    },
    data: { status: "cancelled" },
  });

  revalidatePath(`/batches/${batchId}`);
  return {
    ok: true,
    cancelled: result.count,
    message:
      result.count === 0
        ? "No queued or running jobs to cancel."
        : `Cancelled ${result.count} job${result.count === 1 ? "" : "s"}. Runner will stop at the next item.`,
  };
}

// ---------------------------------------------------------------------
// Phase 6 — Flow reconciliation server actions
// ---------------------------------------------------------------------
//
// These actions back the drag-and-drop bind / ignore / un-ignore
// surface on the Flow items tab. Each is workspace-scoped via the
// batch the FlowItem belongs to, so a stale client can't touch
// rows in another tenant.
//
// Note: per-tile video animation (the spec's "Generate video
// anyway" action) needs a new runner job type and is intentionally
// out of scope for this commit. The existing bulk
// generate_flow_videos_from_favorites workbench button still
// works untouched — that animates ALL favorited tiles. A future
// commit will add animate_single_flow_tile to the runner so we
// can animate one specific tile from the reconciliation UI.

/** Whitelist of valid bindState values — guards the server action
 *  against arbitrary string injection. */
const FLOW_ITEM_BIND_STATES = new Set([
  "unbound",
  "bound",
  "ignored",
  "auto",
] as const);

async function _resolveFlowItemInBatch(input: {
  flowItemId: string;
  batchId: string;
}): Promise<{ ok: false; message: string } | { ok: true; workspaceId: string }> {
  if (!input.flowItemId || !input.batchId) {
    return { ok: false, message: "Missing flowItemId or batchId" };
  }
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: input.batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return { ok: false, message: "Batch not found" };
  const item = await db.flowItem.findFirst({
    where: {
      id: input.flowItemId,
      workspaceId: workspace.id,
      batchId: batch.id,
    },
    select: { id: true },
  });
  if (!item) return { ok: false, message: "Flow item not found" };
  return { ok: true, workspaceId: workspace.id };
}

/**
 * Bind a FlowItem to a Product (drag-drop on the Flow items tab).
 *
 * FormData fields:
 *   - flowItemId  (required)
 *   - batchId     (required, for workspace scope check)
 *   - productId   (required — the target product)
 *
 * Sets bindState="bound" + productId. Clears any prior notes
 * (which were probably the "ignored" reason; binding clears that
 * context).
 */
export async function bindFlowItemToProduct(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const flowItemId = String(formData.get("flowItemId") || "");
  const batchId = String(formData.get("batchId") || "");
  const productId = String(formData.get("productId") || "");

  const scope = await _resolveFlowItemInBatch({ flowItemId, batchId });
  if (!scope.ok) return scope;

  // Verify the product is in this batch — a stale client must not
  // bind a flow item to a product from another batch.
  const product = await db.product.findFirst({
    where: { id: productId, batchId, deletedAt: null },
    select: { id: true },
  });
  if (!product) {
    return {
      ok: false,
      message: "Product not found in this batch (it may have been deleted).",
    };
  }

  await db.flowItem.update({
    where: { id: flowItemId },
    data: {
      bindState: "bound",
      productId,
      notes:     null,
    },
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: "Bound." };
}

/**
 * Reverse `bindFlowItemToProduct`. Sets bindState="unbound" and
 * clears productId. Used both for "I changed my mind on a manual
 * bind" and for "this auto-bound tile was wrong" — works on bound
 * AND auto-bound rows.
 */
export async function unbindFlowItem(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const flowItemId = String(formData.get("flowItemId") || "");
  const batchId = String(formData.get("batchId") || "");

  const scope = await _resolveFlowItemInBatch({ flowItemId, batchId });
  if (!scope.ok) return scope;

  await db.flowItem.update({
    where: { id: flowItemId },
    data: { bindState: "unbound", productId: null, notes: null },
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: "Unbound." };
}

/**
 * Mark a FlowItem as "not relevant to this batch". Optional reason
 * captured in `notes` for the audit trail. Ignored items stay in
 * the database (we can un-ignore later) but disappear from the
 * default Unmatched view.
 */
export async function ignoreFlowItem(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const flowItemId = String(formData.get("flowItemId") || "");
  const batchId = String(formData.get("batchId") || "");
  const reason = String(formData.get("reason") || "").trim();

  const scope = await _resolveFlowItemInBatch({ flowItemId, batchId });
  if (!scope.ok) return scope;

  await db.flowItem.update({
    where: { id: flowItemId },
    data: {
      bindState: "ignored",
      productId: null,
      notes:     reason || null,
    },
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: "Ignored." };
}

/**
 * Reverse `ignoreFlowItem`. Returns the row to bindState="unbound"
 * so it shows up in Unmatched again. notes cleared.
 */
export async function unignoreFlowItem(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const flowItemId = String(formData.get("flowItemId") || "");
  const batchId = String(formData.get("batchId") || "");

  const scope = await _resolveFlowItemInBatch({ flowItemId, batchId });
  if (!scope.ok) return scope;

  await db.flowItem.update({
    where: { id: flowItemId },
    data: { bindState: "unbound", productId: null, notes: null },
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: "Un-ignored." };
}

/**
 * Direct bindState setter — escape hatch for tests + admin tooling.
 * The four specific actions above are the preferred API; this
 * exists so a future bulk-action UI can change many rows at once
 * without re-implementing the workspace-scope check each time.
 */
export async function setFlowItemBindState(
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
  const flowItemId = String(formData.get("flowItemId") || "");
  const batchId = String(formData.get("batchId") || "");
  const stateRaw = String(formData.get("state") || "");
  const productId = String(formData.get("productId") || "");
  if (!FLOW_ITEM_BIND_STATES.has(stateRaw as "unbound" | "bound" | "ignored" | "auto")) {
    return { ok: false, message: `Invalid state: ${stateRaw}` };
  }

  const scope = await _resolveFlowItemInBatch({ flowItemId, batchId });
  if (!scope.ok) return scope;

  await db.flowItem.update({
    where: { id: flowItemId },
    data: {
      bindState: stateRaw,
      productId: stateRaw === "bound" || stateRaw === "auto" ? productId || null : null,
    },
  });

  revalidatePath(`/batches/${batchId}`);
  return { ok: true, message: `State set to ${stateRaw}.` };
}

// ---------------------------------------------------------------------
// Per-product image generation
// ---------------------------------------------------------------------
//
// Fires a single-item `generate_flow_images` job for one product so the
// user can re-run / kick off gen from inside an expanded product card
// without opening the bulk Generate Images sheet. Reuses createSampleJob
// so the workspace's cooldown + daily-cap gates apply identically to
// bulk dispatches — there's no "back door" past the anti-block
// protections.
//
// Picks the agent automatically:
//   - prefer the single connected agent if there's exactly one
//   - otherwise return an error pointing the user at the bulk panel
//     (where they can pick an agent explicitly)
//
// Returns the same shape as createSampleJob so the caller can use it
// directly in a useTransition + router.refresh pattern.

import { createSampleJob } from "@/app/jobs/actions";

export async function generateImagesForOneProduct(input: {
  batchId: string;
  productId: string;
  /** When true, skip the workspace cooldown check at dispatch.
   *  Daily cap still applies. Used by the "Generate anyway"
   *  button so an operator who knows the account is healthy can
   *  push a single product through without waiting out the full
   *  cooldown window. */
  bypassCooldown?: boolean;
}): Promise<{ ok: boolean; jobId: string; message: string }> {
  const { workspace } = await getCurrentWorkspace();

  const batch = await db.batch.findFirst({
    where: { id: input.batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) {
    return { ok: false, jobId: "", message: "Batch not found." };
  }

  const product = await db.product.findFirst({
    where: {
      id: input.productId,
      batchId: batch.id,
      deletedAt: null,
    },
    select: {
      id: true,
      productName: true,
      imagePrompt: true,
      referenceImageUrl: true,
      referenceImagePathLocal: true,
      images: {
        where: { role: { in: ["primary", "ref2", "ref3"] } },
        orderBy: { role: "asc" },
        select: { role: true, url: true, pathLocal: true },
      },
    },
  });
  if (!product) {
    return { ok: false, jobId: "", message: "Product not found." };
  }

  // Eligibility — mirror the bulk panel's checks so the failure
  // mode is identical regardless of entry point.
  if (!product.imagePrompt || !product.imagePrompt.trim()) {
    return {
      ok: false,
      jobId: "",
      message:
        "Product has no image prompt yet — run AI Prompt Generation first " +
        "(Needs Review lane → Generate AI prompts).",
    };
  }
  const hasRef =
    !!product.referenceImageUrl ||
    !!product.referenceImagePathLocal ||
    product.images.some((img) => img.url || img.pathLocal);
  if (!hasRef) {
    return {
      ok: false,
      jobId: "",
      message:
        "Product has no reference image. Add one to the card and try again.",
    };
  }

  // Pick the agent.
  //
  // Canonical agent status values in this codebase: "online" |
  // "offline" | "unknown" (Phase 9 added "unknown" for never-pinged
  // agents). The dashboard + agents page both filter on
  // status === "online". An earlier version of this action filtered
  // on status === "connected" — that string is NEVER actually set
  // anywhere, so the query returned an empty set even when the
  // runner was clearly online and the user got a false-negative
  // "No connected runner" refusal.
  //
  // New policy: prefer agents with status "online", but fall back
  // to any registered agent when only one exists in the workspace.
  // Reason: status flips between "online" and "offline" based on
  // the last /events ping; a runner that's been quiet for a few
  // minutes can read as "offline" even when its process is still
  // up. The actual dispatch network call surfaces real failures
  // clearly enough — we don't need to pre-refuse based on a stale
  // status field.
  const allAgents = await db.agent.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, name: true, status: true },
  });
  const onlineAgents = allAgents.filter((a) => a.status === "online");

  let agentId: string;
  if (onlineAgents.length === 1) {
    agentId = onlineAgents[0].id;
  } else if (onlineAgents.length > 1) {
    return {
      ok: false,
      jobId: "",
      message:
        "Multiple runners online — use the bulk Generate images panel " +
        "to pick which one handles this product.",
    };
  } else if (allAgents.length === 1) {
    // No "online" runners, but exactly one registered. Try it
    // anyway — its status field may just be stale.
    agentId = allAgents[0].id;
  } else if (allAgents.length === 0) {
    return {
      ok: false,
      jobId: "",
      message:
        "No runner registered for this workspace. Set one up via the " +
        "Runner page, then try again.",
    };
  } else {
    // Multiple agents but none marked online. Refuse — too
    // ambiguous to pick automatically.
    return {
      ok: false,
      jobId: "",
      message:
        `${allAgents.length} runners registered but none currently marked online. ` +
        "Use the bulk Generate images panel to pick which one to dispatch to.",
    };
  }

  // Build the item payload — mirrors GenerateImagesPanel.submit's
  // per-item shape exactly so the runner sees an identical envelope
  // for bulk and single dispatches.
  const refs = product.images
    .filter((img) => img.url || img.pathLocal)
    .slice(0, 3);
  const refCount = refs.length;

  // Multi-reference preamble (PART 9 of v0.7 roadmap) only applied
  // when there's more than one reference. Kept byte-identical with
  // the bulk panel's wording so the AI behaviour is consistent.
  let finalPrompt = product.imagePrompt;
  if (refCount > 1) {
    finalPrompt =
      "Use all provided reference images together to understand " +
      "the same product. Treat them as different views or details " +
      "of one product, not separate products. Combine the " +
      "consistent product design, packaging, color, shape, and " +
      "visible branding into one realistic product display. Do " +
      "not create a collage. Do not show multiple variants unless " +
      "the product is naturally sold as a set.\n\n" + finalPrompt;
  }

  const item: Record<string, unknown> = {
    item_id:      product.id,
    product_name: product.productName,
    image_prompt: finalPrompt,
  };
  if (product.referenceImageUrl) {
    item.reference_image_url = toAgentAssetUrl(product.referenceImageUrl);
  }
  if (product.referenceImagePathLocal) {
    item.reference_image_path = product.referenceImagePathLocal;
  }
  if (refCount > 0) {
    item.reference_images = refs.map((img) => ({
      role: img.role,
      url:  img.url ? toAgentAssetUrl(img.url) : null,
      path: img.pathLocal,
    }));
  }

  return await createSampleJob({
    jobType: "generate_flow_images",
    agentId,
    batchId: input.batchId,
    payload: {
      items:           [item],
      limit:           1,
      wait_mode:       "submit_only",
      automation_mode: "family_plan",
    },
    bypassCooldown: input.bypassCooldown === true,
  });
}
