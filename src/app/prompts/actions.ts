"use server";

import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { callProvider } from "@/lib/ai/providers";
import {
  loadOrCreateSettings,
  toServerSettings,
} from "@/lib/workspace-settings";
import type { AiPromptOutput } from "@/lib/ai/types";
import {
  importKalodataXlsx,
  getOrCreateBatchReviewToken,
  generateAiPromptForProduct,
  type KalodataImportReport,
} from "@/app/batches/actions";

/**
 * /prompts — live one-shot generation for a chosen Product.
 *
 * The batches flow persists the AI output to the Product row so
 * the pipeline downstream (image gen, mobile posting review) can
 * read a stable state. This surface is different: it's a hooks +
 * caption preview surface for a UK creator who wants a fresh
 * batch of hooks NOW (possibly flavoured with today's live
 * discount %), copies them to their clipboard, posts, and moves
 * on. We deliberately do NOT persist — discount % is time-
 * sensitive, and overwriting the batch row's hooks with a run
 * tied to a temporary discount would be confusing later.
 *
 * If the operator wants to persist, they can go back to the
 * batch flow. This surface stays a preview.
 */

export interface GeneratePromptsPreviewInput {
  productId: string;
  /** Optional TikTok Shop discount %. Integer 1..100 or null. */
  discountPercent: number | null;
}

export interface GeneratePromptsPreviewResult {
  ok: boolean;
  message: string;
  provider: string;
  output?: AiPromptOutput;
}

export async function generatePromptsPreview(
  input: GeneratePromptsPreviewInput,
): Promise<GeneratePromptsPreviewResult> {
  const { productId, discountPercent } = input;
  if (!productId) {
    return { ok: false, message: "Pick a product first.", provider: "" };
  }
  // Sanitize the percent — trust nothing from the client. Any
  // out-of-range value is coerced to null so the LLM sees no
  // discount and skips the %-dependent variants.
  const pct =
    typeof discountPercent === "number" &&
    Number.isFinite(discountPercent) &&
    discountPercent > 0 &&
    discountPercent <= 100
      ? Math.round(discountPercent)
      : null;

  const { workspace } = await getCurrentWorkspace();

  const product = await db.product.findFirst({
    where: {
      id: productId,
      deletedAt: null,
      batch: { workspaceId: workspace.id },
    },
    select: {
      id: true,
      productName: true,
      originalTitle: true,
      category: true,
      retailerName: true,
      tiktokUrl: true,
      referenceImageUrl: true,
      market: true,
      batch: { select: { market: true } },
    },
  });
  if (!product) {
    return {
      ok: false,
      message: "Product not found in this workspace.",
      provider: "",
    };
  }

  // Per-product market wins, then batch market, then UK.
  const effectiveMarket: "uk" | "us" =
    product.market === "us"
      ? "us"
      : product.market === "uk"
        ? "uk"
        : product.batch?.market === "us"
          ? "us"
          : "uk";

  const settingsRow = await loadOrCreateSettings(workspace.id);
  const settings = toServerSettings(settingsRow);

  try {
    const { output } = await callProvider(
      {
        productName:       product.productName,
        originalTitle:     product.originalTitle,
        category:          product.category,
        retailerName:      product.retailerName,
        tiktokUrl:         product.tiktokUrl,
        referenceImageUrl: product.referenceImageUrl,
        market:            effectiveMarket,
        discountPercent:   pct,
      },
      settings,
      { useVision: false },
    );
    return {
      ok: true,
      message: "Generated.",
      provider: settings.provider,
      output,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      message: `${e.name}: ${String(e.message ?? e).slice(0, 240)}`,
      provider: settings.provider,
    };
  }
}

// ---------------------------------------------------------------------
// Kalodata import from /prompts
// ---------------------------------------------------------------------
//
// One-shot: upload a Kalodata .xlsx → new Batch is created →
// products imported (same code path as /batches) → mobile-review
// token is minted → we return { batchId, reviewToken, reviewUrl }
// so the /prompts UI can display a QR code pointing the reviewer's
// phone at /mobile-review/<token>.
//
// From there the reviewer swipes through, types a discount % per
// product (optional), taps Approve, and Next 15's `after()` hook
// on the mobile side fires the APEX hook + image prompt generator
// against each approved product. By the time they're back on
// desktop the Product rows have hookVariants / caption / hashtags
// / imagePrompt populated.
//
// Format is server-only (needs the file bytes and DB write access);
// the /prompts UI just POSTs a FormData with a "file" field and
// (optionally) a "batchName" override.

export interface ImportKalodataToPromptsResult {
  ok: boolean;
  message: string;
  /** Present when import succeeded or partially succeeded. */
  batchId?: string;
  reviewToken?: string;
  reviewUrl?: string;
  /** PNG data URL of a QR encoding reviewUrl. Client renders inline
   *  as <img>. Undefined when the import failed before the token
   *  was minted. */
  qrDataUrl?: string;
  report?: KalodataImportReport;
}

export async function importKalodataForPrompts(
  formData: FormData,
): Promise<ImportKalodataToPromptsResult> {
  const file = formData.get("file") as File | null;
  if (!file || !file.name) {
    return { ok: false, message: "Pick an XLSX file first." };
  }

  const { workspace } = await getCurrentWorkspace();

  // Batch name: use whatever the user typed, or fall back to
  // "Kalodata · <YYYY-MM-DD>" which is unique enough for a daily
  // export workflow and immediately readable in the batch list.
  const nameOverride = String(formData.get("batchName") || "").trim();
  const today = new Date();
  const dateSlug = `${today.getUTCFullYear()}-${String(
    today.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  const batchName = nameOverride || `Kalodata · ${dateSlug}`;

  // Create the batch — always UK for now (APEX curriculum is UK).
  // Follow-up work can accept a market param when we ship US.
  const batch = await db.batch.create({
    data: {
      workspaceId: workspace.id,
      name: batchName,
      market: "uk",
    },
    select: { id: true },
  });

  // Reuse the existing Kalodata import action verbatim. Same parse,
  // same image-download-and-save, same failure reporting.
  const forwarded = new FormData();
  forwarded.set("batchId", batch.id);
  forwarded.set("file", file);
  const report = await importKalodataXlsx(forwarded);
  if (!report.ok) {
    // Import failed at the workbook level — drop the empty batch
    // we just created so the batches list doesn't fill with
    // half-created shells. Products created before the failure
    // stay attached in a partial-success case (report.ok false but
    // productsCreated > 0), so only delete when nothing landed.
    if (report.productsCreated === 0) {
      await db.batch.delete({ where: { id: batch.id } });
      return { ok: false, message: report.message };
    }
    // Partial: keep the batch, surface the message; caller can
    // decide whether to proceed.
  }

  // Mint the review token so the /prompts UI can render a QR code
  // that points the reviewer's phone at /mobile-review/<token>.
  const tokenResp = await getOrCreateBatchReviewToken(batch.id);
  if (!tokenResp.ok || !tokenResp.token) {
    // Batch is real and has products — leaking the batch and
    // pointing the user at /batches is a reasonable fallback.
    return {
      ok: false,
      message: `Imported ${report.productsCreated} products but could not mint a review link: ${tokenResp.message ?? "unknown error"}. Open the batch from /batches to review.`,
      batchId: batch.id,
      report,
    };
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  const reviewUrl = appUrl
    ? `${appUrl.replace(/\/$/, "")}/mobile-review/${tokenResp.token}`
    : `/mobile-review/${tokenResp.token}`;

  // Render the QR server-side. `qrcode` returns a data: URL that
  // the client can drop into an <img src>. Kept at 256px so it
  // looks crisp on desktop but still scales down cleanly on
  // mobile without ballooning the payload.
  let qrDataUrl: string | undefined;
  try {
    qrDataUrl = await QRCode.toDataURL(reviewUrl, {
      width: 256,
      margin: 1,
      color: { dark: "#0A1220", light: "#FFFFFF" },
    });
  } catch (err) {
    // Non-fatal — reviewer can still copy the URL and paste it on
    // their phone. Log the failure for visibility.
    console.error("[prompts] QR render failed:", err);
  }

  revalidatePath("/prompts");
  revalidatePath("/batches");
  revalidatePath("/dashboard");

  return {
    ok: true,
    message: `Imported ${report.productsCreated} products.${report.imagesFailed > 0 ? ` ${report.imagesFailed} image download(s) failed.` : ""}`,
    batchId: batch.id,
    reviewToken: tokenResp.token,
    reviewUrl,
    qrDataUrl,
    report,
  };
}

/**
 * Poll helper for the /prompts UI. Given a batchId returned by
 * importKalodataForPrompts, return the current review + generation
 * status of every product in the batch. The UI can poll this
 * every few seconds while the mobile reviewer swipes through, so
 * the desktop-side product list stays up to date without a page
 * reload.
 *
 * Workspace-scoped so a stolen batchId still can't leak cross-
 * tenant data.
 */
export interface BatchReviewProgress {
  ok: boolean;
  message?: string;
  products?: Array<{
    id: string;
    productName: string;
    reviewStatus: string;
    discountPercent: number | null;
    hasPrompt: boolean;
  }>;
}

/**
 * Manual "Regenerate for approved products" — the safety net if
 * the mobile-side `after()` auto-generation didn't fire (silent
 * failure, cold start on a serverless boundary, or the operator
 * changed the discount % after approval). Iterates every approved
 * product in the batch and runs the prompt generator with the
 * currently-persisted discountPercent on each row.
 *
 * Sequential so we don't concurrently hammer the LLM provider from
 * one workspace. Non-approved products are skipped. Returns a
 * summary the UI can render as a toast.
 */
export interface RegenerateApprovedResult {
  ok: boolean;
  message: string;
  attempted: number;
  succeeded: number;
  failed: number;
}

export async function regenerateApprovedInBatch(
  batchId: string,
): Promise<RegenerateApprovedResult> {
  if (!batchId) {
    return {
      ok: false,
      message: "missing batchId",
      attempted: 0,
      succeeded: 0,
      failed: 0,
    };
  }
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: {
      id: true,
      products: {
        where: {
          deletedAt: null,
          reviewStatus: "approved",
        },
        select: { id: true },
      },
    },
  });
  if (!batch) {
    return {
      ok: false,
      message: "batch not found",
      attempted: 0,
      succeeded: 0,
      failed: 0,
    };
  }
  const approved = batch.products;
  if (approved.length === 0) {
    return {
      ok: false,
      message: "No approved products to regenerate.",
      attempted: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  let succeeded = 0;
  let failed = 0;
  for (const p of approved) {
    try {
      const r = await generateAiPromptForProduct({
        batchId: batch.id,
        productId: p.id,
        force: true,
      });
      if (r.ok) {
        succeeded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  revalidatePath("/prompts");
  return {
    ok: succeeded > 0,
    message:
      succeeded === approved.length
        ? `Regenerated ${succeeded} product${succeeded === 1 ? "" : "s"}.`
        : `${succeeded}/${approved.length} regenerated · ${failed} failed.`,
    attempted: approved.length,
    succeeded,
    failed,
  };
}

/**
 * Return the actual generated hook + prompt content for every
 * approved product in a batch that has hooks ready. Powers the
 * "Auto-generated hooks" section on /prompts — the missing piece
 * that surfaces post-approve output on the desktop side instead
 * of leaving the operator to hunt through /batches/[id] for it.
 *
 * Includes rejected + maybe products would be noise; we only
 * return `approved` because that's what the reviewer said they
 * wanted content for.
 */
export interface ApprovedHooksProduct {
  id: string;
  productName: string;
  discountPercent: number | null;
  imagePrompt: string | null;
  caption: string | null;
  hashtags: string[];
  hook: string | null;
  hookVariants: Array<{ label: string; text: string }>;
  aiPromptGeneratedAt: string | null;
  aiPromptError: string | null;
}

export interface ApprovedHooksResult {
  ok: boolean;
  message?: string;
  products?: ApprovedHooksProduct[];
}

export async function getApprovedHooksForBatch(
  batchId: string,
): Promise<ApprovedHooksResult> {
  if (!batchId) return { ok: false, message: "missing batchId" };
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: {
      id: true,
      products: {
        where: {
          deletedAt: null,
          reviewStatus: "approved",
        },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          productName: true,
          discountPercent: true,
          imagePrompt: true,
          caption: true,
          hashtags: true,
          hook: true,
          hookVariants: true,
          aiPromptGeneratedAt: true,
          aiPromptError: true,
        },
      },
    },
  });
  if (!batch) return { ok: false, message: "batch not found" };

  const products: ApprovedHooksProduct[] = batch.products.map((p) => {
    // hashtags is a JSON-encoded string[] on both engines (SQLite
    // has no array type; Postgres matches for schema parity).
    let hashtags: string[] = [];
    if (p.hashtags) {
      try {
        const decoded = JSON.parse(p.hashtags);
        if (Array.isArray(decoded)) {
          hashtags = decoded.filter((t) => typeof t === "string");
        }
      } catch {
        // ignore malformed
      }
    }
    // hookVariants is a JSON-encoded [{label, text, lever_name?}].
    let hookVariants: Array<{ label: string; text: string }> = [];
    if (p.hookVariants) {
      try {
        const decoded = JSON.parse(p.hookVariants);
        if (Array.isArray(decoded)) {
          for (const v of decoded) {
            if (
              v &&
              typeof v === "object" &&
              typeof (v as { label?: unknown }).label === "string" &&
              typeof (v as { text?: unknown }).text === "string"
            ) {
              hookVariants.push({
                label: (v as { label: string }).label,
                text: (v as { text: string }).text,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return {
      id: p.id,
      productName: p.productName,
      discountPercent: p.discountPercent ?? null,
      imagePrompt: p.imagePrompt ?? null,
      caption: p.caption ?? null,
      hashtags,
      hook: p.hook ?? null,
      hookVariants,
      aiPromptGeneratedAt: p.aiPromptGeneratedAt
        ? p.aiPromptGeneratedAt.toISOString()
        : null,
      aiPromptError: p.aiPromptError ?? null,
    };
  });

  return { ok: true, products };
}

export async function getBatchReviewProgress(
  batchId: string,
): Promise<BatchReviewProgress> {
  if (!batchId) return { ok: false, message: "missing batchId" };
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: {
      id: true,
      products: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          productName: true,
          reviewStatus: true,
          discountPercent: true,
          aiPromptGeneratedAt: true,
        },
      },
    },
  });
  if (!batch) return { ok: false, message: "batch not found" };
  return {
    ok: true,
    products: batch.products.map((p) => ({
      id: p.id,
      productName: p.productName,
      reviewStatus: p.reviewStatus,
      discountPercent: p.discountPercent ?? null,
      hasPrompt: p.aiPromptGeneratedAt != null,
    })),
  };
}
