"use server";

/**
 * /discover server actions — TikHub-driven product discovery.
 *
 * Wraps the existing TikHub shop discovery endpoints
 * (getHotSellingProducts, getTopAdsProducts,
 * getShopProductsByCategory) with a small server-side layer that
 * normalises them for the UI, plus a bulk-import action that
 * turns a selected batch of discovered products into a real
 * Batch + Product rows and kicks off Style 1 generation.
 *
 * All filter narrowing (price, commission %, sold count) happens
 * client-side after the fetch — TikHub doesn't accept those as
 * query params. That's fine for MVP; if we ever need to page
 * through > 1000 products per feed we'll move to server-side.
 *
 * No coupon lookup here — the user picked "nice-to-have, show
 * when we can find it, don't filter." Discount info comes back
 * only if the list endpoint already includes it (rare) or the
 * operator taps into the per-product detail modal (future).
 */

import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import {
  getHotSellingProducts,
  getTopAdsProducts,
  getShopProductsByCategory,
  type ShopMarketProduct,
} from "@/lib/tikhub";
import { downloadProductImage } from "@/lib/kalodata";
import { upsertProductImage } from "@/lib/product-images";
import { getOrCreateBatchReviewToken } from "@/app/batches/actions";
import QRCode from "qrcode";

/** Row shape rendered on /discover cards. Superset of
 *  ShopMarketProduct (TikHub's raw shape) with UI-friendly
 *  additions the client component wants but wouldn't want to
 *  derive from every card render.
 */
export interface DiscoverProduct {
  productId: string;
  title: string;
  imageUrlRemote: string | undefined;
  price: number;
  commissionRate: number;
  soldCount: number;
  category: string | undefined;
  /** Estimated lifetime revenue = price × soldCount. Rough
   *  because soldCount is lifetime not windowed, but it's the
   *  best "how big is this product" signal TikHub gives us
   *  today. */
  estRevenue: number;
}

function toDiscoverProduct(p: ShopMarketProduct): DiscoverProduct {
  return {
    ...p,
    estRevenue: p.price * p.soldCount,
  };
}

/* ------------------------------------------------------------------
 * Fetch actions
 * ---------------------------------------------------------------- */

/** Hot-selling TikTok Shop products right now, by region. */
export async function fetchDiscoverHotSelling(input?: {
  region?: string;
  page?: number;
}): Promise<{ ok: boolean; products: DiscoverProduct[]; message?: string }> {
  await getCurrentWorkspace(); // gate on auth
  try {
    const raw = await getHotSellingProducts({
      region: input?.region ?? "GB",
      page: input?.page ?? 1,
    });
    return { ok: true, products: raw.map(toDiscoverProduct) };
  } catch (err) {
    console.error("[discover.hot] fetch failed", err);
    return {
      ok: false,
      products: [],
      message: (err as Error).message || "TikHub call failed",
    };
  }
}

/** Creative Center trending — the products TikTok's own ad
 *  tooling is promoting. */
export async function fetchDiscoverTopAds(input?: {
  region?: string;
}): Promise<{ ok: boolean; products: DiscoverProduct[]; message?: string }> {
  await getCurrentWorkspace();
  try {
    const raw = await getTopAdsProducts({ region: input?.region ?? "GB" });
    return { ok: true, products: raw.map(toDiscoverProduct) };
  } catch (err) {
    console.error("[discover.topads] fetch failed", err);
    return {
      ok: false,
      products: [],
      message: (err as Error).message || "TikHub call failed",
    };
  }
}

/** Shop products filtered by TikTok's category id. Operator has
 *  to know the id — we surface a small preset list on the client
 *  since TikHub doesn't expose a category enumeration endpoint
 *  we've verified. */
export async function fetchDiscoverByCategory(input: {
  categoryId: string;
  region?: string;
  page?: number;
}): Promise<{ ok: boolean; products: DiscoverProduct[]; message?: string }> {
  await getCurrentWorkspace();
  if (!input.categoryId) {
    return { ok: false, products: [], message: "Pick a category first." };
  }
  try {
    const raw = await getShopProductsByCategory({
      categoryId: input.categoryId,
      region: input.region ?? "GB",
      page: input.page ?? 1,
    });
    return { ok: true, products: raw.map(toDiscoverProduct) };
  } catch (err) {
    console.error("[discover.category] fetch failed", err);
    return {
      ok: false,
      products: [],
      message: (err as Error).message || "TikHub call failed",
    };
  }
}

/* ------------------------------------------------------------------
 * Import action
 * ---------------------------------------------------------------- */

export interface ImportDiscoveredResult {
  ok: boolean;
  message?: string;
  batchId?: string;
  reviewUrl?: string;
  qrDataUrl?: string;
  productsCreated: number;
  imagesFailed: number;
}

/**
 * Bulk-import selected Discover products as a new Batch. Mirrors
 * importKalodataForPrompts's shape (creates a batch → creates
 * Product rows → downloads images → mints review token → returns
 * QR) so /prompts / /mobile-review can consume the batch
 * immediately.
 *
 * Style 1 generation fires per-product in the background AFTER
 * the operator approves them on mobile review — same as the
 * Kalodata import path. Nothing auto-generates here; approval is
 * still the gate.
 *
 * Client passes the DiscoverProduct rows it has in memory (not
 * just IDs) so we avoid a second TikHub round-trip just to
 * re-fetch what we already showed.
 */
export async function importDiscoveredProducts(input: {
  products: Array<{
    productId: string;
    title: string;
    imageUrlRemote: string | undefined;
    category: string | undefined;
    price: number;
  }>;
  batchName?: string;
  market?: "uk" | "us";
}): Promise<ImportDiscoveredResult> {
  const { workspace } = await getCurrentWorkspace();

  if (!input.products || input.products.length === 0) {
    return {
      ok: false,
      message: "No products selected.",
      productsCreated: 0,
      imagesFailed: 0,
    };
  }

  // Batch name defaults to "Discover · YYYY-MM-DD" for the same
  // easy-to-scan daily pattern the Kalodata import uses.
  const today = new Date();
  const dateSlug = `${today.getUTCFullYear()}-${String(
    today.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
  const batchName =
    (input.batchName || "").trim() || `Discover · ${dateSlug}`;
  const market = input.market === "us" ? "us" : "uk";

  const batch = await db.batch.create({
    data: {
      workspaceId: workspace.id,
      name: batchName,
      market,
    },
    select: { id: true },
  });

  let productsCreated = 0;
  let imagesFailed = 0;

  for (const src of input.products) {
    if (!src.productId || !src.title) continue;
    const product = await db.product.create({
      data: {
        batchId: batch.id,
        productName:   src.title,
        originalTitle: src.title,
        // No TikTok Shop URL — TikHub list endpoints don't return
        // one. The operator can look it up manually if they need to
        // verify a live discount.
        tiktokUrl:     null,
        category:      src.category ?? null,
        imageUrl:      src.imageUrlRemote ?? null,
      },
    });
    productsCreated += 1;

    if (!src.imageUrlRemote) {
      imagesFailed += 1;
      continue;
    }

    try {
      const dl = await downloadProductImage({
        url: src.imageUrlRemote,
        workspaceId: workspace.id,
        batchId: batch.id,
        productId: product.id,
      });
      await upsertProductImage({
        productId: product.id,
        role: "primary",
        url: dl.relUrl,
        // No "tikhub" source in the enum — the existing
        // upsertProductImage takes kalodata/paste/upload only.
        // Discover imports come from TikHub's public shop feed,
        // functionally equivalent to a Kalodata row (external
        // catalog row → we download + persist), so kalodata is
        // the right slot until the enum is widened.
        source: "kalodata",
      });
    } catch (err) {
      imagesFailed += 1;
      console.error(
        `[discover.import] image download failed for product=${product.id}:`,
        err,
      );
    }
  }

  if (productsCreated === 0) {
    // Nothing landed — drop the empty batch.
    await db.batch.delete({ where: { id: batch.id } });
    return {
      ok: false,
      message: "No products imported.",
      productsCreated: 0,
      imagesFailed,
    };
  }

  // Mint the review token — same pattern as Kalodata import so
  // the caller can render the QR and drop the operator into
  // mobile review immediately.
  const tokenResp = await getOrCreateBatchReviewToken(batch.id);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  let reviewUrl: string | undefined;
  let qrDataUrl: string | undefined;
  if (tokenResp.ok && tokenResp.token) {
    reviewUrl = appUrl
      ? `${appUrl.replace(/\/$/, "")}/mobile-review/${tokenResp.token}`
      : `/mobile-review/${tokenResp.token}`;
    try {
      qrDataUrl = await QRCode.toDataURL(reviewUrl, {
        width: 256,
        margin: 1,
        color: { dark: "#0A1220", light: "#FFFFFF" },
      });
    } catch (err) {
      console.warn("[discover.import] QR render failed:", err);
    }
  }

  // No auto-generate here. Style 1 kits fire on mobile approval —
  // that gate stays useful because approval is where the operator
  // enters the live discount %, which is what the LLM copy needs.

  return {
    ok: true,
    batchId: batch.id,
    reviewUrl,
    qrDataUrl,
    productsCreated,
    imagesFailed,
    message: `Imported ${productsCreated} product${productsCreated === 1 ? "" : "s"}. Open mobile review to approve.`,
  };
}
