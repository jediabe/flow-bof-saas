"use server";

import { Buffer } from "node:buffer";
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
      // Critical: only set referenceImageUrl AFTER a successful
      // download. A failed download leaves the column null so the
      // UI can render a clean placeholder instead of a broken
      // <img src=…> pointing at a file that never existed.
      await db.product.update({
        where: { id: product.id },
        data: { referenceImageUrl: dl.relUrl },
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
}): Promise<AiBulkReport> {
  const { batchId, mode } = input;
  if (!batchId) {
    return emptyAiReport("missing batchId");
  }

  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!batch) return emptyAiReport("batch not found");

  const settingsRow = await loadOrCreateSettings(workspace.id);
  const settings = toServerSettings(settingsRow);

  const products = await db.product.findMany({
    where: { batchId: batch.id },
    select: {
      id: true,
      productName: true,
      originalTitle: true,
      category: true,
      retailerName: true,
      tiktokUrl: true,
      referenceImageUrl: true,
      imagePrompt: true,
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

    try {
      const { output } = await callProvider(
        {
          productName:       p.productName,
          originalTitle:     p.originalTitle,
          category:          p.category,
          retailerName:      p.retailerName,
          tiktokUrl:         p.tiktokUrl,
          referenceImageUrl: p.referenceImageUrl,
        },
        settings,
      );
      await db.product.update({
        where: { id: p.id },
        data: {
          imagePrompt:         output.imagePrompt,
          retailerName:        output.retailerName,
          hook:                output.hook ?? null,
          caption:             output.caption ?? null,
          hashtags:            output.hashtags
            ? encodeJson(output.hashtags)
            : null,
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
