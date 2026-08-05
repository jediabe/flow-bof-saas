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
  updated: number;
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
}): Promise<
  "no-product-id" | "api-failed" | "updated" | "no-op"
> {
  const row = await db.product.findFirst({
    where: { id: input.productId, deletedAt: null },
    select: {
      id: true,
      tiktokUrl: true,
      discountPercent: true,
      discountType: true,
      referenceImageUrl: true,
    },
  });
  if (!row) return "no-op";

  const productIdOnTikTok = extractTikTokProductId(row.tiktokUrl);
  if (!productIdOnTikTok) return "no-product-id";

  let detail;
  try {
    detail = await getShopProductDetailEnriched(productIdOnTikTok);
  } catch (err) {
    console.error(
      `[tikhub-enrichment] fetch failed for product=${input.productId} tiktok_product=${productIdOnTikTok}:`,
      err,
    );
    return "api-failed";
  }
  if (!detail) return "api-failed";

  // Build the update payload. Source-* fields ALWAYS overwrite
  // (they're fresh TikHub data, not operator picks). Discount
  // fields ONLY overwrite when the row has no operator input yet.
  const updateData: {
    discountPercent?: number | null;
    discountType?: string | null;
    sourceImages?: string | null;
    sourceDescription?: string | null;
  } = {};
  if (row.discountPercent == null && detail.discountPercent != null) {
    updateData.discountPercent = detail.discountPercent;
  }
  if (!row.discountType && detail.discountType) {
    updateData.discountType = detail.discountType;
  }
  if (detail.additionalImages.length > 0) {
    updateData.sourceImages = JSON.stringify(detail.additionalImages);
  }
  if (detail.sourceDescription) {
    updateData.sourceDescription = detail.sourceDescription;
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

  return didWrite ? "updated" : "no-op";
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
  const rows = await db.product.findMany({
    where: { batchId: input.batchId, deletedAt: null },
    select: { id: true },
  });
  const report: EnrichmentReport = {
    attempted: rows.length,
    succeeded: 0,
    failedNoProductId: 0,
    failedApi: 0,
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
    `[tikhub-enrichment] batch=${input.batchId} done: ${report.updated}/${report.attempted} updated · ${report.failedApi} api-failed · ${report.failedNoProductId} missing product id`,
  );
  return report;
}
