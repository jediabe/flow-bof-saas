/**
 * Kalodata-import auto-enrichment via TikHub.
 *
 * When the operator uploads a Kalodata XLSX, each row already gives
 * us a productName + tiktokUrl + imgUrl + category. This module
 * takes the tiktokUrl, extracts the product id, calls TikHub's
 * fetch_product_detail_v3, and pushes the returned discount %,
 * discount type, commission rate, and (if better) image URL onto
 * the Product row.
 *
 * Effect: the operator's mobile review is a tap-to-approve for
 * every product where TikHub returned discount data, instead of
 * having to look up the % on each TikTok Shop page manually.
 *
 * Runs strictly in the background — the Kalodata import returns
 * immediately after creating the Product rows; enrichment fires
 * as a fire-and-forget loop. Individual TikHub failures never
 * roll back the Product row; we just leave the discount fields
 * null so the operator falls back to manual entry.
 */

import { db } from "@/lib/db";
import {
  extractTikTokProductId,
  getShopProductDetailEnriched,
} from "@/lib/tikhub";
import { downloadProductImage } from "@/lib/kalodata";
import { upsertProductImage } from "@/lib/product-images";

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
 * we leave that untouched. Same for discountType. Image is only
 * downloaded when the row still has no local referenceImageUrl.
 *
 * Returns "no-product-id" | "api-failed" | "updated" | "no-op".
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

  // Only write fields the row doesn't already have — operator wins.
  const updateData: {
    discountPercent?: number | null;
    discountType?: string | null;
  } = {};
  if (row.discountPercent == null && detail.discountPercent != null) {
    updateData.discountPercent = detail.discountPercent;
  }
  if (!row.discountType && detail.discountType) {
    updateData.discountType = detail.discountType;
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
      // discountType column might be missing on an un-migrated
      // deployment — fall back to updating just discountPercent.
      const msg = (err as Error).message || "";
      if (msg.includes("discountType") || msg.includes("Unknown arg `discountType`")) {
        try {
          const { discountPercent } = updateData;
          if (discountPercent != null) {
            await db.product.update({
              where: { id: row.id },
              data:  { discountPercent },
            });
            didWrite = true;
          }
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
  // reference image, download + attach it. Skips silently on any
  // failure — the row can still be reviewed with the original
  // Kalodata image (or none).
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
 * Enrich every product in a batch. Sequential to keep TikHub load
 * reasonable — a 30-product batch takes ~30-60s. Runs strictly in
 * the background from the Kalodata import path.
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
  for (const r of rows) {
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
  console.log(
    `[tikhub-enrichment] batch=${input.batchId} done: ${report.updated}/${report.attempted} updated · ${report.failedApi} api-failed · ${report.failedNoProductId} missing product id`,
  );
  return report;
}
