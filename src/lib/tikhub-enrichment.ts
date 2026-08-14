/**
 * Kalodata-import auto-enrichment via TikHub.
 *
 * Runs SYNCHRONOUSLY as part of the Kalodata import — the operator
 * hits Upload and lands on a fully-populated /prompts a couple of
 * seconds later, with discount %, discount type, source images,
 * and source description already on every product row.
 *
 * Concurrency-capped parallel loop: up to CONCURRENCY products
 * enriching at once so a 30-row Kalodata sheet finishes in ~10s
 * instead of 30+ sequential seconds. Individual TikHub failures
 * never roll back the Product row; we just leave the enrichment
 * fields empty so the operator falls back to manual entry.
 */

import { db } from "@/lib/db";
import {
  extractTikTokProductId,
  getShopProductDetailEnriched,
} from "@/lib/tikhub";
import { downloadProductImage } from "@/lib/kalodata";
import { upsertProductImage } from "@/lib/product-images";

/** How many TikHub calls to run in parallel. Empirically 5 gives
 *  ~5x speedup without tripping rate limits on a typical
 *  workspace's TIKHUB_API_KEY tier. Lower if we start seeing 429s. */
const CONCURRENCY = 5;

export interface EnrichmentReport {
  attempted: number;
  succeeded: number;
  failedNoProductId: number;
  failedApi: number;
  /** Products where TikHub's fetch_product_detail_v3 returned
   *  exists=false — the product isn't in the queried catalog.
   *  Almost always a region mismatch (batch is UK, product
   *  actually lives in the US shop) OR the product has been
   *  delisted from TikTok Shop since Kalodata exported it. */
  notFoundOnTikHub: number;
  updated: number;
}

/** Map internal batch market ("uk" | "us") to TikHub's region
 *  code ("GB" | "US"). Defaults to GB for anything unknown to
 *  match the rest of the codebase. */
function batchMarketToRegion(market: string | null | undefined): string {
  const m = (market ?? "").toLowerCase();
  if (m === "us") return "US";
  return "GB";
}

/** Is this product name empty or a placeholder we set at import
 *  time (paste-URL flow) that we should overwrite with the real
 *  title once enrichment gets one?
 *
 *  Kalodata imports always land with a real productName so this
 *  returns false and TikHub-supplied names never clobber the
 *  cleaner Kalodata versions. Paste-URL imports land with the
 *  "Pasted URL — <productId>" or empty pattern below and get
 *  the TikHub name written on top.
 */
function isPlaceholderName(name: string | null | undefined): boolean {
  const s = (name ?? "").trim();
  if (!s) return true;
  if (/^Pasted URL —\s*\d+/i.test(s)) return true;
  if (/^Loading —\s*\d+/i.test(s)) return true;
  if (/^Product #\d+/i.test(s)) return true;
  return false;
}

/**
 * Enrich a single Product row via TikHub. Reads the row's
 * tiktokUrl + referenceImageUrl, hits TikHub for detail, updates
 * the row with anything TikHub returned that isn't already set on
 * the row.
 *
 * Never overwrites operator-provided data: if the row already has
 * a discountPercent (e.g. an operator has already reviewed it),
 * we leave that untouched. Same for discountType.
 *
 * Also populates the source-* fields (sourceImages,
 * sourceDescription) which are pure reference data — the operator
 * copies image URLs into Google Flow and reads the description
 * for context.
 *
 * Returns which branch was taken so the batch loop can aggregate.
 */
export async function enrichProductFromTikHub(input: {
  productId: string;
  workspaceId: string;
  batchId: string;
  /** TikHub region code ("GB" | "US"). Derived from batch.market
   *  by the batch-level caller. Individual callers can pass it
   *  directly. Defaults to GB. */
  region?: string;
}): Promise<
  "no-product-id" | "api-failed" | "not-found" | "updated" | "no-op"
> {
  const row = await db.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: {
      id: true,
      tiktokUrl: true,
      discountPercent: true,
      discountType: true,
      referenceImageUrl: true,
      productName: true,
      originalTitle: true,
    },
  });
  if (!row) return "no-op";

  const productIdOnTikTok = extractTikTokProductId(row.tiktokUrl);
  if (!productIdOnTikTok) {
    await recordAttempt(
      row.id,
      row.tiktokUrl
        ? `No TikTok Shop product ID found in URL "${row.tiktokUrl.slice(0, 80)}"`
        : "No TikTok Shop URL on this row",
    );
    return "no-product-id";
  }

  const primaryRegion = input.region ?? "GB";
  // TikHub product-detail lookups are region-scoped. If a product
  // isn't sold in the batch's region — or TikHub's own upstream
  // is refusing that product+region combo with the generic
  // "Request failed. Please retry. ... You won't be charged"
  // message (their polite "can't process this" that our retry
  // loop can't work around) — fall back to the OTHER region and
  // try once. Most products sold on TT Shop appear in both GB
  // and US catalogues, so this typically converts a
  // straight-up failure into a successful enrichment with the
  // right images + description.
  const fallbackRegion = primaryRegion === "GB" ? "US" : "GB";
  const attemptOrder: string[] = [primaryRegion, fallbackRegion];

  type AttemptOutcome =
    | { kind: "ok"; detail: NonNullable<Awaited<ReturnType<typeof getShopProductDetailEnriched>>> }
    | { kind: "api-failed"; error: string }
    | { kind: "not-found" };
  const attempts: Array<{ region: string; outcome: AttemptOutcome }> = [];

  for (const region of attemptOrder) {
    try {
      const detail = await getShopProductDetailEnriched(productIdOnTikTok, {
        region,
      });
      if (detail) {
        attempts.push({ region, outcome: { kind: "ok", detail } });
        break;
      }
      attempts.push({ region, outcome: { kind: "not-found" } });
    } catch (err) {
      const raw = (err as Error).message || "unknown error";
      console.error(
        `[tikhub-enrichment] fetch failed for product=${input.productId} tiktok_product=${productIdOnTikTok} region=${region}:`,
        err,
      );
      attempts.push({
        region,
        outcome: { kind: "api-failed", error: raw.slice(0, 180) },
      });
    }
  }

  const winner = attempts.find((a) => a.outcome.kind === "ok");
  const detail =
    winner && winner.outcome.kind === "ok" ? winner.outcome.detail : null;

  if (!detail) {
    // Every region failed. Report the primary region's failure
    // reason (that's what the operator picked), but include the
    // fallback's outcome in the note so the log line explains
    // why we didn't succeed.
    const primary = attempts[0]!;
    const fallback = attempts[1];
    const fallbackNote = fallback
      ? ` · fallback ${fallback.region}: ${fallback.outcome.kind}${fallback.outcome.kind === "api-failed" ? ` (${fallback.outcome.error.slice(0, 80)})` : ""}`
      : "";
    if (primary.outcome.kind === "api-failed") {
      await recordAttempt(
        row.id,
        `TikHub API error (region ${primary.region}): ${primary.outcome.error}${fallbackNote}`,
      );
      return "api-failed";
    }
    // not-found (primary and fallback both)
    await recordAttempt(
      row.id,
      `Not found in TikHub catalog (region ${primary.region}) — product may be delisted, or the batch region doesn't match this product's actual shop region. Product ID: ${productIdOnTikTok}${fallbackNote}`,
    );
    return "not-found";
  }

  // If the fallback region rescued us, log it so the operator
  // can see in docker logs which products came from a different
  // shop than the batch's market — useful for spotting patterns
  // (e.g. Kalodata sheet exported for UK but half the products
  // are US-only).
  if (winner!.region !== primaryRegion) {
    console.warn(
      `[tikhub-enrichment] product=${input.productId} tiktok_product=${productIdOnTikTok} rescued by fallback region ${winner!.region} (batch region ${primaryRegion} returned ${attempts[0]!.outcome.kind}).`,
    );
  }

  // Build the update payload. Source-* fields ALWAYS overwrite
  // (they're fresh TikHub data, not operator picks). Discount
  // fields ONLY overwrite when the row has no operator input yet.
  // Name field ONLY overwrites when the current name is empty or
  // matches a placeholder pattern (see isPlaceholderName) — this
  // is the mechanism paste-URL imports rely on to get real
  // product names populated after enrichment.
  const updateData: {
    discountPercent?: number | null;
    discountType?: string | null;
    sourceImages?: string | null;
    sourceDescription?: string | null;
    productName?: string;
    originalTitle?: string;
  } = {};
  if (row.discountPercent == null && detail.discountPercent != null) {
    updateData.discountPercent = detail.discountPercent;
  }
  if (!row.discountType && detail.discountType) {
    updateData.discountType = detail.discountType;
  }
  // ALWAYS overwrite source-* fields on every successful
  // enrichment, even when the new value is null / empty. Without
  // this, previously-stored stale data (raw JSON from the pre-fix
  // description parser, description-infographic dupes from before
  // the mirror-dedup fix, etc.) survived re-enrichment because
  // the old "only overwrite when truthy" check meant a null
  // extraction couldn't clear the field.
  updateData.sourceImages =
    detail.additionalImages.length > 0
      ? JSON.stringify(detail.additionalImages)
      : null;
  updateData.sourceDescription = detail.sourceDescription ?? null;
  if (detail.title && isPlaceholderName(row.productName)) {
    updateData.productName = detail.title;
    if (isPlaceholderName(row.originalTitle)) {
      updateData.originalTitle = detail.title;
    }
  }

  let didWrite = false;
  if (Object.keys(updateData).length > 0) {
    try {
      await db.product.update({
        where: { id: row.id },
        data:  updateData,
      });
      didWrite = true;
    } catch (err) {
      // Any of the new columns might be missing on an un-migrated
      // deployment. Fall back to updating just the fields we're
      // confident have existed for a while (discountPercent shipped
      // long before source-*).
      const msg = (err as Error).message || "";
      const looksLikeMissingColumn =
        msg.includes("discountType") ||
        msg.includes("sourceImages") ||
        msg.includes("sourceDescription") ||
        msg.includes("Unknown arg") ||
        msg.includes("no such column");
      if (looksLikeMissingColumn && updateData.discountPercent != null) {
        try {
          await db.product.update({
            where: { id: row.id },
            data:  { discountPercent: updateData.discountPercent },
          });
          didWrite = true;
        } catch (err2) {
          console.error(
            `[tikhub-enrichment] update fallback failed for product=${input.productId}:`,
            err2,
          );
        }
      } else {
        console.error(
          `[tikhub-enrichment] update failed for product=${input.productId}:`,
          err,
        );
      }
    }
  }

  // If TikHub returned a better image and we don't yet have a local
  // reference image (Kalodata's failed), download + attach it.
  // Skips silently on any failure.
  if (!row.referenceImageUrl && detail.imageUrlRemote) {
    try {
      const dl = await downloadProductImage({
        url: detail.imageUrlRemote,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        productId: row.id,
      });
      await upsertProductImage({
        productId: row.id,
        role: "primary",
        url: dl.relUrl,
        source: "kalodata",
      });
      didWrite = true;
    } catch (err) {
      console.warn(
        `[tikhub-enrichment] fallback image download failed for product=${input.productId}:`,
        err,
      );
    }
  }

  // Success — clear any prior enrichmentError, stamp the attempt.
  await recordAttempt(row.id, null);

  return didWrite ? "updated" : "no-op";
}

/** Update Product.enrichmentAttemptedAt + enrichmentError in one
 *  write. Pass null for the error to clear it on success; pass a
 *  human-readable string on failure. Failures here are swallowed
 *  (logged only) so that a missing column on an un-migrated
 *  deployment doesn't break the enrichment result the caller
 *  wanted to return. */
async function recordAttempt(
  productId: string,
  error: string | null,
): Promise<void> {
  try {
    await db.product.update({
      where: { id: productId },
      data: {
        enrichmentError:       error,
        enrichmentAttemptedAt: new Date(),
      },
    });
  } catch (err) {
    const msg = (err as Error).message || "";
    // Un-migrated deployment (schema hasn't been prisma-db-push'd
    // since the fields were added) — swallow silently.
    if (
      msg.includes("enrichmentError") ||
      msg.includes("enrichmentAttemptedAt") ||
      msg.includes("Unknown arg") ||
      msg.includes("no such column")
    ) {
      return;
    }
    console.warn(
      `[tikhub-enrichment] recordAttempt failed for product=${productId}:`,
      err,
    );
  }
}

/**
 * Enrich every product in a batch. Concurrency-capped parallel
 * loop — up to CONCURRENCY products enriching at once so a 30-row
 * sheet finishes in ~10s instead of 30+ sequential seconds.
 *
 * Called SYNCHRONOUSLY from importKalodataXlsx (awaited). The
 * import response includes the aggregate report so the caller can
 * message success/partial-success cleanly.
 */
export async function enrichBatchFromTikHub(input: {
  batchId: string;
  workspaceId: string;
}): Promise<EnrichmentReport> {
  // Fetch the batch's market so we send the right region to
  // TikHub. Without this, product-detail lookups against UK
  // products hit the default region and TikHub returns
  // exists=false — the #1 cause of "0/N updated" reports.
  const batch = await db.batch.findFirst({
    where: { id: input.batchId, workspaceId: input.workspaceId },
    select: { market: true },
  });
  const region = batchMarketToRegion(batch?.market);

  const rows = await db.product.findMany({
    where: { batchId: input.batchId, deletedAt: null },
    select: { id: true },
  });
  const report: EnrichmentReport = {
    attempted: rows.length,
    succeeded: 0,
    failedNoProductId: 0,
    failedApi: 0,
    notFoundOnTikHub: 0,
    updated: 0,
  };

  // Simple concurrency-limited queue: worker functions each pull
  // ids off a shared cursor until the queue is empty. Preserves
  // ordering only within a worker; overall order is best-effort.
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= rows.length) return;
      const r = rows[i];
      const result = await enrichProductFromTikHub({
        productId: r.id,
        workspaceId: input.workspaceId,
        batchId: input.batchId,
        region,
      });
      switch (result) {
        case "updated":
          report.succeeded += 1;
          report.updated += 1;
          break;
        case "no-op":
          report.succeeded += 1;
          break;
        case "no-product-id":
          report.failedNoProductId += 1;
          break;
        case "not-found":
          report.notFoundOnTikHub += 1;
          break;
        case "api-failed":
          report.failedApi += 1;
          break;
      }
    }
  }

  const workerCount = Math.min(CONCURRENCY, rows.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  console.log(
    `[tikhub-enrichment] batch=${input.batchId} region=${region} done: ${report.updated}/${report.attempted} updated · ${report.notFoundOnTikHub} not-found · ${report.failedApi} api-failed · ${report.failedNoProductId} missing product id`,
  );
  return report;
}

/**
 * Post-enrichment Style 1 auto-generation.
 *
 * The operator asked for discount percentages to be "populated
 * BEFORE approvals" — i.e. ready copy waiting on mobile review,
 * not empty placeholders that only get filled in after tap-to-
 * approve. This helper closes that gap.
 *
 * Walks every product in the batch with a discountPercent set,
 * checks whether its current style1Kit reflects that discount,
 * and fires generateAiPromptForProduct in the background for
 * anything mismatched. Idempotent — a product with a kit that
 * already contains the right discount is skipped.
 *
 * Kicks off a fire-and-forget loop so the caller (import or
 * re-enrich) can return quickly. Individual gen failures are
 * logged but don't abort the batch.
 *
 * The client sees kits appear as they finish. The existing
 * /prompts poll (or a page refresh) picks them up.
 *
 * Not-yet-implemented follow-up: mobile posting page needs a
 * discount % override input that re-fires this helper when the
 * operator notices the enriched value is stale. Right now the
 * only override paths are mobile-review (blocking approval) and
 * /prompts Regenerate button (batch-wide).
 */
export async function triggerStyle1GenerationIfDiscountReady(input: {
  batchId: string;
  workspaceId: string;
}): Promise<{ queued: number }> {
  const products = await db.product.findMany({
    where: {
      batchId: input.batchId,
      deletedAt: null,
      discountPercent: { not: null },
    },
    select: { id: true, style1Kit: true, discountPercent: true },
  });
  // Filter to products whose current kit doesn't reflect the
  // current discount value:
  //   - no kit at all → needs gen
  //   - kit exists but stored discount != current → needs regen
  //   - kit exists and matches → skip
  const needsGen = products.filter((p) => {
    if (!p.style1Kit) return true;
    try {
      const kit = JSON.parse(p.style1Kit) as { discountPercent?: number | null };
      return (kit.discountPercent ?? null) !== (p.discountPercent ?? null);
    } catch {
      // Malformed kit → safest to regen.
      return true;
    }
  });
  if (needsGen.length === 0) {
    return { queued: 0 };
  }

  console.log(
    `[tikhub-enrichment] queueing style1 gen for ${needsGen.length}/${products.length} products in batch=${input.batchId}`,
  );

  // Fire-and-forget loop. Same pattern the post-approve
  // generation uses: Promise.resolve().then(...) yields one
  // microtask then runs the loop to completion in the
  // background. Node in docker keeps it alive until it finishes.
  const bgBatchId = input.batchId;
  const bgProductIds = needsGen.map((p) => p.id);
  Promise.resolve().then(async () => {
    const { generateAiPromptForProduct } = await import(
      "@/app/batches/actions"
    );
    let ok = 0;
    let fail = 0;
    for (const productId of bgProductIds) {
      try {
        const r = await generateAiPromptForProduct({
          batchId: bgBatchId,
          productId,
          force: true,
        });
        if (r.ok) ok += 1;
        else {
          fail += 1;
          console.error(
            `[tikhub-enrichment.gen] not-ok product=${productId}: ${r.message}`,
          );
        }
      } catch (err) {
        fail += 1;
        console.error(
          `[tikhub-enrichment.gen] threw product=${productId}:`,
          err,
        );
      }
    }
    console.log(
      `[tikhub-enrichment.gen] batch=${bgBatchId} done: ${ok}/${bgProductIds.length} OK, ${fail} failed`,
    );
  });

  return { queued: needsGen.length };
}
