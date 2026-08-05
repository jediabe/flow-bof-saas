/**
 * TikHub service layer.
 *
 * Single entry-point for all unofficial-TikTok-API calls from the
 * BOF Dashboard. Four typed functions, each backed by one TikHub
 * endpoint. Designed so the official TikTok Partner API can swap
 * in later behind these same signatures.
 *
 * Why a service layer at all (rather than calling fetch from the
 * cron handler):
 *   1. **Auth + endpoint base URL live in one place.** TIKHUB_API_KEY
 *      is read here and nowhere else. Swapping vendors is a one-file
 *      change.
 *   2. **Error mapping is centralised.** 401 / 428 from TikHub map
 *      to a typed `CookieExpiredError`. Everything else maps to
 *      `TikHubError` with a code + message. Callers don't have to
 *      parse status codes.
 *   3. **Response normalization.** TikHub returns nested JSON in
 *      `{code, msg, data}` envelopes; we unwrap once here so the
 *      cron / page-render code reads clean shapes.
 *
 * Cookie handling:
 *   The caller passes a NORMALIZED cookie string (the one TikHub
 *   wants, see lib/tikhub-cookie-parser.ts). The TikTokAccount row
 *   stores it AES-GCM-encrypted; the cron handler is responsible
 *   for decrypting before calling these functions. We never see
 *   plaintext leave this process by accident — there's no logging
 *   of the cookie value.
 */

import {
  REQUIRED_TIKTOK_COOKIES,
  type RequiredCookieKey,
} from "@/lib/tikhub-cookie-parser";

const TIKHUB_BASE = "https://api.tikhub.io";

/**
 * How many recent days to sum inside pluckPairStats. TikHub
 * returns the whole calendar month per pair-stats call; without
 * this filter, "Top products" would show 28-day totals while the
 * operator's TikTok Creator Center default view is 7D — leading
 * to apparent doubling when a product had sales in both the last
 * 7 days AND the preceding weeks. Match Creator Center's default
 * so the numbers reconcile.
 */
const PAIR_STATS_WINDOW_DAYS = 7;

/** Endpoints TikHub publishes for TikTok Shop creator analytics.
 *
 * Verified against api.tikhub.io openapi.json on 2026-06-29 under
 * the "TikTok-Creator-API" tag. All four are POST.
 *
 * Date format gotcha: the overview + video endpoints expect
 * `start_date` as MM-DD-YYYY (US convention, e.g. "04-01-2025"),
 * but the product endpoint expects YYYY-MM-DD (ISO, e.g.
 * "2025-04-01"). Yes, in the same API. The two formatter helpers
 * below paper over this. */
const ENDPOINTS = {
  health:       "/api/v1/tiktok/creator/get_account_health_status",
  // get_video_analytics_summary — per-day time series with view
  // counts, new followers, video posts, and video-attributed GMV.
  // The "content metrics" source.
  videoSummary: "/api/v1/tiktok/creator/get_video_analytics_summary",
  // get_account_insights_overview — per-bucket time series with
  // TOTAL revenue (including live + direct shop), commission
  // estimate, impressions, and clicks. The "sales metrics"
  // source. Verified shape uses revenue.amount /
  // commission_estimated.amount / overall_item_sold_cnt /
  // product_show_cnt / product_click_cnt.
  insights:     "/api/v1/tiktok/creator/get_account_insights_overview",
  videos:       "/api/v1/tiktok/creator/get_video_list_analytics",
  products:     "/api/v1/tiktok/creator/get_product_analytics_list",
  // The get_product_analytics_list endpoint returns per-product
  // ZERO sales attribution for shop-owner-type accounts. To get
  // real per-product sales we walk a THREE-endpoint chain:
  //   videos → their tagged products → per-pair stats
  videoAssociatedProducts: "/api/v1/tiktok/creator/get_video_associated_product_list",
  videoToProductStats:     "/api/v1/tiktok/creator/get_video_to_product_stats",

  // ---------------------------------------------------------------
  // Product Research — TikTok Shop marketplace endpoints. NO cookie
  // required; auth is the workspace-global TIKHUB_API_KEY only.
  // Used by the /research surface to discover + track products
  // for future campaigns.
  //
  // shop/web/* is the current-generation series per TikHub docs
  // (app/v3 shop endpoints are deprecated for Shop marketplace
  // data). Only exception is the general search count below —
  // which lives under app/v3 because it's a search endpoint,
  // not a shop endpoint.
  // ---------------------------------------------------------------
  shopHotSelling:       "/api/v1/tiktok/shop/web/fetch_hot_selling_products_list",
  shopProductDetail:    "/api/v1/tiktok/shop/web/fetch_product_detail_v3",
  shopByCategory:       "/api/v1/tiktok/shop/web/fetch_products_by_category_id",
  adsTopProducts:       "/api/v1/tiktok/ads/get_top_products",
  generalSearch:        "/api/v1/tiktok/app/v3/fetch_general_search_result",
} as const;

/** TikHub's MM-DD-YYYY date string (overview, video endpoints). */
function formatDateUS(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${m}-${day}-${d.getUTCFullYear()}`;
}

/** TikHub's YYYY-MM-DD date string (products endpoint). */
function formatDateISO(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/** UTC midnight N days before "now". Used as the default
 *  start_date when the caller doesn't pass one. */
function daysAgoUtc(n: number, now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      n * 24 * 60 * 60 * 1000,
  );
}

/** First day of the current UTC month, formatted MM-01-YYYY.
 *  get_video_list_analytics wants this exact anchor — TikHub
 *  scopes the returned per-video totals to the calendar month
 *  containing start_date. */
function firstOfMonthUS(now: Date = new Date()): string {
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${m}-01-${now.getUTCFullYear()}`;
}

/** First day of the PREVIOUS UTC month, MM-01-YYYY. Used to
 *  compute the last-30-days window that spans two months. */
export function firstOfPrevMonthUS(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const pm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return `${pm}-01-${prev.getUTCFullYear()}`;
}

/* ---------------------------------------------------------------- */
/*  Typed errors                                                    */
/* ---------------------------------------------------------------- */

export class TikHubError extends Error {
  constructor(
    public code:
      | "AUTH_MISSING"
      | "COOKIE_EXPIRED"
      | "RATE_LIMITED"
      | "NETWORK"
      | "PARSE"
      | "HTTP_ERROR"
      | "UNKNOWN",
    message: string,
    public httpStatus?: number,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "TikHubError";
  }
}

/** Convenience marker — narrows COOKIE_EXPIRED from the union. */
export function isCookieExpired(err: unknown): err is TikHubError {
  return err instanceof TikHubError && err.code === "COOKIE_EXPIRED";
}

/* ---------------------------------------------------------------- */
/*  Typed response shapes                                           */
/*                                                                  */
/*  These are SaaS-side projections of the raw TikHub responses.    */
/*  TikHub's exact shape changes; we map the field names we care    */
/*  about and drop the rest. If TikHub renames a field, only the    */
/*  `pluck*` helpers below need editing.                            */
/* ---------------------------------------------------------------- */

export interface AccountHealth {
  /** One of "healthy" | "flagged" | "restricted" | "unknown" */
  status: string;
  /** 0-100, higher = worse. */
  violationScore: number;
  /** Restriction labels (e.g. ["video_audit"]). */
  restrictions: string[];
}

export interface AccountOverview {
  /** UTC midnight of the day this bucket covers. */
  date: Date;
  /** Numeric GMV in the account's native currency. */
  gmv: number;
  /** ISO 4217 currency code TikHub reported (GBP / USD / EUR / …). */
  currencyCode: string;
  /** Per-day metrics from get_video_analytics_summary. */
  videoViews: number;
  newFollowerCount: number;
  videoCount: number;
  itemsSold: number;
  /** TikHub's `get_video_analytics_summary` doesn't break GMV
   *  down by source (video vs live) or expose a separate
   *  commission line. Kept on the type so callers don't have to
   *  branch — populated as 0 until a richer endpoint surfaces
   *  the split. */
  estimatedCommission: number;
  videoRevenue: number;
  liveRevenue: number;
}

/**
 * One bucket from `get_account_insights_overview`. Independent of
 * AccountOverview (which is video_analytics_summary shape) because
 * insights returns the full revenue breakdown + impressions/clicks
 * that video_summary doesn't expose.
 */
export interface InsightsBucket {
  date: Date;
  /** Total GMV across all sources (live + video + direct shop)
   *  from TikHub's `revenue.amount`. */
  gmv: number;
  currencyCode: string;
  videoRevenue: number;
  liveRevenue: number;
  estimatedCommission: number;
  itemsSold: number;
  /** Product card impressions in the videos themselves
   *  (`product_show_cnt`). */
  productImpressions: number;
  /** Product card clicks (`product_click_cnt`). */
  productClicks: number;
}

export interface VideoAnalyticsRow {
  videoId: string;
  title: string;
  views: number;
  gmv: number;
}

export interface ProductAnalyticsRow {
  externalId: string;
  title: string;
  /** First thumbnail URL from product.cover_image.thumb_url_list,
   *  or null if missing. */
  thumbUrl: string | null;
  gmv: number;
  currencyCode: string;
  itemsSold: number;
  commission: number;
}

/**
 * One row of per-product attribution built by walking the
 * video-to-product stats chain. Same core numbers as
 * ProductAnalyticsRow (gmv/itemsSold/currencyCode) plus the
 * funnel metrics that only the pair-stats endpoint exposes:
 * views, clicks, orders.
 */
export interface ProductAttributionRow {
  externalId: string;
  title: string;
  gmv: number;
  currencyCode: string;
  itemsSold: number;
  productViews: number;
  productClicks: number;
  orderCount: number;
  /** get_video_to_product_stats doesn't return commission
   *  directly. Left as 0 here; callers estimate via take-rate
   *  from account-level insights if they need a number. */
  commission: number;
}

/**
 * One PER-PRODUCT-PER-DAY bucket, emitted by
 * pluckPairStatsDaily. The buckets are dense within the
 * ~28-day window TikHub returns — callers filter to whatever
 * window the dashboard is showing at render time.
 */
export interface ProductAttributionDailyBucket {
  /** UTC midnight of the bucket day. */
  date: Date;
  gmv: number;
  itemsSold: number;
  orderCount: number;
  productViews: number;
  productClicks: number;
}

/**
 * Per-product result from getProductAttributionDaily. The
 * product-level metadata (id, title, currency) sits alongside
 * the array of daily buckets so callers can persist metadata to
 * TikTokProduct AND per-day rows to TikTokProductDaily in one
 * pass.
 */
export interface ProductAttributionDaily {
  externalId: string;
  title: string;
  currencyCode: string;
  buckets: ProductAttributionDailyBucket[];
}

/**
 * Account-level month totals derived from summing every video
 * we see across paginated get_video_list_analytics pages. This
 * is the trustworthy ground truth for the account's current
 * calendar month GMV / items sold — much fresher than
 * get_account_insights_overview which can lag by a day.
 */
export interface AccountMonthTotals {
  /** MM-01-YYYY anchor sent to TikHub (i.e., which calendar
   *  month these totals cover). */
  monthAnchor: string;
  gmv: number;
  directGmv: number;
  itemsSold: number;
  currencyCode: string;
}

/**
 * Return type of getProductAttributionDaily. Wraps the previous
 * per-product buckets plus the newly-computed account-level
 * month totals so refresh can persist both in one shot.
 */
export interface ProductAttributionResult {
  products: ProductAttributionDaily[];
  monthTotals: AccountMonthTotals;
}

/* ---------------------------------------------------------------- */
/*  Public API                                                      */
/* ---------------------------------------------------------------- */

/**
 * Account health + violation score for one TikTok Shop creator account.
 * Maps to TikHub `get_account_health_status`. No date params.
 */
export async function getAccountHealth(input: {
  cookie: string;
}): Promise<AccountHealth> {
  const raw = await postTikHub(ENDPOINTS.health, { cookie: input.cookie });
  return pluckHealth(raw);
}

/**
 * Per-day analytics time series for one TikTok Shop creator
 * account. Maps to TikHub `get_video_analytics_summary`. Returns
 * ONE bucket per day in the requested range (TikHub itself
 * controls the granularity — we pick the daily segment from its
 * response). Defaults to a trailing 28-day window.
 *
 * The kept-for-back-compat name `getAccountOverview` returns
 * just the most recent non-empty day — useful for callers that
 * want a "right now" snapshot. New callers should prefer
 * `getCreatorTimeSeries` for the full series.
 */
export async function getCreatorTimeSeries(input: {
  cookie: string;
  startDate?: Date;
}): Promise<AccountOverview[]> {
  // `start_date` is misleadingly named — TikHub treats it as a
  // REFERENCE date and returns the calendar month containing it
  // plus the previous one (with daily granularity for the
  // reference month). Passing today gives us the current
  // in-progress month; passing 28 days ago gave us the prior
  // completed month and missed everything since.
  const start = input.startDate ?? new Date();
  const raw = await postTikHub(ENDPOINTS.videoSummary, {
    cookie: input.cookie,
    start_date: formatDateUS(start),
  });
  return pluckTimeSeries(raw);
}

/**
 * Per-bucket sales time series from get_account_insights_overview.
 * Same start_date semantics as getCreatorTimeSeries — passing today
 * returns the current month with daily granularity.
 *
 * Picks the finest-granularity segment from the response (TikHub
 * returns two: a 60-day monthly summary AND a per-day breakdown
 * for the current month). Buckets with empty `stats: {}` are
 * skipped.
 *
 * Callers wanting more than one month of daily data should use
 * `getCreatorInsightsMultiMonth` — one call = one calendar month.
 */
export async function getCreatorInsights(input: {
  cookie: string;
  startDate?: Date;
}): Promise<InsightsBucket[]> {
  const start = input.startDate ?? new Date();
  const raw = await postTikHub(ENDPOINTS.insights, {
    cookie: input.cookie,
    start_date: formatDateUS(start),
  });
  return pluckInsights(raw);
}

/**
 * Fetch daily-granularity insights across multiple calendar
 * months by calling `get_account_insights_overview` once per
 * month with an anchor date INSIDE that month.
 *
 * Why: TikHub's insights endpoint returns the calendar month
 * containing `start_date`. A single call with `start_date=today`
 * only covers the current (incomplete) month, so a "last 30
 * days" dashboard view only sees a few days of commission when
 * today is early in the month. Making N calls covers N months.
 *
 * Cost: N TikHub calls per refresh (each incurs a charge).
 * The default `monthCount=2` covers the last-30-day window
 * cleanly. Bump higher when the dashboard exposes wider
 * windows.
 *
 * Deduplicates by date — if two months' responses overlap (they
 * shouldn't, but defensively), the first response wins.
 */
export async function getCreatorInsightsMultiMonth(input: {
  cookie: string;
  monthCount?: number;
}): Promise<InsightsBucket[]> {
  const count = Math.max(1, input.monthCount ?? 2);
  const now = new Date();
  const merged: InsightsBucket[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < count; i++) {
    // Anchor to the FIRST of each month so TikHub picks the whole
    // month reliably. i=0 → this month, i=1 → last month, …
    const anchor = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    let monthBuckets: InsightsBucket[] = [];
    try {
      monthBuckets = await getCreatorInsights({
        cookie: input.cookie,
        startDate: anchor,
      });
    } catch {
      // A single-month failure shouldn't wipe the whole result —
      // partial coverage is better than none. The outer refresh
      // loop's try/catch surfaces total failures via the toast.
      continue;
    }
    for (const b of monthBuckets) {
      const key = b.date.toISOString();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(b);
    }
  }

  merged.sort((a, b) => a.date.getTime() - b.date.getTime());
  return merged;
}

/**
 * Convenience wrapper for the "single most recent bucket" use
 * case. Returns the latest non-empty day from the time series,
 * or an empty bucket dated today if everything is empty.
 */
export async function getAccountOverview(input: {
  cookie: string;
  startDate?: Date;
}): Promise<AccountOverview> {
  const series = await getCreatorTimeSeries(input);
  // Find the latest bucket with any non-zero metric.
  for (let i = series.length - 1; i >= 0; i--) {
    const b = series[i];
    if (
      b.videoViews > 0 ||
      b.newFollowerCount > 0 ||
      b.videoCount > 0 ||
      b.gmv > 0 ||
      b.itemsSold > 0
    ) {
      return b;
    }
  }
  // No activity in the window — return a zeroed bucket dated today.
  const today = new Date();
  return {
    date: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
    gmv: 0,
    currencyCode: series[0]?.currencyCode ?? "USD",
    videoViews: 0,
    newFollowerCount: 0,
    videoCount: 0,
    itemsSold: 0,
    estimatedCommission: 0,
    videoRevenue: 0,
    liveRevenue: 0,
  };
}

/**
 * Per-video analytics. Currently unused by the dashboard's MVP
 * (we lean on product / overview data), but kept on the surface
 * so a future "video performance" view can pull it.
 * Required: start_date (MM-DD-YYYY). Optional: page, rules.
 */
export async function getVideoAnalytics(input: {
  cookie: string;
  startDate?: Date;
  page?: number;
  rules?: string;
}): Promise<VideoAnalyticsRow[]> {
  const start = input.startDate ?? daysAgoUtc(30);
  const body: { cookie: string; [key: string]: unknown } = {
    cookie: input.cookie,
    start_date: formatDateUS(start),
  };
  if (input.page) body.page = input.page;
  if (input.rules) body.rules = input.rules;
  const raw = await postTikHub(ENDPOINTS.videos, body);
  return pluckVideos(raw);
}

/**
 * Per-product Shopping analytics. Drives the "Winning Products"
 * panel.
 * Required: start_date AND end_date, both YYYY-MM-DD (note: not
 * the same format as the overview endpoint above). Defaults to a
 * trailing 30 days through today.
 *
 * TikHub paginates at 25 products per page; this function walks
 * pages until `has_more` is false or the safety cap is hit.
 */
export async function getProductAnalytics(input: {
  cookie: string;
  startDate?: Date;
  endDate?: Date;
  /** Max pages to walk before giving up. Defaults to 10 (= 250
   *  products), which is plenty for affiliate creator catalogues
   *  we've seen. */
  maxPages?: number;
}): Promise<ProductAnalyticsRow[]> {
  const end = input.endDate ?? daysAgoUtc(0);
  const start = input.startDate ?? daysAgoUtc(30);
  const maxPages = input.maxPages ?? 20;
  const allRows: ProductAnalyticsRow[] = [];
  // TikHub's docs (screenshot confirmed) say page defaults to 0.
  // Previously started at 1 — silently missing page 0's rows.
  let page = 0;
  while (page < maxPages) {
    const raw = await postTikHub(ENDPOINTS.products, {
      cookie: input.cookie,
      start_date: formatDateISO(start),
      end_date:   formatDateISO(end),
      page,
    });
    const { rows, hasMore } = pluckProductsPage(raw);
    allRows.push(...rows);
    if (!hasMore || rows.length === 0) break;
    page++;
  }
  // Dedupe by externalId — TikHub can repeat a product across
  // segments / pages. Keep the row with the highest revenue.
  const map = new Map<string, ProductAnalyticsRow>();
  for (const p of allRows) {
    if (!p.externalId) continue;
    const existing = map.get(p.externalId);
    if (!existing || p.gmv > existing.gmv) map.set(p.externalId, p);
  }
  return [...map.values()];
}

/**
 * Build per-product sales attribution by walking the video ↔
 * product chain. Three endpoints, sequential dependency:
 *
 *   1. get_video_list_analytics    — recent videos
 *   2. get_video_associated_product_list (BATCHED, accepts an
 *      array of item_ids)          — pairs
 *   3. get_video_to_product_stats  — per-pair sales stats
 *
 * The third endpoint is the only creator-API surface that
 * returns `product_sales_cnt` / `product_revenue.amount` /
 * `product_view_cnt` / `product_click_cnt` for shop-owner-type
 * accounts. It's called once per (video, product) pair, so cost
 * grows linearly — we cap on both video count and pair count to
 * keep a single refresh from blowing through a TikHub quota.
 *
 * Result is aggregated per product_id: if the same product is
 * tagged in multiple videos, its stats are summed across all of
 * them.
 */
export async function getProductAttributionViaVideos(input: {
  cookie: string;
  /** Max recent videos to walk. Videos are returned newest-first
   *  by TikHub's default sort; the newest ones are usually the
   *  ones actively driving sales. */
  maxVideos?: number;
  /** Hard cap on (video, product) pair-stat calls per refresh.
   *  Each call is billable — this is the main lever for cost. */
  maxPairs?: number;
}): Promise<ProductAttributionRow[]> {
  const maxVideos = Math.max(1, input.maxVideos ?? 25);
  const maxPairs  = Math.max(1, input.maxPairs  ?? 60);
  const today = new Date();
  const startDate = formatDateUS(today);

  // Step 1: recent videos.
  const videoListRaw = await postTikHub(ENDPOINTS.videos, {
    cookie: input.cookie,
    start_date: startDate,
    page: 1,
  });
  const videoIds = pluckVideoIds(videoListRaw).slice(0, maxVideos);
  if (videoIds.length === 0) return [];

  // Step 2: batch-fetch associated products for ALL those videos
  // in one call (endpoint accepts an array of item_ids).
  const assocRaw = await postTikHub(ENDPOINTS.videoAssociatedProducts, {
    cookie: input.cookie,
    start_date: startDate,
    item_ids: videoIds,
  });
  const allPairs = pluckAssociatedPairs(assocRaw);
  if (allPairs.length === 0) return [];

  // Dedupe by product_id: TikHub's get_video_to_product_stats
  // returns the PRODUCT's aggregate stats for each (video,
  // product) pair, not the video's specific contribution. So a
  // product tagged in N videos returns the same total N times.
  // Summing across pairs double- (or triple-) counts. Instead,
  // probe once per unique product. Bonus: fewer TikHub calls.
  const seenProducts = new Set<string>();
  const uniqueProductPairs: typeof allPairs = [];
  for (const pair of allPairs) {
    if (seenProducts.has(pair.productId)) continue;
    seenProducts.add(pair.productId);
    uniqueProductPairs.push(pair);
  }

  // Cap and probe each pair. Individual pair failures degrade
  // silently — we'd rather have partial attribution than nothing.
  const probePairs = uniqueProductPairs.slice(0, maxPairs);
  const perPair: Array<{
    productId: string;
    productName: string;
    stats: {
      gmv: number;
      currencyCode: string;
      itemsSold: number;
      productViews: number;
      productClicks: number;
      orderCount: number;
    };
  }> = [];
  for (const pair of probePairs) {
    let raw: unknown;
    try {
      raw = await postTikHub(ENDPOINTS.videoToProductStats, {
        cookie: input.cookie,
        start_date: startDate,
        item_id: pair.itemId,
        product_id: pair.productId,
      });
    } catch {
      continue;
    }
    const stats = pluckPairStats(raw);
    if (!stats) continue;
    perPair.push({
      productId: pair.productId,
      productName: pair.productName,
      stats,
    });
  }

  // Build the result — one row per product. Probing is already
  // deduped to one pair per product above, so we set directly
  // without summing across pairs.
  const byProduct = new Map<string, ProductAttributionRow>();
  for (const p of perPair) {
    byProduct.set(p.productId, {
      externalId:     p.productId,
      title:          p.productName,
      gmv:            p.stats.gmv,
      currencyCode:   p.stats.currencyCode,
      itemsSold:      p.stats.itemsSold,
      productViews:   p.stats.productViews,
      productClicks:  p.stats.productClicks,
      orderCount:     p.stats.orderCount,
      commission:     0,
    });
  }
  return [...byProduct.values()].sort((a, b) => b.itemsSold - a.itemsSold);
}

/**
 * Per-day version of getProductAttributionViaVideos. Same
 * three-endpoint chain, same product dedupe, but returns per-day
 * buckets from the daily-granularity segment instead of a single
 * summed row per product. Enables window-accurate top-products
 * queries at render time.
 *
 * The caller (refresh) persists metadata to TikTokProduct and
 * daily buckets to TikTokProductDaily.
 */
/**
 * Sum per-video month totals for a specific calendar month by
 * walking all pages of get_video_list_analytics. Same paginator
 * as getProductAttributionDaily but stripped of the pair-chain —
 * we only want the account-level aggregate for the given anchor
 * month. Used by refresh to capture the PREVIOUS month's totals
 * so the 30-day dashboard window has data.
 */
export async function getAccountMonthTotals(input: {
  cookie: string;
  monthAnchor: string; // MM-01-YYYY
  maxPages?: number;
}): Promise<AccountMonthTotals> {
  const maxPages = Math.max(1, input.maxPages ?? 15);
  let gmv = 0;
  let directGmv = 0;
  let items = 0;
  let currency = "";
  let page = 0;
  while (page < maxPages) {
    let raw: unknown;
    try {
      raw = await postTikHub(ENDPOINTS.videos, {
        cookie: input.cookie,
        start_date: input.monthAnchor,
        page,
        rules: "VIDEO_LIST_ITEM_SOLD_CNT",
      });
    } catch {
      break;
    }
    const { hasMore, sawZeroInPage, pageTotals } =
      pluckVideoListPageWithSales(raw);
    gmv       += pageTotals.gmv;
    directGmv += pageTotals.directGmv;
    items     += pageTotals.itemsSold;
    if (!currency && pageTotals.currencyCode) {
      currency = pageTotals.currencyCode;
    }
    if (sawZeroInPage) break;
    if (!hasMore) break;
    page++;
  }
  return {
    monthAnchor: input.monthAnchor,
    gmv,
    directGmv,
    itemsSold: items,
    currencyCode: currency || "USD",
  };
}

export async function getProductAttributionDaily(input: {
  cookie: string;
  maxVideos?: number;
  maxPairs?: number;
  /** Hard cap on how many video-list pages we walk before
   *  giving up. 0-indexed pagination; TikHub returns
   *  `total_page` so this is only a safety valve. */
  maxVideoListPages?: number;
}): Promise<ProductAttributionResult> {
  const maxVideos          = Math.max(1, input.maxVideos          ?? 60);
  const maxPairs           = Math.max(1, input.maxPairs           ?? 150);
  const maxVideoListPages  = Math.max(1, input.maxVideoListPages  ?? 15);
  const now = new Date();
  // TikHub's get_video_list_analytics wants MM-01-YYYY —
  // first-of-current-month, not today. Documented at
  // https://docs.tikhub.io/289437016e0.
  const videoListStartDate = firstOfMonthUS(now);
  // Pair-stats calls stay anchored to today so we get the recent
  // daily buckets from the finest segment.
  const pairStatsStartDate = formatDateUS(now);

  // Step 1: walk pages of the top-selling video list. Pagination
  // is 0-indexed; sorted desc by item_sold_cnt; stop once a page
  // returns any zero-sales video (all subsequent are also zero)
  // or once we hit maxVideos.
  //
  // As we walk, sum the per-video month totals into an
  // account-level aggregate. That aggregate is our trustworthy
  // "this month" GMV / items sold — much fresher than the
  // insights endpoint which lags.
  // Two concerns walked in parallel:
  //   (a) SUM per-video month totals across every selling page —
  //       even if we've maxed out the pair-chain video count, we
  //       still want the account-level GMV correct.
  //   (b) COLLECT top selling videoIds for the pair chain,
  //       capped at maxVideos.
  // Previously these were coupled via `videoIds.length < maxVideos`
  // in the loop condition, which stopped summing at the pair-chain
  // cap and undercounted the monthly GMV. Now the loop only stops
  // on: zero-sold-seen (list is DESC sorted), no more pages, or
  // maxVideoListPages safety cap.
  const videoIds: string[] = [];
  const seenIds = new Set<string>();
  let page = 0;
  let monthGmv       = 0;
  let monthDirectGmv = 0;
  let monthItems     = 0;
  let monthCurrency  = "";
  while (page < maxVideoListPages) {
    let videoListRaw: unknown;
    try {
      videoListRaw = await postTikHub(ENDPOINTS.videos, {
        cookie: input.cookie,
        start_date: videoListStartDate,
        page,
        rules: "VIDEO_LIST_ITEM_SOLD_CNT",
      });
    } catch {
      break;
    }
    const { sellingVideoIds, hasMore, sawZeroInPage, pageTotals } =
      pluckVideoListPageWithSales(videoListRaw);
    // Always sum this page's contribution.
    monthGmv       += pageTotals.gmv;
    monthDirectGmv += pageTotals.directGmv;
    monthItems     += pageTotals.itemsSold;
    if (!monthCurrency && pageTotals.currencyCode) {
      monthCurrency = pageTotals.currencyCode;
    }
    // Only add to pair-chain videoIds up to the cap.
    if (videoIds.length < maxVideos) {
      for (const id of sellingVideoIds) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        videoIds.push(id);
        if (videoIds.length >= maxVideos) break;
      }
    }
    if (sawZeroInPage) break;
    if (!hasMore) break;
    page++;
  }

  const monthTotals: AccountMonthTotals = {
    monthAnchor: videoListStartDate,
    gmv:         monthGmv,
    directGmv:   monthDirectGmv,
    itemsSold:   monthItems,
    currencyCode: monthCurrency || "USD",
  };

  if (videoIds.length === 0) return { products: [], monthTotals };

  // Step 2: batched (video → tagged products).
  const assocRaw = await postTikHub(ENDPOINTS.videoAssociatedProducts, {
    cookie: input.cookie,
    start_date: pairStatsStartDate,
    item_ids: videoIds,
  });
  const allPairs = pluckAssociatedPairs(assocRaw);
  if (allPairs.length === 0) return { products: [], monthTotals };

  // NO dedupe by product_id here. Empirically, TikHub's
  // get_video_to_product_stats returns per-VIDEO contribution to
  // that product, not the product's aggregate total. A product
  // tagged in three videos may show up as three pairs each with
  // a different (or zero) contribution — the product's real
  // total is the SUM across all pairs. Probing only one pair
  // undercounts, which is the "products show 0 sold when they
  // actually sold" bug the operator flagged.
  //
  // We still cap total pair calls via maxPairs. If the account
  // has more unique pairs than the cap, later ones get dropped —
  // that could still undercount for products at the tail. The
  // caller can raise maxPairs at additional TikHub cost.
  const probePairs = allPairs.slice(0, maxPairs);

  // Aggregation state: for each product, keep title/currency plus
  // a per-date bucket map. Contributions from different pairs to
  // the same (product, date) get summed.
  const perProduct = new Map<
    string,
    {
      title: string;
      currencyCode: string;
      byDate: Map<string, ProductAttributionDailyBucket>;
    }
  >();

  for (const pair of probePairs) {
    let raw: unknown;
    try {
      raw = await postTikHub(ENDPOINTS.videoToProductStats, {
        cookie: input.cookie,
        start_date: pairStatsStartDate,
        item_id: pair.itemId,
        product_id: pair.productId,
      });
    } catch {
      continue;
    }
    const { buckets, currencyCode } = pluckPairStatsDaily(raw);

    let agg = perProduct.get(pair.productId);
    if (!agg) {
      agg = {
        title: pair.productName,
        currencyCode,
        byDate: new Map(),
      };
      perProduct.set(pair.productId, agg);
    } else {
      // Prefer a non-empty title/currency if the first pair had
      // gaps.
      if (!agg.title && pair.productName) agg.title = pair.productName;
      if (!agg.currencyCode || agg.currencyCode === "USD") {
        if (currencyCode && currencyCode !== "USD") {
          agg.currencyCode = currencyCode;
        }
      }
    }

    for (const b of buckets) {
      const dateKey = b.date.toISOString();
      const existing = agg.byDate.get(dateKey);
      if (!existing) {
        agg.byDate.set(dateKey, {
          date:          b.date,
          gmv:           b.gmv,
          itemsSold:     b.itemsSold,
          orderCount:    b.orderCount,
          productViews:  b.productViews,
          productClicks: b.productClicks,
        });
      } else {
        existing.gmv           += b.gmv;
        existing.itemsSold     += b.itemsSold;
        existing.orderCount    += b.orderCount;
        existing.productViews  += b.productViews;
        existing.productClicks += b.productClicks;
      }
    }
  }

  const products: ProductAttributionDaily[] = [];
  for (const [productId, agg] of perProduct) {
    products.push({
      externalId:   productId,
      title:        agg.title,
      currencyCode: agg.currencyCode,
      buckets: [...agg.byDate.values()].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      ),
    });
  }
  return { products, monthTotals };
}

/**
 * Single-call cookie validity test. Hits the cheapest endpoint
 * (`health`) and returns whether the cookie is currently accepted
 * by TikHub. Used by the Settings page's "Test Cookie" button.
 */
export async function testCookie(input: { cookie: string }): Promise<{
  ok: boolean;
  status: "active" | "expired" | "error";
  message: string;
}> {
  try {
    await getAccountHealth(input);
    return { ok: true, status: "active", message: "Cookie accepted." };
  } catch (err) {
    if (isCookieExpired(err)) {
      return {
        ok: false,
        status: "expired",
        message:
          "Cookie rejected by TikHub (401/428). Log into TikTok " +
          "Shop again and paste a fresh cookie.",
      };
    }
    const e = err as Error;
    return {
      ok: false,
      status: "error",
      message:
        e.message ||
        "TikHub returned an unexpected error while testing the cookie.",
    };
  }
}

/* ---------------------------------------------------------------- */
/*  HTTP layer                                                      */
/* ---------------------------------------------------------------- */

/**
 * Low-level POST to a TikHub endpoint. Handles auth header, body
 * marshalling, and the documented error → typed-exception mapping.
 *
 * The caller passes the body object directly so endpoint-specific
 * fields (start_date / end_date / page / rules) can ride along.
 * `proxy: null` is always added — TikHub's spec includes the
 * field on every creator endpoint, and the operator's deploy
 * doesn't proxy through anything.
 *
 * Cookie presence is validated here so a caller forgetting to pass
 * it produces a clean COOKIE_EXPIRED rather than a TikHub 401.
 */
async function postTikHub(
  path: string,
  body: { cookie: string; [key: string]: unknown },
): Promise<unknown> {
  const apiKey = (process.env.TIKHUB_API_KEY || "").trim();
  if (!apiKey) {
    throw new TikHubError(
      "AUTH_MISSING",
      "TIKHUB_API_KEY is unset. Add it to .env and restart the server.",
    );
  }
  const cookie = body.cookie;
  if (!cookie || !cookieLooksComplete(cookie)) {
    throw new TikHubError(
      "COOKIE_EXPIRED",
      "Cookie is empty or missing required keys. Re-paste from TikTok.",
    );
  }

  const url = `${TIKHUB_BASE}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ proxy: null, ...body }),
      // TikHub's creator endpoints can be slow (~10-20s) on large
      // accounts. Give them a generous timeout via AbortController
      // — the cron is the only caller and tolerates slow.
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const e = err as Error;
    throw new TikHubError(
      "NETWORK",
      `TikHub fetch failed: ${e.name}: ${e.message.slice(0, 200)}`,
      undefined,
      { url: maskUrl(url) },
    );
  }

  // 401 / 428 → cookie expired or rejected. Map first so callers
  // can branch with the typed marker.
  if (resp.status === 401 || resp.status === 428) {
    throw new TikHubError(
      "COOKIE_EXPIRED",
      `TikHub returned ${resp.status} — cookie expired or rejected.`,
      resp.status,
    );
  }
  if (resp.status === 429) {
    throw new TikHubError(
      "RATE_LIMITED",
      "TikHub rate-limited the request. Slow down or back off.",
      resp.status,
    );
  }
  if (!resp.ok) {
    let body = "";
    try {
      body = (await resp.text()).slice(0, 500);
    } catch {
      /* ignore body read failure */
    }
    throw new TikHubError(
      "HTTP_ERROR",
      `TikHub HTTP ${resp.status}: ${body || "(empty body)"}`,
      resp.status,
    );
  }

  // Parse + unwrap the {code, msg, data} envelope.
  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    const e = err as Error;
    throw new TikHubError(
      "PARSE",
      `TikHub returned non-JSON body: ${e.message.slice(0, 200)}`,
      resp.status,
    );
  }

  // Envelope shape: { code: number, msg: string, data: ... }.
  // TikHub uses code != 200 for application-level failures even
  // when the HTTP status is 200. The {code: 401} case is the
  // "cookie invalidated server-side" variant that doesn't surface
  // as an HTTP 401.
  if (
    json &&
    typeof json === "object" &&
    "code" in json &&
    typeof (json as { code: unknown }).code === "number"
  ) {
    const envelope = json as { code: number; msg?: unknown; data?: unknown };
    const innerCode = envelope.code;
    const innerMsg = String(envelope.msg ?? "");
    if (innerCode === 401 || innerCode === 428) {
      throw new TikHubError(
        "COOKIE_EXPIRED",
        `TikHub inner code ${innerCode}: ${innerMsg || "cookie rejected"}`,
        resp.status,
      );
    }
    if (innerCode === 429) {
      throw new TikHubError(
        "RATE_LIMITED",
        `TikHub inner code 429: ${innerMsg || "rate-limited"}`,
        resp.status,
      );
    }
    if (innerCode !== 200 && innerCode !== 0) {
      throw new TikHubError(
        "HTTP_ERROR",
        `TikHub inner code ${innerCode}: ${innerMsg || "unexpected error"}`,
        resp.status,
      );
    }
    return envelope.data;
  }

  // Some endpoints return the data directly without the envelope.
  // Pass through.
  return json;
}

function cookieLooksComplete(cookie: string): boolean {
  return REQUIRED_TIKTOK_COOKIES.every((k) =>
    cookie.includes(`${k}=`),
  );
}

function maskUrl(url: string): string {
  // No secrets in TikHub URLs, but keep this helper around in case
  // a future endpoint puts the cookie / api key in the query.
  return url;
}

/* ---------------------------------------------------------------- */
/*  Field pluckers — fragile by design (TikHub keeps the field      */
/*  names), but isolated so a TikHub rename is a one-function fix.  */
/* ---------------------------------------------------------------- */

function pluckHealth(raw: unknown): AccountHealth {
  const r = (raw ?? {}) as Record<string, unknown>;
  const status = normalizeStatus(String(r.status ?? r.health_status ?? "unknown"));
  const violationScore = clamp01_100(
    Number(r.violation_score ?? r.violationScore ?? 0),
  );
  const restrictionsRaw =
    (r.restrictions as unknown[]) ??
    (r.active_restrictions as unknown[]) ??
    [];
  const restrictions = Array.isArray(restrictionsRaw)
    ? restrictionsRaw.map((x) => String(x ?? "")).filter(Boolean)
    : [];
  return { status, violationScore, restrictions };
}

/**
 * Defensive read of the unwrapped `data` field — some callers may
 * pass the full {code, message, data} envelope, others the
 * unwrapped data directly. We accept both.
 */
function unwrapEnvelope(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  // If it looks like a {code, message, data} envelope and `data`
  // itself is an object, recurse into `data`.
  if (
    "code" in r &&
    "data" in r &&
    r.data &&
    typeof r.data === "object"
  ) {
    return r.data as Record<string, unknown>;
  }
  return r;
}

/**
 * Pluck the daily time series from a `get_video_analytics_summary`
 * response.
 *
 * Real-world shape (truncated, confirmed against an actual UK Shop
 * account 2026-06-29):
 *
 *   data.segments[]: Array<{
 *     time_selector: { period, granularity, ... },
 *     filter: { creator_id },
 *     timed_stats: Array<{
 *       start_timestamp,         // seconds, UTC
 *       end_timestamp,
 *       stats: {                 // OR `stats: {}` for an empty day
 *         vv_cnt,                // video views
 *         new_follower_cnt,
 *         video_cnt,
 *         items_sold,
 *         gmv: { amount, currency_code, currency_symbol, … }
 *       }
 *     }>
 *   }>
 *
 * Strategy:
 *   1. Find the segment with the FINEST granularity (lowest
 *      timed_stats[].end - start delta). That gives us per-day rows.
 *      Fall back to the first segment if granularity can't be
 *      inferred.
 *   2. Iterate timed_stats; for each, parse the bucket fields.
 *      Skip buckets with no stats (empty `{}`) — TikHub uses those
 *      as placeholders for days with no activity, and we don't want
 *      to clobber existing DB rows with zeros from a re-poll. Days
 *      with `stats: { vv_cnt: 0, … }` (explicit zeros) ARE kept
 *      because they're real "no activity" data.
 */
function pluckTimeSeries(raw: unknown): AccountOverview[] {
  const r = unwrapEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  if (segments.length === 0) return [];

  // Pick the finest-granularity segment (smallest bucket = daily).
  let best: Record<string, unknown> | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const stats = Array.isArray(s.timed_stats)
      ? (s.timed_stats as unknown[])
      : [];
    if (stats.length === 0) continue;
    const first = stats[0] as Record<string, unknown> | undefined;
    if (!first) continue;
    const startTs = Number(first.start_timestamp ?? 0);
    const endTs = Number(first.end_timestamp ?? 0);
    const delta = endTs - startTs;
    if (delta > 0 && delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  if (!best) best = segments[0] as Record<string, unknown>;

  const timedStats = Array.isArray(best.timed_stats)
    ? (best.timed_stats as unknown[])
    : [];

  const out: AccountOverview[] = [];
  for (const t of timedStats) {
    if (!t || typeof t !== "object") continue;
    const row = t as Record<string, unknown>;
    const stats = (row.stats ?? {}) as Record<string, unknown>;
    // Empty placeholder day — skip.
    if (Object.keys(stats).length === 0) continue;

    const startTs = Number(row.start_timestamp ?? 0);
    const date = new Date(startTs * 1000);
    if (Number.isNaN(date.getTime())) continue;
    // UTC midnight of the bucket's start day.
    const dateUtc = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );

    const gmvBlock = (stats.gmv ?? {}) as Record<string, unknown>;
    const gmv = num(
      gmvBlock.amount ?? gmvBlock.amount_delimited ?? stats.gmv_amount ?? 0,
    );
    const currencyCode = String(
      gmvBlock.currency_code ?? stats.currency_code ?? "USD",
    );

    out.push({
      date: dateUtc,
      gmv,
      currencyCode,
      videoViews:       Math.trunc(num(stats.vv_cnt ?? stats.video_view_count)),
      newFollowerCount: Math.trunc(num(stats.new_follower_cnt ?? stats.followers_gained)),
      videoCount:       Math.trunc(num(stats.video_cnt ?? stats.video_post_count)),
      itemsSold:        Math.trunc(num(stats.items_sold ?? stats.itemsSold)),
      // get_video_analytics_summary doesn't return these breakdowns.
      // Populated as 0; a future call to a richer endpoint can
      // overlay them.
      estimatedCommission: 0,
      videoRevenue:        0,
      liveRevenue:         0,
    });
  }

  // Sort ascending by date — TikHub appears to return them that way
  // already, but the sort is cheap and the contract is clearer.
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

function pluckVideos(raw: unknown): VideoAnalyticsRow[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const arr = (r.videos ?? r.list ?? r.data ?? raw) as unknown;
  if (!Array.isArray(arr)) return [];
  return arr.map((row) => {
    const x = (row ?? {}) as Record<string, unknown>;
    return {
      videoId: String(x.video_id ?? x.videoId ?? x.id ?? ""),
      title:   String(x.title ?? x.caption ?? ""),
      views:   Math.trunc(num(x.views ?? x.play_count)),
      gmv:     num(x.gmv ?? x.revenue ?? x.total_gmv),
    };
  });
}

/**
 * Verified-against-real-response plucker for
 * get_account_insights_overview. Real shape:
 *
 *   data.segments[]: Array<{
 *     time_selector: { period, granularity, ... },
 *     timed_stats: Array<{
 *       start_timestamp, end_timestamp,
 *       stats: {
 *         live_revenue:        { amount, currency_code, ... },
 *         video_revenue:       { amount, currency_code, ... },
 *         revenue:             { amount, currency_code, ... },  // TOTAL
 *         base_revenue:        { amount, currency_code, ... },
 *         commission_estimated:{ amount, currency_code, ... },
 *         overall_item_sold_cnt: number,
 *         product_show_cnt: number,       // impressions
 *         product_click_cnt: number,      // clicks
 *         alc_pay_sku_order_cnt: number,
 *         alc_base_revenue: { ... }
 *       } | {}                              // empty for placeholder days
 *     }>
 *   }>
 */
function pluckInsights(raw: unknown): InsightsBucket[] {
  const r = unwrapEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  if (segments.length === 0) return [];

  // Pick the segment with the FINEST granularity (smallest
  // start→end delta on its first bucket).
  let best: Record<string, unknown> | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const stats = Array.isArray(s.timed_stats) ? (s.timed_stats as unknown[]) : [];
    if (stats.length === 0) continue;
    const first = stats[0] as Record<string, unknown> | undefined;
    if (!first) continue;
    const startTs = Number(first.start_timestamp ?? 0);
    const endTs = Number(first.end_timestamp ?? 0);
    const delta = endTs - startTs;
    if (delta > 0 && delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  if (!best) best = segments[0] as Record<string, unknown>;

  const timedStats = Array.isArray(best.timed_stats)
    ? (best.timed_stats as unknown[])
    : [];

  const out: InsightsBucket[] = [];
  for (const t of timedStats) {
    if (!t || typeof t !== "object") continue;
    const row = t as Record<string, unknown>;
    const stats = (row.stats ?? {}) as Record<string, unknown>;
    if (Object.keys(stats).length === 0) continue;

    const startTs = Number(row.start_timestamp ?? 0);
    const date = new Date(startTs * 1000);
    if (Number.isNaN(date.getTime())) continue;
    const dateUtc = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );

    const revenueBlock      = (stats.revenue              ?? {}) as Record<string, unknown>;
    const videoRevBlock     = (stats.video_revenue        ?? {}) as Record<string, unknown>;
    const liveRevBlock      = (stats.live_revenue         ?? {}) as Record<string, unknown>;
    const commissionBlock   = (stats.commission_estimated ?? {}) as Record<string, unknown>;

    out.push({
      date: dateUtc,
      gmv:                 num(revenueBlock.amount),
      currencyCode:        String(revenueBlock.currency_code ?? "USD"),
      videoRevenue:        num(videoRevBlock.amount),
      liveRevenue:         num(liveRevBlock.amount),
      estimatedCommission: num(commissionBlock.amount),
      itemsSold:           Math.trunc(num(stats.overall_item_sold_cnt ?? stats.items_sold)),
      productImpressions:  Math.trunc(num(stats.product_show_cnt)),
      productClicks:       Math.trunc(num(stats.product_click_cnt)),
    });
  }

  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

/**
 * Verified-against-real-response plucker for
 * get_product_analytics_list. Real shape:
 *
 *   data.segments[]: Array<{
 *     filter: { creator_id, search_input },
 *     list_control: {
 *       rules: [...],
 *       next_pagination: { has_more, next_page, total_page, total }
 *     },
 *     timed_lists[]: Array<{
 *       start_timestamp, end_timestamp,
 *       stats[]: Array<{
 *         creator_id,
 *         product: { id, name, cover_image: { thumb_url_list } },
 *         item_sold_cnt,
 *         revenue:    { amount, currency_code, ... },
 *         commission: { amount, currency_code, ... }
 *       }>
 *     }>
 *   }>
 *
 * Note: TWO levels of arrays inside each segment
 * (timed_lists → stats). We flatten across both. Pagination state
 * is in `list_control.next_pagination` — returned alongside the
 * rows so the caller can walk pages.
 */
function pluckProductsPage(
  raw: unknown,
): { rows: ProductAnalyticsRow[]; hasMore: boolean } {
  const r = unwrapEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  const rows: ProductAnalyticsRow[] = [];
  let hasMore = false;

  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;

    const listControl = (s.list_control ?? {}) as Record<string, unknown>;
    const pagination =
      (listControl.next_pagination ?? {}) as Record<string, unknown>;
    if (pagination.has_more === true) hasMore = true;

    const timedLists = Array.isArray(s.timed_lists)
      ? (s.timed_lists as unknown[])
      : [];
    for (const tl of timedLists) {
      if (!tl || typeof tl !== "object") continue;
      const t = tl as Record<string, unknown>;
      const stats = Array.isArray(t.stats) ? (t.stats as unknown[]) : [];
      for (const item of stats) {
        if (!item || typeof item !== "object") continue;
        const x = item as Record<string, unknown>;
        const product   = (x.product    ?? {}) as Record<string, unknown>;
        const revenue   = (x.revenue    ?? {}) as Record<string, unknown>;
        const commission = (x.commission ?? {}) as Record<string, unknown>;
        const coverImg  = (product.cover_image ?? {}) as Record<string, unknown>;
        const thumbs    = Array.isArray(coverImg.thumb_url_list)
          ? (coverImg.thumb_url_list as unknown[])
          : [];
        const externalId = String(product.id ?? "");
        if (!externalId) continue;
        rows.push({
          externalId,
          title:        String(product.name ?? ""),
          thumbUrl:     thumbs.length > 0 ? String(thumbs[0] ?? "") : null,
          gmv:          num(revenue.amount),
          currencyCode: String(revenue.currency_code ?? "USD"),
          itemsSold:    Math.trunc(num(x.item_sold_cnt)),
          commission:   num(commission.amount),
        });
      }
    }
  }

  return { rows, hasMore };
}

/**
 * Extract just the recent video item_ids from a
 * get_video_list_analytics response. We only need the IDs; the
 * chain callers don't care about GMV/view counts at this step
 * (that's what step 3 is for).
 */
function pluckVideoIds(raw: unknown): string[] {
  const r = unwrapEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const timedLists = Array.isArray(s.timed_lists)
      ? (s.timed_lists as unknown[])
      : [];
    for (const tl of timedLists) {
      if (!tl || typeof tl !== "object") continue;
      const stats = Array.isArray((tl as Record<string, unknown>).stats)
        ? ((tl as Record<string, unknown>).stats as unknown[])
        : [];
      for (const item of stats) {
        if (!item || typeof item !== "object") continue;
        const meta = ((item as Record<string, unknown>).video_meta ?? {}) as Record<
          string,
          unknown
        >;
        const id = String(meta.item_id ?? "");
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  return out;
}

/**
 * Same shape walker as pluckVideoIds but filters to videos with
 * item_sold_cnt > 0, AND surfaces the pagination `has_more`
 * flag so the caller can walk pages. Returns:
 *   sellingVideoIds — deduped list of item_ids that sold
 *   hasMore         — whether next_pagination.has_more is true
 *   sawZeroInPage   — whether ANY zero-sold video appeared on
 *                     this page; used to short-circuit paging
 *                     (list is sorted desc by item_sold_cnt, so
 *                     the first zero means all subsequent are
 *                     also zero — no point paging further).
 */
function pluckVideoListPageWithSales(raw: unknown): {
  sellingVideoIds: string[];
  hasMore: boolean;
  sawZeroInPage: boolean;
  /** Sum of per-video month-totals seen on this page. Callers
   *  accumulate across pages to get the account's full monthly
   *  aggregate. */
  pageTotals: {
    gmv: number;
    directGmv: number;
    itemsSold: number;
    currencyCode: string;
  };
} {
  const r = unwrapEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  let hasMore = false;
  let sawZero = false;
  let sumGmv = 0;
  let sumDirectGmv = 0;
  let sumItemsSold = 0;
  let currencyCode = "";

  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    // Pagination flag lives on the segment's list_control.
    const listControl = (s.list_control ?? {}) as Record<string, unknown>;
    const pagination = (listControl.next_pagination ?? {}) as Record<string, unknown>;
    if (pagination.has_more === true) hasMore = true;

    const timedLists = Array.isArray(s.timed_lists)
      ? (s.timed_lists as unknown[])
      : [];
    for (const tl of timedLists) {
      if (!tl || typeof tl !== "object") continue;
      const stats = Array.isArray((tl as Record<string, unknown>).stats)
        ? ((tl as Record<string, unknown>).stats as unknown[])
        : [];
      for (const item of stats) {
        if (!item || typeof item !== "object") continue;
        const x = item as Record<string, unknown>;
        const meta = (x.video_meta ?? {}) as Record<string, unknown>;
        const id = String(meta.item_id ?? "");
        const itemSoldCnt = Math.trunc(num(x.item_sold_cnt));
        if (itemSoldCnt <= 0) {
          sawZero = true;
          continue;
        }
        // Sum per-video month totals (this endpoint scopes each
        // video's stats to start_date's calendar month).
        const gmvBlock       = (x.gmv        ?? {}) as Record<string, unknown>;
        const directGmvBlock = (x.direct_gmv ?? {}) as Record<string, unknown>;
        sumGmv       += num(gmvBlock.amount);
        sumDirectGmv += num(directGmvBlock.amount);
        sumItemsSold += itemSoldCnt;
        if (!currencyCode) {
          currencyCode = String(gmvBlock.currency_code ?? directGmvBlock.currency_code ?? "");
        }
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
    }
  }
  return {
    sellingVideoIds: out,
    hasMore,
    sawZeroInPage: sawZero,
    pageTotals: {
      gmv: sumGmv,
      directGmv: sumDirectGmv,
      itemsSold: sumItemsSold,
      currencyCode: currencyCode || "USD",
    },
  };
}

/**
 * Pluck (video_id, product_id, product_name) triples from a
 * get_video_associated_product_list response. Mirrors the
 * diagnostic-side extractor's tolerance for TikHub's three
 * observed shapes: object, array, keyed hashmap.
 */
function pluckAssociatedPairs(
  raw: unknown,
): Array<{ itemId: string; productId: string; productName: string }> {
  const r = unwrapEnvelope(raw);
  const out: Array<{ itemId: string; productId: string; productName: string }> = [];
  const seen = new Set<string>();

  const emit = (itemId: string, productId: string, productName: string): void => {
    if (!itemId || !productId) return;
    const key = `${itemId}::${productId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ itemId, productId, productName });
  };

  const walkProducts = (itemId: string, products: unknown): void => {
    if (!Array.isArray(products)) return;
    for (const p of products) {
      if (!p || typeof p !== "object") continue;
      const pp = p as Record<string, unknown>;
      const productId = String(pp.id ?? pp.product_id ?? "");
      const productName = String(pp.name ?? pp.title ?? pp.product_name ?? "");
      emit(itemId, productId, productName);
    }
  };

  const walkMaps = (maps: unknown): void => {
    if (!maps || typeof maps !== "object") return;
    if (Array.isArray(maps)) {
      for (const entry of maps) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const itemId = String(e.item_id ?? e.itemId ?? e.video_id ?? "");
        walkProducts(itemId, e.products ?? e.product_list);
      }
      return;
    }
    const obj = maps as Record<string, unknown>;
    if ("item_id" in obj || "itemId" in obj || "video_id" in obj) {
      const itemId = String(obj.item_id ?? obj.itemId ?? obj.video_id ?? "");
      walkProducts(itemId, obj.products ?? obj.product_list);
      return;
    }
    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== "object") continue;
      if (/^\d{15,}$/.test(key)) {
        const v = value as Record<string, unknown>;
        walkProducts(key, v.products ?? v.product_list ?? v);
      }
    }
  };

  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const timedLists = Array.isArray(s.timed_lists)
      ? (s.timed_lists as unknown[])
      : [];
    for (const tl of timedLists) {
      if (!tl || typeof tl !== "object") continue;
      const t = tl as Record<string, unknown>;
      const map =
        t.videoToProductsMap ??
        t.video_to_products_map ??
        t.videoToProducts ??
        t.item_products ??
        t;
      walkMaps(map);
    }
  }
  if (out.length === 0) {
    walkMaps(
      r.videoToProductsMap ??
        r.video_to_products_map ??
        r.videoToProducts ??
        r,
    );
  }
  return out;
}

/**
 * Pluck the summed stats block from a
 * get_video_to_product_stats response. Walks all segments +
 * timed_stats and sums each metric across time buckets so
 * callers get a single (period-aggregate) row per pair.
 *
 * Real response shape (verified 2026-07-10):
 *   data.segments[].timed_stats[].stats: {
 *     item_id, product_id,
 *     product_revenue.amount / currency_code,
 *     direct_revenue.amount,
 *     product_sales_cnt, product_view_cnt, product_click_cnt,
 *     order_cnt
 *   }
 */
function pluckPairStats(raw: unknown): {
  gmv: number;
  currencyCode: string;
  itemsSold: number;
  productViews: number;
  productClicks: number;
  orderCount: number;
} | null {
  const r = unwrapEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  if (segments.length === 0) return null;

  // TikHub returns two segments for pair stats:
  //   - Segment 1: monthly-granularity aggregate over a 2-month
  //     window (entry 1 = older month, entry 2 = recent month)
  //   - Segment 2: daily-granularity breakdown of ONLY the recent
  //     month
  //
  // Segment 2's daily total == segment 1's entry-2 total. Both
  // represent the SAME data. Summing both, or summing segment 1's
  // TWO entries, adds old + recent — that's how a product with 2
  // sales in June + 2 in July ends up doubled to 4.
  //
  // Fix: pick the finest-granularity segment (smallest bucket
  // delta = daily). That's the "recent period only" one; summing
  // its buckets gives the correct recent-window total.
  let best: Record<string, unknown> | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const timedStats = Array.isArray(s.timed_stats)
      ? (s.timed_stats as unknown[])
      : [];
    if (timedStats.length === 0) continue;
    const first = timedStats[0] as Record<string, unknown> | undefined;
    if (!first) continue;
    const startTs = Number(first.start_timestamp ?? 0);
    const endTs = Number(first.end_timestamp ?? 0);
    const delta = endTs - startTs;
    if (delta > 0 && delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  if (!best) best = segments[0] as Record<string, unknown>;

  const timedStats = Array.isArray(best.timed_stats)
    ? (best.timed_stats as unknown[])
    : [];

  // Window filter: sum only buckets whose start is within the last
  // PAIR_STATS_WINDOW_DAYS (default 7). TikHub returns the whole
  // calendar month; without filtering we'd count sales from ~28
  // days back, but the operator compares this panel to their
  // TikTok Creator Center "7D" view. Matching that window here
  // stops the appearance of doubling on accounts where earlier
  // days also had sales.
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffSec = nowSec - PAIR_STATS_WINDOW_DAYS * 86400;

  let gmv = 0;
  let itemsSold = 0;
  let productViews = 0;
  let productClicks = 0;
  let orderCount = 0;
  let currencyCode = "";
  let seenAny = false;

  for (const t of timedStats) {
    if (!t || typeof t !== "object") continue;
    const row = t as Record<string, unknown>;
    const stats = (row.stats ?? {}) as Record<string, unknown>;
    if (Object.keys(stats).length === 0) continue;
    // Skip buckets that started before the window cutoff.
    const bucketStart = Number(row.start_timestamp ?? 0);
    if (bucketStart > 0 && bucketStart < cutoffSec) continue;
    seenAny = true;
    const revBlock = (stats.product_revenue ?? {}) as Record<string, unknown>;
    gmv           += num(revBlock.amount);
    itemsSold     += Math.trunc(num(stats.product_sales_cnt));
    productViews  += Math.trunc(num(stats.product_view_cnt));
    productClicks += Math.trunc(num(stats.product_click_cnt));
    orderCount    += Math.trunc(num(stats.order_cnt));
    if (!currencyCode) {
      currencyCode = String(revBlock.currency_code ?? "USD");
    }
  }
  if (!seenAny) return null;
  return {
    gmv,
    currencyCode: currencyCode || "USD",
    itemsSold,
    productViews,
    productClicks,
    orderCount,
  };
}

/**
 * Per-day variant of pluckPairStats. Picks the finest-granularity
 * segment (same logic) and returns one bucket per non-empty day
 * with actual data, instead of a single summed aggregate.
 *
 * Non-empty means EITHER the stats block has values other than
 * zero OR at minimum has product_view_cnt > 0 (we keep view-only
 * days so trending charts show what got surfaced even without
 * sales). Full zero-value buckets are skipped to keep the DB
 * table sparse.
 *
 * Also returns the currency code observed on any bucket for
 * caller-side persistence.
 */
function pluckPairStatsDaily(raw: unknown): {
  buckets: ProductAttributionDailyBucket[];
  currencyCode: string;
} {
  const empty = { buckets: [] as ProductAttributionDailyBucket[], currencyCode: "USD" };
  const r = unwrapEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  if (segments.length === 0) return empty;

  // Same finest-granularity picker as pluckPairStats. We want the
  // daily segment (bucket delta = 1 day) so each bucket represents
  // one day.
  let best: Record<string, unknown> | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const timedStats = Array.isArray(s.timed_stats)
      ? (s.timed_stats as unknown[])
      : [];
    if (timedStats.length === 0) continue;
    const first = timedStats[0] as Record<string, unknown> | undefined;
    if (!first) continue;
    const startTs = Number(first.start_timestamp ?? 0);
    const endTs = Number(first.end_timestamp ?? 0);
    const delta = endTs - startTs;
    if (delta > 0 && delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  if (!best) best = segments[0] as Record<string, unknown>;

  const timedStats = Array.isArray(best.timed_stats)
    ? (best.timed_stats as unknown[])
    : [];

  const out: ProductAttributionDailyBucket[] = [];
  let currencyCode = "";

  for (const t of timedStats) {
    if (!t || typeof t !== "object") continue;
    const row = t as Record<string, unknown>;
    const stats = (row.stats ?? {}) as Record<string, unknown>;
    if (Object.keys(stats).length === 0) continue;

    const startTs = Number(row.start_timestamp ?? 0);
    if (startTs <= 0) continue;
    const date = new Date(startTs * 1000);
    if (Number.isNaN(date.getTime())) continue;
    const dateUtc = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );

    const revBlock = (stats.product_revenue ?? {}) as Record<string, unknown>;
    const gmv           = num(revBlock.amount);
    const itemsSold     = Math.trunc(num(stats.product_sales_cnt));
    const productViews  = Math.trunc(num(stats.product_view_cnt));
    const productClicks = Math.trunc(num(stats.product_click_cnt));
    const orderCount    = Math.trunc(num(stats.order_cnt));

    // Skip fully-zero buckets — nothing to persist. A missing row
    // in the DB reads as "no activity that day", which is what we
    // want.
    if (
      gmv === 0 &&
      itemsSold === 0 &&
      productViews === 0 &&
      productClicks === 0 &&
      orderCount === 0
    ) {
      continue;
    }

    if (!currencyCode) {
      currencyCode = String(revBlock.currency_code ?? "");
    }

    out.push({
      date: dateUtc,
      gmv,
      itemsSold,
      orderCount,
      productViews,
      productClicks,
    });
  }

  return {
    buckets: out.sort((a, b) => a.date.getTime() - b.date.getTime()),
    currencyCode: currencyCode || "USD",
  };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp01_100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeStatus(s: string): string {
  const lower = s.toLowerCase().trim();
  if (
    lower === "healthy" ||
    lower === "flagged" ||
    lower === "restricted" ||
    lower === "unknown"
  ) {
    return lower;
  }
  // TikHub may use "ok" / "warning" / "violation" — map them onto
  // our standard vocabulary.
  if (lower === "ok" || lower === "good") return "healthy";
  if (lower === "warning" || lower === "warn") return "flagged";
  if (lower === "violation" || lower === "banned") return "restricted";
  return "unknown";
}

/** Re-export the required cookie key list so callers don't need
 *  to import from two files. */
export type { RequiredCookieKey };

// ---------------------------------------------------------------------
// Product Research — Shop marketplace endpoints
// ---------------------------------------------------------------------
//
// Cookie-free variant of postTikHub. TikHub's Shop marketplace
// endpoints don't require a per-account TikTok session cookie —
// the workspace-global TIKHUB_API_KEY is the only auth. Kept
// separate from postTikHub so the cookie-completeness check
// doesn't false-positive on Shop callers who legitimately have
// no cookie to pass.
//
// If TikHub tightens Shop auth to require a cookie in the future,
// swap Shop callers to postTikHub and pass the workspace's first
// active cookie (we'd need a small helper to pick it).
async function postTikHubShop(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = (process.env.TIKHUB_API_KEY || "").trim();
  if (!apiKey) {
    throw new TikHubError(
      "AUTH_MISSING",
      "TIKHUB_API_KEY is unset. Add it to .env and restart the server.",
    );
  }
  const url = `${TIKHUB_BASE}${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ proxy: null, ...body }),
      // Shop endpoints are typically fast (<5s) but the hot
      // products list can be paginated; keep the timeout generous
      // to match the creator endpoints.
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const e = err as Error;
    throw new TikHubError(
      "NETWORK",
      `TikHub fetch failed: ${e.name}: ${e.message.slice(0, 200)}`,
      undefined,
      { url: maskUrl(url) },
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new TikHubError(
      "HTTP_ERROR",
      `TikHub returned ${resp.status}: ${text.slice(0, 300)}`,
      resp.status,
      { url: maskUrl(url) },
    );
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    const e = err as Error;
    throw new TikHubError(
      "PARSE",
      `TikHub response not JSON: ${e.message.slice(0, 200)}`,
    );
  }
  return json;
}

/**
 * GET-flavored TikHub Shop caller for the public discovery
 * endpoints. Same auth + error shape as postTikHubShop, but
 * query-string params instead of JSON body — TikHub's shop
 * discovery routes (hot selling, by category, top ads, product
 * detail) return 405 on POST.
 *
 * Values are coerced to strings; nulls / undefineds are skipped.
 */
async function getTikHubShop(
  path: string,
  params: Record<string, string | number | undefined | null>,
): Promise<unknown> {
  const apiKey = (process.env.TIKHUB_API_KEY || "").trim();
  if (!apiKey) {
    throw new TikHubError(
      "AUTH_MISSING",
      "TIKHUB_API_KEY is unset. Add it to .env and restart the server.",
    );
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const url = `${TIKHUB_BASE}${path}${qs.toString() ? `?${qs.toString()}` : ""}`;
  // When TIKHUB_ENRICH_DEBUG=1, log every outbound URL + the
  // last 6 chars of the api key so the operator can diff against
  // the URL they hit successfully in a browser / curl. Never log
  // the full key.
  if (process.env.TIKHUB_ENRICH_DEBUG === "1") {
    const keyTail = apiKey.length > 6 ? apiKey.slice(-6) : "(short)";
    console.log(
      `[tikhub-shop-get] GET ${url}  (key ...${keyTail})`,
    );
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    const e = err as Error;
    throw new TikHubError(
      "NETWORK",
      `TikHub fetch failed: ${e.name}: ${e.message.slice(0, 200)}`,
      undefined,
      { url: maskUrl(url) },
    );
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new TikHubError(
      "HTTP_ERROR",
      `TikHub returned ${resp.status}: ${text.slice(0, 300)}`,
      resp.status,
      { url: maskUrl(url) },
    );
  }
  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    const e = err as Error;
    throw new TikHubError(
      "PARSE",
      `TikHub response not JSON: ${e.message.slice(0, 200)}`,
    );
  }
  return json;
}

/** Shape returned to /research callers per Shop-endpoint row. */
export interface ShopMarketProduct {
  /** TikTok's product_id — join key across ShopProduct + TikTokProduct. */
  productId: string;
  title: string;
  /** Raw TikTok CDN URL. Caller must download + persist before using —
   *  these URLs expire. Undefined when the row lacks any image. */
  imageUrlRemote: string | undefined;
  price: number;
  /** Commission rate as a percentage (e.g. 15 for 15%). Some endpoints
   *  return a decimal (0.15); this shape always normalises to percentage. */
  commissionRate: number;
  soldCount: number;
  category: string | undefined;
}

/** Pluck the array-shaped `data.products` (or common alternates) out of a
 *  TikHub Shop response, coercing each row into ShopMarketProduct. Tolerant
 *  of shape drift — Shop endpoints have shipped multiple response shapes. */
function pluckShopProducts(raw: unknown): ShopMarketProduct[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  const data = (r.data ?? r) as Record<string, unknown>;
  const list =
    (Array.isArray(data.products) && data.products) ||
    (Array.isArray(data.product_list) && data.product_list) ||
    (Array.isArray(data.products_list) && data.products_list) ||
    (Array.isArray(data.items) && data.items) ||
    (Array.isArray((r as { products?: unknown }).products) && (r as { products: unknown[] }).products) ||
    [];
  const out: ShopMarketProduct[] = [];
  for (const row of list as unknown[]) {
    if (!row || typeof row !== "object") continue;
    const p = row as Record<string, unknown>;
    const productId = String(
      p.product_id ?? p.id ?? p.productId ?? "",
    ).trim();
    if (!productId) continue;
    const title = String(p.product_name ?? p.title ?? p.name ?? "").trim();
    // Image url comes back on different keys per endpoint. cover_image
    // sometimes is an object with a `thumb_url_list` array; sometimes
    // it's a plain string. Handle both.
    let imageUrlRemote: string | undefined;
    const rawCover = p.cover_image ?? p.image ?? p.image_url ?? p.cover;
    if (typeof rawCover === "string") {
      imageUrlRemote = rawCover;
    } else if (rawCover && typeof rawCover === "object") {
      const c = rawCover as Record<string, unknown>;
      const list = c.thumb_url_list ?? c.url_list ?? c.urls;
      if (Array.isArray(list) && list.length > 0 && typeof list[0] === "string") {
        imageUrlRemote = list[0] as string;
      } else if (typeof c.url === "string") {
        imageUrlRemote = c.url;
      }
    }
    // Price is nested { amount, currency } on some endpoints, flat on
    // others. Normalise to a plain number of the amount.
    let price = 0;
    const rawPrice = p.price ?? p.sale_price ?? p.original_price;
    if (typeof rawPrice === "number") price = rawPrice;
    else if (rawPrice && typeof rawPrice === "object") {
      price = num((rawPrice as { amount?: unknown }).amount);
    }
    // Commission — often a percentage string like "15%" or a decimal 0.15.
    // Normalise to the percentage integer (15).
    let commissionRate = 0;
    const rawComm = p.commission_rate ?? p.commission ?? p.commission_pct;
    if (typeof rawComm === "number") {
      commissionRate = rawComm <= 1 ? rawComm * 100 : rawComm;
    } else if (typeof rawComm === "string") {
      const cleaned = rawComm.replace("%", "").trim();
      const n = Number(cleaned);
      if (Number.isFinite(n)) {
        commissionRate = n <= 1 ? n * 100 : n;
      }
    }
    const soldCount = num(
      p.sold_count ?? p.item_sold_cnt ?? p.sales_cnt ?? p.orders,
    );
    const category = typeof p.category === "string"
      ? p.category
      : typeof p.category_name === "string"
        ? p.category_name
        : undefined;
    out.push({
      productId,
      title,
      imageUrlRemote,
      price,
      commissionRate,
      soldCount,
      category,
    });
  }
  return out;
}

/**
 * fetch_hot_selling_products_list — top-selling TikTok Shop items right
 * now. The primary discovery feed for /research's Hot tab.
 */
export async function getHotSellingProducts(input?: {
  page?: number;
  region?: string;
}): Promise<ShopMarketProduct[]> {
  const raw = await getTikHubShop(ENDPOINTS.shopHotSelling, {
    page: input?.page ?? 1,
    region: input?.region ?? "GB",
  });
  return pluckShopProducts(raw);
}

/**
 * fetch_products_by_category_id — Shop products filtered by category.
 * Useful for niche-scoped scans (Beauty, Home, etc.).
 */
export async function getShopProductsByCategory(input: {
  categoryId: string;
  page?: number;
  region?: string;
}): Promise<ShopMarketProduct[]> {
  const raw = await getTikHubShop(ENDPOINTS.shopByCategory, {
    category_id: input.categoryId,
    page: input.page ?? 1,
    region: input.region ?? "GB",
  });
  return pluckShopProducts(raw);
}

/**
 * ads/get_top_products — Creative Center's trending signal. Products
 * with high ad spend / creator adoption per TikTok's own ad tooling.
 * Slightly different shape than Shop endpoints — same normaliser.
 */
export async function getTopAdsProducts(input?: {
  region?: string;
}): Promise<ShopMarketProduct[]> {
  const raw = await getTikHubShop(ENDPOINTS.adsTopProducts, {
    region: input?.region ?? "GB",
  });
  return pluckShopProducts(raw);
}

/**
 * fetch_product_detail_v3 — full detail for one product. Returned by
 * pluckShopProducts too but with more fields available (images may
 * be an array, sold_count more accurate, etc.). Caller uses this on
 * discovery to write the initial ShopProduct row.
 */
export async function getShopProductDetail(
  productId: string,
  input?: { region?: string },
): Promise<ShopMarketProduct | null> {
  const raw = await getTikHubShop(ENDPOINTS.shopProductDetail, {
    product_id: productId,
    region: input?.region ?? "GB",
  });
  if (!raw || typeof raw !== "object") return null;
  // Detail endpoint returns a single product envelope, not a list.
  // Wrap it so pluckShopProducts can handle it uniformly.
  const r = raw as Record<string, unknown>;
  const detail =
    (r.data as Record<string, unknown> | undefined)?.product ??
    (r.data as Record<string, unknown> | undefined) ??
    r;
  // TikHub returns {exists: false, error_code, message} for
  // products that aren't in the queried catalog. Skip these
  // early — they'd otherwise pass pluckShopProducts (which only
  // requires a product_id) and return a garbage row with empty
  // title / price / images.
  if (
    detail &&
    typeof detail === "object" &&
    (detail as Record<string, unknown>).exists === false
  ) {
    return null;
  }
  const wrapped = { data: { products: [detail] } };
  const list = pluckShopProducts(wrapped);
  return list[0] ?? null;
}

/**
 * Extract the numeric TikTok Shop product ID from a full TikTok URL.
 * Handles the common Kalodata / TikTok Shop URL shapes:
 *   https://shop.tiktok.com/view/product/1729459734203894312
 *   https://www.tiktok.com/view/product/1729...
 *   https://shop-us.tiktok.com/view/product/1729...?...
 *   ...?product_id=1729459734203894312
 *
 * Returns null if the URL is empty, malformed, or clearly doesn't
 * contain a product id (e.g. a /video/ url, a bare shop.tiktok.com
 * homepage, a short vm.tiktok.com/... redirect we can't resolve).
 *
 * Product ids are TikTok snowflake-style integers, ~18–20 digits.
 */
export function extractTikTokProductId(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  // Fast reject: video URLs never carry a product id.
  if (/\/video\//i.test(s)) return null;
  // 1) /product/<digits> or /view/product/<digits>
  const productPath = /\/product\/(\d{10,})/i.exec(s);
  if (productPath) return productPath[1];
  // 2) ?product_id=<digits>
  const productParam = /[?&]product_id=(\d{10,})/i.exec(s);
  if (productParam) return productParam[1];
  // 3) Last-resort: any 15+ digit sequence anywhere. Kalodata URLs
  //    sometimes drop the /product/ segment when they've been
  //    routed through a shortener that got resolved. 15 is chosen
  //    to avoid matching timestamps (10 digit UNIX seconds) or
  //    short user ids.
  const anyLong = /(\d{15,})/.exec(s);
  if (anyLong) return anyLong[1];
  return null;
}

/**
 * Enriched detail shape — everything the Kalodata-import enrichment
 * path needs to pre-fill a Product row so mobile review is a tap-
 * to-approve rather than a manual-data-entry step.
 *
 * All fields are optional / nullable because TikHub responses drift:
 * a product without an active voucher won't have promo fields, a
 * non-affiliate product won't have commissionRate, etc.
 */
export interface ShopProductDetailEnriched {
  productId: string;
  title: string;
  imageUrlRemote: string | undefined;
  price: number;
  /** Commission rate as a percentage (e.g. 15 for 15%). 0 when the
   *  product isn't part of an affiliate program. */
  commissionRate: number;
  soldCount: number;
  category: string | undefined;
  /** Discount percentage (1..100) surfaced by the listing itself —
   *  a live voucher / coupon / sale on TikTok Shop right now. Null
   *  when no discount is active. When multiple SKU variants exist,
   *  this is the MIN discount across variants (safe default so we
   *  don't advertise a % the operator can't actually deliver). */
  discountPercent: number | null;
  /** Best guess of the discount mechanism. TikHub responses distinguish
   *  vouchers/coupons (claimable, price stays list) from sales (sticker
   *  price is actually lower) in different fields — we normalize to
   *  the same enum Product.discountType uses. Null when we can't tell. */
  discountType: "voucher" | "sale" | null;
  /** True when the product returned any commission signal at all.
   *  Used to auto-tick the affiliate hint in the review UI. */
  isAffiliate: boolean;
  /** Additional image URLs scraped from the response (main image
   *  plus gallery). Publicly-accessible TikTok CDN URLs — the /prompts
   *  modal surfaces them as a quick-copy strip for paste into Google
   *  Flow. Capped at 8. First item usually the primary product image. */
  additionalImages: string[];
  /** Product description text from the listing. HTML stripped, capped
   *  at 2000 chars. Useful reference material for the LLM copy pass
   *  and for the operator to sanity-check what the product actually
   *  does before approving. Null when TikHub returned no description. */
  sourceDescription: string | null;
}

/**
 * Same as getShopProductDetail but returns the enriched shape with
 * discount %, discount type, and affiliate flag. The Kalodata import
 * pipeline calls this per row after the Product is created so the
 * operator's mobile review starts with those fields already filled.
 *
 * Very tolerant of shape drift — TikHub's fetch_product_detail_v3
 * has shipped multiple response layouts over time. When a field
 * isn't present or can't be parsed cleanly, we leave it null rather
 * than raising; the mobile UI just falls back to manual entry.
 */
export async function getShopProductDetailEnriched(
  productId: string,
  input?: { region?: string },
): Promise<ShopProductDetailEnriched | null> {
  const region = input?.region ?? "GB";
  const raw = await getTikHubShop(ENDPOINTS.shopProductDetail, {
    product_id: productId,
    region,
  });
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const detail =
    (r.data as Record<string, unknown> | undefined)?.product ??
    (r.data as Record<string, unknown> | undefined) ??
    r;
  if (!detail || typeof detail !== "object") return null;
  // TikHub returns {exists: false, error_code: 23002002, message:
  // "商品不存在 / product not exist"} when the product isn't in
  // the queried region's catalog. Treat as a real "not found" so
  // the enrichment layer can count it separately from generic API
  // failures. This is the #1 hit at first-import: batch region
  // and product region mismatch.
  const d = detail as Record<string, unknown>;
  if (d.exists === false) {
    const msg = typeof d.message === "string" ? d.message.slice(0, 120) : "";
    console.warn(
      `[tikhub-detail] product=${productId} region=${region} NOT FOUND: ${msg}`,
    );
    return null;
  }

  // Reuse the existing shape-tolerant plucker for the fields it
  // already handles, then layer the enrichment on top.
  const wrapped = { data: { products: [detail] } };
  const base = pluckShopProducts(wrapped)[0];
  if (!base) return null;

  const discount = pluckDiscount(d);
  const additionalImages = pluckImageUrls(d);
  const sourceDescription = pluckSourceDescription(d);

  // Extraction debug. Set TIKHUB_ENRICH_DEBUG=1 in the env to dump
  // the raw payload + everything we plucked to the server logs
  // per product. Useful when the operator says "the gallery is
  // empty" and we need to see what TikHub actually sent back.
  //
  // Off by default because a Kalodata sheet with 30 rows would
  // otherwise spew 30 * O(response size) worth of JSON into the
  // logs and cost log-rotation cycles for no benefit at steady
  // state.
  if (process.env.TIKHUB_ENRICH_DEBUG === "1") {
    console.log(
      `[tikhub-detail] product=${productId} images_found=${additionalImages.length} discount_pct=${discount.percent} discount_type=${discount.type} desc_len=${sourceDescription?.length ?? 0}`,
    );
    if (additionalImages.length === 0) {
      // Print top-level keys so we can see whether the images
      // live behind a wrapper we're not descending into.
      const topKeys = Object.keys(d).sort().join(", ");
      console.log(
        `[tikhub-detail] product=${productId} NO IMAGES — top-level keys: ${topKeys}`,
      );
      // Print the first 4KB of the raw JSON so we can inspect
      // the shape without spamming megabytes. Enough to see the
      // wrapper structure without leaking full product data.
      const preview = JSON.stringify(d).slice(0, 4000);
      console.log(
        `[tikhub-detail] product=${productId} raw preview: ${preview}`,
      );
    }
  }

  return {
    ...base,
    discountPercent: discount.percent,
    discountType: discount.type,
    isAffiliate: base.commissionRate > 0,
    additionalImages,
    sourceDescription,
  };
}

/** Extract a discount % + type from a TikTok Shop product detail
 *  payload. Tries paths in this order:
 *
 *  0. SKU price map (the "1729...411": {discount_decimal: "0.35"}
 *     shape). Recursively walk the response tree to find EVERY
 *     object with a valid discount_decimal (the map is nested deep
 *     under different keys across TikHub response shapes). Take
 *     the MIN discount across all variants — safest to advertise
 *     the smallest guaranteed % than to overpromise on a variant
 *     that might sell out first. Type: "sale" because SKU prices
 *     are baked into origin_price vs sale_price, not a claimable
 *     voucher.
 *  1. discount_price vs original_price at the top level → sale.
 *  2. promotion_info.{discount, type} → voucher or sale.
 *  3. promotions[] / vouchers[] / coupons[] → biggest voucher %.
 *
 *  Falls back to null/null when nothing confidently matches. */
function pluckDiscount(
  d: Record<string, unknown>,
): { percent: number | null; type: "voucher" | "sale" | null } {
  // Path 0: recursive SKU discount walk.
  const skuDiscounts: number[] = [];
  collectSkuDiscounts(d, skuDiscounts);
  if (skuDiscounts.length > 0) {
    const minDecimal = Math.min(...skuDiscounts); // 0.35 = 35%
    const pct = Math.round(minDecimal * 100);
    if (pct >= 1 && pct <= 100) {
      return { percent: pct, type: "sale" };
    }
  }
  // Path 1: derive percent from discount_price vs original_price
  // (implies an actual sale price on the listing itself).
  const originalPrice = toNumber(
    d.original_price ?? d.originalPrice ?? d.list_price,
  );
  const discountPrice = toNumber(
    d.discount_price ?? d.discountPrice ?? d.sale_price ?? d.current_price,
  );
  if (
    originalPrice !== null &&
    discountPrice !== null &&
    originalPrice > 0 &&
    discountPrice > 0 &&
    discountPrice < originalPrice
  ) {
    const pct = Math.round(((originalPrice - discountPrice) / originalPrice) * 100);
    if (pct >= 1 && pct <= 100) {
      return { percent: pct, type: "sale" };
    }
  }
  // Path 2: explicit promo info fields. TikHub sometimes returns
  // {promotion_info: {discount: 20, type: "voucher"}} or similar.
  const promoInfo =
    (d.promotion_info as Record<string, unknown> | undefined) ??
    (d.promotionInfo as Record<string, unknown> | undefined);
  if (promoInfo) {
    const pct = toNumber(promoInfo.discount ?? promoInfo.discount_percent ?? promoInfo.percentage);
    if (pct !== null && pct >= 1 && pct <= 100) {
      const t = String(promoInfo.type ?? promoInfo.promotion_type ?? "voucher").toLowerCase();
      const type: "voucher" | "sale" = t.includes("sale") ? "sale" : "voucher";
      return { percent: Math.round(pct), type };
    }
  }
  // Path 3: coupons / vouchers array — take the biggest %.
  const promoList =
    (Array.isArray(d.promotions) && (d.promotions as unknown[])) ||
    (Array.isArray(d.vouchers) && (d.vouchers as unknown[])) ||
    (Array.isArray(d.coupons) && (d.coupons as unknown[])) ||
    [];
  let bestVoucher: number | null = null;
  for (const p of promoList) {
    if (!p || typeof p !== "object") continue;
    const po = p as Record<string, unknown>;
    const pct = toNumber(po.discount ?? po.discount_percent ?? po.percentage ?? po.value);
    if (pct !== null && pct >= 1 && pct <= 100) {
      if (bestVoucher === null || pct > bestVoucher) bestVoucher = pct;
    }
  }
  if (bestVoucher !== null) {
    return { percent: Math.round(bestVoucher), type: "voucher" };
  }
  return { percent: null, type: null };
}

/** Recursively walk a TikHub product-detail payload collecting
 *  every valid discount_decimal (0..1) value from SKU-shaped
 *  objects. The map is nested under different keys across
 *  response shapes (sku_price_infos, sku_prices, promotion.skus,
 *  price_info, etc.), so we don't assume a path — just find every
 *  object that has both a sku_id AND a discount_decimal, or bare
 *  discount_decimal for shapes that flatten the map. Depth cap
 *  keeps this bounded for pathological payloads. */
function collectSkuDiscounts(
  v: unknown,
  acc: number[],
  depth: number = 0,
): void {
  if (depth > 8) return;
  if (!v) return;
  if (Array.isArray(v)) {
    for (const item of v) collectSkuDiscounts(item, acc, depth + 1);
    return;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const dd = o.discount_decimal ?? o.discountDecimal;
    if (dd !== undefined && dd !== null) {
      const n = toNumber(dd);
      // 0 < n <= 1 (decimals like 0.35 = 35%). Reject 0
      // (no discount) and > 1 (already a %, wrong path).
      if (n !== null && n > 0 && n <= 1) {
        acc.push(n);
      }
    }
    for (const k of Object.keys(o)) {
      collectSkuDiscounts(o[k], acc, depth + 1);
    }
  }
}

/** Pluck a gallery of image URLs from the response. Aggressive
 *  recursive walk that handles the shapes TikHub actually returns:
 *
 *  - Bare strings: "https://p16-oec-common-va.tiktokcdn-us.com/..."
 *  - {url: "..."} — the classic single-image object
 *  - {url_list: [...]} — TikTok's canonical multi-CDN mirror list
 *    (same image, different edge hosts for redundancy)
 *  - {thumb_url_list: [...]} — thumbnail variants
 *  - {uri: "tos-alisg-i-.../<hash>~..."} — bare TikTok Object Storage
 *    URIs which we don't try to resolve (need signing) but log
 *  - Product image objects: {images: [{url_list: [...]}, ...]}
 *
 *  For url_list mirrors, we only keep the FIRST URL per list to
 *  avoid the same image appearing 3-5 times in the gallery.
 *
 *  Capped at 12 to leave headroom for a rich gallery without
 *  hoarding.
 */
function pluckImageUrls(d: Record<string, unknown>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    found.push(u);
  };
  collectImageUrls(d, push, 0);
  return found.slice(0, 12);
}

function collectImageUrls(
  v: unknown,
  push: (u: string) => void,
  depth: number,
): void {
  if (depth > 10) return;
  if (v === null || v === undefined) return;
  if (typeof v === "string") {
    if (looksLikeImageUrl(v)) push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) collectImageUrls(item, push, depth + 1);
    return;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Fast-path the common object shapes so we don't miss a
    // singular url when a sibling key throws off the recursive walk.
    const singleUrl = firstString(o.url, o.URL, o.image_url, o.imageUrl);
    if (singleUrl && looksLikeImageUrl(singleUrl)) push(singleUrl);
    // url_list / thumb_url_list / uri_list are TikTok's mirror
    // arrays — same image at different CDN edges. Take only the
    // first URL per list so the gallery doesn't fill with dupes.
    const mirrorLists = [
      o.url_list,
      o.urlList,
      o.thumb_url_list,
      o.thumbUrlList,
      o.uri_list,
    ];
    for (const list of mirrorLists) {
      if (Array.isArray(list)) {
        for (const u of list) {
          if (typeof u === "string" && looksLikeImageUrl(u)) {
            push(u);
            break; // only first mirror
          }
        }
      }
    }
    // Then recurse into everything so we catch nested {images: [...]}
    // and {sku: [{image: {url_list: [...]}}]} shapes.
    for (const val of Object.values(o)) {
      collectImageUrls(val, push, depth + 1);
    }
  }
}

/** Return the first argument that's a non-empty string, else null.
 *  Used to pick between synonym keys (url vs URL vs image_url etc). */
function firstString(...vs: unknown[]): string | null {
  for (const v of vs) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/** Very permissive URL matcher. TikTok CDN hosts span dozens of
 *  patterns (tiktokcdn, tiktokcdn-us, tiktokcdn-sg, byteimg,
 *  ibyteimg, ibytedtos, ttwstatic, tos-*, p16-*, p-tt*, ipstatp,
 *  byteoss, muscdn, snssdk-*). Rather than allowlisting every
 *  known TikTok host, we accept ANY https URL that either:
 *    - has a common image extension in the path
 *    - contains "image", "img", "photo", "pic" in the path/host
 *    - matches a known TikTok/ByteDance CDN host substring
 *
 *  Downstream code just uses these as <img src>, so a false
 *  positive renders as a broken thumbnail — safer to over-collect
 *  than to under-collect. */
function looksLikeImageUrl(s: string): boolean {
  if (!s.startsWith("http")) return false;
  if (s.length > 800) return false;
  if (/\.(jpe?g|png|webp|gif|avif|heic)(\?|#|$)/i.test(s)) return true;
  if (
    /(tiktokcdn|byteimg|ibyteimg|ibytedtos|ttwstatic|byteoss|muscdn|snssdk|ipstatp)/i.test(
      s,
    )
  )
    return true;
  if (/\/(image|img|photo|photos|pic|pics|cover|thumb)\//i.test(s)) return true;
  if (/[?&](image|img|url)=/i.test(s)) return true;
  return false;
}

/** Pluck a source description string. TikHub returns product
 *  descriptions in a few different shapes; we accept a plain
 *  string, an object with a text/content field, or an HTML blob
 *  that we strip tags from. Returned string is capped at 2000
 *  chars for storage sanity. */
function pluckSourceDescription(d: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    d.description,
    d.product_description,
    d.desc,
    d.detail,
    d.product_desc,
  ];
  for (const c of candidates) {
    const text = extractDescriptionText(c);
    if (text) return text.slice(0, 2000);
  }
  return null;
}

function extractDescriptionText(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    return stripHtml(v).trim() || null;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const nested =
      (typeof o.text === "string" && o.text) ||
      (typeof o.content === "string" && o.content) ||
      (typeof o.value === "string" && o.value) ||
      (typeof o.rich_text === "string" && o.rich_text);
    if (nested) return stripHtml(nested).trim() || null;
  }
  return null;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * fetch_general_search_result — count of creator videos matching a
 * product name. The "creator saturation" signal for BOF Score.
 * Docs cap count at 30 per call; we ask for 30 and use the total-
 * results field (when present) or fall back to the returned array
 * length as a coarser floor.
 */
export async function getProductCreatorCount(
  productName: string,
): Promise<number> {
  if (!productName || !productName.trim()) return 0;
  const raw = await postTikHubShop(ENDPOINTS.generalSearch, {
    keyword: productName.trim(),
    count: 30,
  });
  if (!raw || typeof raw !== "object") return 0;
  const r = raw as Record<string, unknown>;
  const data = (r.data ?? r) as Record<string, unknown>;
  // TikHub sometimes surfaces a total (has_more + cursor + total-ish
  // fields), sometimes not. Try total → total_count → the actual
  // array length as fallback.
  const total = num(
    data.total ?? data.total_count ?? data.result_count,
  );
  if (total > 0) return total;
  const items =
    (Array.isArray(data.data) && data.data) ||
    (Array.isArray(data.videos) && data.videos) ||
    (Array.isArray(data.results) && data.results) ||
    [];
  return items.length;
}
