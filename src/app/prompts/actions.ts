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
  getOrCreateBatchPostingToken,
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
  queued: number;
}

/**
 * Queue every approved product in a batch for hook regeneration.
 *
 * Returns immediately after DB validation — the actual N sequential
 * LLM calls run fire-and-forget in the background. This is REQUIRED
 * because awaiting them synchronously in a server action puts the
 * request on the wrong side of Cloudflare's 100s origin timeout
 * (a 7-product batch at ~10s/product is already 70s). The client
 * polls getBatchPromptsState every 4s, so hooks appear card-by-card
 * as they land — same live-updating UX, without the 524.
 *
 * Long-lived Node.js container (Docker Compose, not serverless) so
 * the unawaited Promise reliably keeps running past the response
 * flush.
 */
export async function regenerateApprovedInBatch(
  batchId: string,
): Promise<RegenerateApprovedResult> {
  if (!batchId) {
    return { ok: false, message: "missing batchId", queued: 0 };
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
    return { ok: false, message: "batch not found", queued: 0 };
  }
  const approved = batch.products;
  if (approved.length === 0) {
    return {
      ok: false,
      message: "No approved products to regenerate.",
      queued: 0,
    };
  }

  const bgBatchId = batch.id;
  const bgIds = approved.map((p) => p.id);
  console.log(
    `[regen] queueing ${bgIds.length} product(s) for regeneration in batch=${bgBatchId}`,
  );

  // Fire-and-forget the sequential regeneration. We deliberately
  // stay sequential (not Promise.all) so TikHub / OpenAI /
  // Anthropic / OpenRouter don't get slammed with N concurrent
  // requests from one workspace — the same courtesy the cron
  // account-iteration uses.
  Promise.resolve().then(async () => {
    let ok = 0;
    let fail = 0;
    for (const productId of bgIds) {
      try {
        const r = await generateAiPromptForProduct({
          batchId: bgBatchId,
          productId,
          force: true,
        });
        if (r.ok) ok++;
        else {
          fail++;
          console.error(
            `[regen] not-ok product=${productId}: ${r.message}`,
          );
        }
      } catch (err) {
        fail++;
        console.error(`[regen] threw product=${productId}:`, err);
      }
    }
    console.log(
      `[regen] batch=${bgBatchId} finished: ${ok}/${bgIds.length} OK, ${fail} failed`,
    );
  });

  // Return immediately so the button responds in <1s and Cloudflare
  // never sees a long-running request. Client polling picks up the
  // hooks as they land per-product.
  return {
    ok: true,
    message: `Queued ${approved.length} product${approved.length === 1 ? "" : "s"} — hooks will appear as they generate.`,
    queued: approved.length,
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

// ---------------------------------------------------------------------
// Unified batch state — powers the redesigned /prompts hub
// ---------------------------------------------------------------------
//
// One fetch call returns everything the /prompts UI needs about the
// currently-active batch: header info + review QR + posting QR +
// full product list with review status, discount %, image, and
// generated hooks.
//
// The client polls this at a modest cadence; server work is a
// single findFirst with nested selects.

export interface BatchPromptsProduct {
  id: string;
  productName: string;
  referenceImageUrl: string | null;
  imageUrl: string | null;
  category: string | null;
  reviewStatus: string;
  discountPercent: number | null;
  imagePrompt: string | null;
  caption: string | null;
  hashtags: string[];
  hook: string | null;
  hookVariants: Array<{ label: string; text: string }>;
  aiPromptGeneratedAt: string | null;
  aiPromptError: string | null;
  /** Style 1 full video kit JSON string (parsed via parseStyle1Kit
   *  on the client). Null when generation hasn't run under the
   *  Style 1 prompt yet (legacy 7-family products). */
  style1Kit: string | null;
  /** Operator's picked option per copy part, set on the mobile
   *  posting page. null when they haven't picked yet. */
  chosenCopyPart1: string | null;
  chosenCopyPart2: string | null;
  chosenCopyPart3: string | null;
}

export interface BatchPromptsCounts {
  total: number;
  needs_review: number;
  approved: number;
  rejected: number;
  maybe: number;
  hasHooks: number;
}

export interface BatchPromptsState {
  ok: boolean;
  message?: string;
  batchId?: string;
  batchName?: string;
  createdAt?: string;
  reviewUrl?: string;
  reviewQrDataUrl?: string;
  postingUrl?: string;
  postingQrDataUrl?: string;
  products?: BatchPromptsProduct[];
  counts?: BatchPromptsCounts;
}

/** Absolute base URL for QR-encoded links. Falls back to a
 *  relative "/" if NEXT_PUBLIC_APP_URL isn't set — QRs won't work
 *  when scanned but at least the URLs display on desktop. */
function appBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
}

async function renderQr(fullUrl: string): Promise<string | undefined> {
  try {
    return await QRCode.toDataURL(fullUrl, {
      width: 240,
      margin: 1,
      color: { dark: "#0A1020", light: "#FFFFFF" },
    });
  } catch (err) {
    console.error("[prompts] QR render failed:", err);
    return undefined;
  }
}

export async function getBatchPromptsState(
  batchId: string,
): Promise<BatchPromptsState> {
  if (!batchId) return { ok: false, message: "missing batchId" };
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id: batchId, workspaceId: workspace.id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      products: {
        where: { deletedAt: null },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          productName: true,
          referenceImageUrl: true,
          imageUrl: true,
          category: true,
          reviewStatus: true,
          discountPercent: true,
          imagePrompt: true,
          caption: true,
          hashtags: true,
          hook: true,
          hookVariants: true,
          aiPromptGeneratedAt: true,
          aiPromptError: true,
          style1Kit: true,
          chosenCopyPart1: true,
          chosenCopyPart2: true,
          chosenCopyPart3: true,
        },
      },
    },
  });
  if (!batch) return { ok: false, message: "batch not found" };

  const products: BatchPromptsProduct[] = batch.products.map((p) => {
    let hashtags: string[] = [];
    if (p.hashtags) {
      try {
        const decoded = JSON.parse(p.hashtags);
        if (Array.isArray(decoded)) {
          hashtags = decoded.filter((t) => typeof t === "string");
        }
      } catch {
        // malformed JSON — surface no hashtags
      }
    }
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
      referenceImageUrl: p.referenceImageUrl,
      imageUrl: p.imageUrl,
      category: p.category,
      reviewStatus: p.reviewStatus,
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
      style1Kit: p.style1Kit ?? null,
      chosenCopyPart1: p.chosenCopyPart1 ?? null,
      chosenCopyPart2: p.chosenCopyPart2 ?? null,
      chosenCopyPart3: p.chosenCopyPart3 ?? null,
    };
  });

  const counts: BatchPromptsCounts = {
    total: products.length,
    needs_review: 0,
    approved: 0,
    rejected: 0,
    maybe: 0,
    hasHooks: 0,
  };
  for (const p of products) {
    if (p.reviewStatus in counts) {
      (counts as unknown as Record<string, number>)[p.reviewStatus]++;
    }
    // A product is "ready" (counts toward hasHooks) when either the
    // Style 1 kit is populated OR the legacy hook fields are — both
    // shapes mean generation succeeded and the mobile-posting page
    // has something to render.
    if (p.style1Kit || p.hookVariants.length > 0 || p.hook) {
      counts.hasHooks++;
    }
  }

  // Mint / retrieve both tokens. Failures are non-fatal — the UI
  // still renders product cards; QR panels just won't appear.
  const [reviewTokenResp, postingTokenResp] = await Promise.all([
    getOrCreateBatchReviewToken(batch.id),
    getOrCreateBatchPostingToken(batch.id),
  ]);

  const base = appBaseUrl();
  let reviewUrl: string | undefined;
  let reviewQrDataUrl: string | undefined;
  if (reviewTokenResp.ok && reviewTokenResp.token) {
    reviewUrl = base
      ? `${base}/mobile-review/${reviewTokenResp.token}`
      : `/mobile-review/${reviewTokenResp.token}`;
    reviewQrDataUrl = await renderQr(reviewUrl);
  }
  let postingUrl: string | undefined;
  let postingQrDataUrl: string | undefined;
  if (postingTokenResp.ok && postingTokenResp.token) {
    postingUrl = base
      ? `${base}/mobile-posting/${postingTokenResp.token}`
      : `/mobile-posting/${postingTokenResp.token}`;
    // Only bother rendering the posting QR if there's actually
    // something to post — approved + hooks-ready.
    if (counts.hasHooks > 0) {
      postingQrDataUrl = await renderQr(postingUrl);
    }
  }

  return {
    ok: true,
    batchId: batch.id,
    batchName: batch.name,
    createdAt: batch.createdAt.toISOString(),
    reviewUrl,
    reviewQrDataUrl,
    postingUrl,
    postingQrDataUrl,
    products,
    counts,
  };
}

/** Recent Kalodata batches in the workspace — for the "resume"
 *  chip when a user visits /prompts without a ?batch param. */
export interface RecentBatchSummary {
  id: string;
  name: string;
  createdAt: string;
  productCount: number;
}

export async function listRecentPromptBatches(
  limit = 5,
): Promise<RecentBatchSummary[]> {
  const { workspace } = await getCurrentWorkspace();
  const batches = await db.batch.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ createdAt: "desc" }],
    take: Math.max(1, Math.min(limit, 20)),
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { products: true } },
    },
  });
  return batches.map((b) => ({
    id: b.id,
    name: b.name,
    createdAt: b.createdAt.toISOString(),
    productCount: b._count.products,
  }));
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
