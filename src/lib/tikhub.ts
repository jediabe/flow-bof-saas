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
  const maxPages = input.maxPages ?? 10;
  const allRows: ProductAnalyticsRow[] = [];
  let page = 1;
  while (page <= maxPages) {
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
