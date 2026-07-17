/**
 * Single source of truth for "refresh ONE TikTokAccount's data from
 * TikHub and persist it." Both surfaces hit this:
 *
 *   - Manual button on /settings/tiktok-accounts → refreshTikTokAccountNow
 *   - Scheduled cron at /api/cron/{health-and-revenue,products}
 *
 * Why a shared helper:
 *   - Keeps the cookie-decrypt + TikHub-call + DB-write pattern
 *     identical between manual and scheduled refreshes (no drift).
 *   - The cookieStatus / cookieError write semantics live in one
 *     place. A 401 from TikHub flips the account to "expired"
 *     consistently regardless of who triggered the refresh.
 *   - P&L derivation (commission − prorated tool cost = net profit)
 *     also lives here so a manual refresh produces a fresh P&L row.
 *
 * Tenancy: callers MUST pass workspaceId so the SQL find query
 * scopes correctly. The function refuses to refresh an account
 * whose workspaceId doesn't match — defence in depth against a
 * caller forgetting to gate.
 */

import { db } from "@/lib/db";
import { decryptCookie } from "@/lib/tikhub-crypto";
import * as tikhub from "@/lib/tikhub";
import { encodeJson } from "@/lib/json-column";

const COOKIE_ERROR_MAX_LEN = 500;
const DAYS_IN_MONTH_PRORATION = 30;

export interface RefreshOptions {
  accountId: string;
  workspaceId: string;
  /** When true, also refresh the per-product table. Cron's
   *  health-and-revenue path skips this; the daily products cron
   *  + the manual button include it. */
  includeProducts: boolean;
}

export interface RefreshResult {
  ok: boolean;
  message: string;
  /** What we actually wrote. Surfaced in the manual-refresh toast
   *  so the operator can spot when "Refresh succeeded" actually
   *  meant "TikHub returned 0 buckets of data". */
  detail?: {
    healthCaptured: boolean;
    revenueBucketsWritten: number;
    productsCaptured: number;
  };
}

export async function refreshAccountSnapshot(
  opts: RefreshOptions,
): Promise<RefreshResult> {
  const row = await db.tikTokAccount.findFirst({
    where: { id: opts.accountId, workspaceId: opts.workspaceId },
    select: {
      id: true,
      label: true,
      cookieRaw: true,
      monthlyToolCost: true,
    },
  });
  if (!row) return { ok: false, message: "Account not found in this workspace." };

  // Decrypt — failure here means key rotated without re-encrypting
  // or the row was tampered with. Flag the account as errored.
  let cookie: string;
  try {
    cookie = decryptCookie(row.cookieRaw);
  } catch (err) {
    const e = err as Error;
    await markCookieError(row.id, `Decrypt failed: ${e.message}`);
    return {
      ok: false,
      message: `Stored cookie could not be decrypted for "${row.label}". Re-paste from TikTok.`,
    };
  }

  // Fetch in sequence (small N — at most three TikHub calls per
  // refresh) so we don't burn TikHub's per-key concurrency budget.
  let healthCaptured = false;
  let revenueBucketsWritten = 0;
  let productsCaptured = 0;

  try {
    // 1. Health — cheapest TikHub call; also doubles as cookie validity probe.
    const health = await tikhub.getAccountHealth({ cookie });
    await db.tikTokAccountHealth.create({
      data: {
        accountId: row.id,
        status: health.status,
        violationScore: health.violationScore,
        restrictions:
          health.restrictions.length > 0
            ? encodeJson(health.restrictions)
            : null,
      },
    });
    healthCaptured = true;

    // 2. Per-day series from BOTH analytics endpoints. We merge by
    //    date so each DB row has both content metrics (views /
    //    followers / videos posted, from video_analytics_summary)
    //    AND sales metrics (total GMV, commission, live-vs-video
    //    split, from account_insights_overview).
    //
    //    Why both: video_summary only sees video-attributed GMV
    //    and misses live + direct-shop revenue. insights_overview
    //    is the source of truth for total sales but doesn't
    //    expose video view counts. They complement.
    const [contentSeries, salesSeries] = await Promise.all([
      tikhub.getCreatorTimeSeries({ cookie }),  // views/followers/videoCount
      // Multi-month insights — one TikHub call per calendar month
      // because the endpoint returns "month containing start_date"
      // only. Two months covers the 30-day dashboard window even
      // when today is early in the month. Bump if we expose wider
      // windows later.
      tikhub.getCreatorInsightsMultiMonth({ cookie, monthCount: 2 }),
    ]);

    // Index sales buckets by ISO date string so we can join by day.
    const salesByDate = new Map<string, typeof salesSeries[number]>();
    for (const s of salesSeries) {
      salesByDate.set(midnightUtc(s.date).toISOString(), s);
    }
    const contentByDate = new Map<string, typeof contentSeries[number]>();
    for (const c of contentSeries) {
      contentByDate.set(midnightUtc(c.date).toISOString(), c);
    }
    // Union of dates from either source.
    const allDateKeys = new Set<string>([
      ...salesByDate.keys(),
      ...contentByDate.keys(),
    ]);

    // 3. P&L per day — derived: gross commission − prorated tool
    //    cost (daily = monthlyCost / 30). Written alongside each
    //    revenue row.
    const monthlyCost = Number(row.monthlyToolCost ?? 0);
    const dailyCost = monthlyCost > 0 ? monthlyCost / DAYS_IN_MONTH_PRORATION : 0;

    for (const dateKey of allDateKeys) {
      const dateMidnightUtc = new Date(dateKey);
      const sales = salesByDate.get(dateKey);
      const content = contentByDate.get(dateKey);

      const gmv                 = sales?.gmv ?? content?.gmv ?? 0;
      const currencyCode        = sales?.currencyCode ?? content?.currencyCode ?? "USD";
      const estimatedCommission = sales?.estimatedCommission ?? 0;
      const videoRevenue        = sales?.videoRevenue ?? 0;
      const liveRevenue         = sales?.liveRevenue ?? 0;
      const itemsSold           = sales?.itemsSold ?? content?.itemsSold ?? 0;
      const videoViews          = content?.videoViews ?? 0;
      const newFollowerCount    = content?.newFollowerCount ?? 0;
      const videoCount          = content?.videoCount ?? 0;

      await db.tikTokAccountRevenue.upsert({
        where: {
          accountId_date: {
            accountId: row.id,
            date: dateMidnightUtc,
          },
        },
        create: {
          accountId: row.id,
          date: dateMidnightUtc,
          gmv,
          currencyCode,
          estimatedCommission,
          videoRevenue,
          liveRevenue,
          itemsSold,
          videoViews,
          newFollowerCount,
          videoCount,
        },
        update: {
          gmv,
          currencyCode,
          estimatedCommission,
          videoRevenue,
          liveRevenue,
          itemsSold,
          videoViews,
          newFollowerCount,
          videoCount,
          capturedAt: new Date(),
        },
      });

      revenueBucketsWritten++;

      const netProfit = estimatedCommission - dailyCost;
      await db.tikTokAccountPnl.upsert({
        where: {
          accountId_date: {
            accountId: row.id,
            date: dateMidnightUtc,
          },
        },
        create: {
          accountId: row.id,
          date: dateMidnightUtc,
          grossCommission: estimatedCommission,
          toolCost: dailyCost,
          netProfit,
        },
        update: {
          grossCommission: estimatedCommission,
          toolCost: dailyCost,
          netProfit,
          capturedAt: new Date(),
        },
      });
    }

    // 4. Per-product refresh — only when caller asked for it
    //    (manual button + daily cron; not the 6-hourly cron).
    //
    //    We use the DAILY-granularity variant of the video↔product
    //    attribution chain (getProductAttributionDaily). This
    //    returns per-day buckets from the finest-granularity
    //    segment of get_video_to_product_stats. Persisted to
    //    TikTokProductDaily so analytics queries can window-filter
    //    at render time and match Creator Center's exact window
    //    (7D, 30D, etc.).
    //
    //    TikTokProduct is still upserted here to hold product
    //    METADATA (title, thumbnail, currency) — its stats fields
    //    become "sum-in-window" derived at read time, but we keep
    //    them updated with a lifetime/current-cycle snapshot for
    //    quick single-row queries.
    if (opts.includeProducts) {
      // Timestamp captured BEFORE any product writes. Every upsert
      // below stamps capturedAt = now; rows still bearing an older
      // capturedAt after the refresh finishes are stale carryover
      // from a previous cookie (e.g. when this account was
      // accidentally sharing a cookie with a sibling) and get
      // pruned. Without this, updating a cookie leaves ghost rows
      // that show up on the aggregate view with data from the
      // wrong TikTok account.
      const productsRefreshStartedAt = new Date();

      const { products, monthTotals } = await tikhub.getProductAttributionDaily({
        cookie,
        maxVideos: 25,
        maxPairs:  60,
      });
      // Also fetch LAST month's totals in parallel so the 30-day
      // dashboard window has both months available. One extra
      // paginated video-list walk per refresh — a real cost, but
      // it's the only way for a mid-month 30d view to reflect
      // the last calendar month without adding a full second
      // pair-chain.
      const prevMonthTotals = await tikhub.getAccountMonthTotals({
        cookie,
        monthAnchor: tikhub.firstOfPrevMonthUS(),
      });
      // Persist the account-level month totals from the
      // paginated video-list. These are the trustworthy "this
      // month" numbers the operator compares to their TikTok
      // Creator Center — the account-level insights endpoint
      // often lags a day, but the video-list pagination adds up
      // to the ground truth.
      await db.tikTokAccount.update({
        where: { id: row.id },
        data: {
          currentMonthGmv:        monthTotals.gmv,
          currentMonthDirectGmv:  monthTotals.directGmv,
          currentMonthItemsSold:  monthTotals.itemsSold,
          currentMonthCurrency:   monthTotals.currencyCode,
          currentMonthAnchor:     monthTotals.monthAnchor,
          currentMonthCapturedAt: new Date(),
          previousMonthGmv:        prevMonthTotals.gmv,
          previousMonthDirectGmv:  prevMonthTotals.directGmv,
          previousMonthItemsSold:  prevMonthTotals.itemsSold,
          previousMonthCurrency:   prevMonthTotals.currencyCode,
          previousMonthAnchor:     prevMonthTotals.monthAnchor,
          previousMonthCapturedAt: new Date(),
        },
      });
      for (const p of products) {
        if (!p.externalId) continue;
        // Metadata upsert — sum this cycle's buckets for the
        // snapshot totals on the parent row.
        const cycleGmv        = p.buckets.reduce((a, b) => a + b.gmv,           0);
        const cycleItems      = p.buckets.reduce((a, b) => a + b.itemsSold,     0);
        const cycleViews      = p.buckets.reduce((a, b) => a + b.productViews,  0);
        const cycleClicks     = p.buckets.reduce((a, b) => a + b.productClicks, 0);
        const cycleOrders     = p.buckets.reduce((a, b) => a + b.orderCount,    0);
        await db.tikTokProduct.upsert({
          where: {
            accountId_externalId: {
              accountId: row.id,
              externalId: p.externalId,
            },
          },
          create: {
            accountId:     row.id,
            externalId:    p.externalId,
            title:         p.title,
            gmv:           cycleGmv,
            currencyCode:  p.currencyCode,
            itemsSold:     cycleItems,
            commission:    0,
            productViews:  cycleViews,
            productClicks: cycleClicks,
            orderCount:    cycleOrders,
          },
          update: {
            title:         p.title,
            gmv:           cycleGmv,
            currencyCode:  p.currencyCode,
            itemsSold:     cycleItems,
            productViews:  cycleViews,
            productClicks: cycleClicks,
            orderCount:    cycleOrders,
            capturedAt:    new Date(),
          },
        });
        productsCaptured++;

        // Per-day buckets — upsert by (account, product, date).
        // pluckPairStatsDaily already dropped zero-value days;
        // remaining rows are all meaningful. Existing rows for
        // matching dates get updated in place; new dates get
        // inserted; days that used to have data but no longer do
        // stay in the DB (harmless, they still sum to their
        // captured values).
        for (const b of p.buckets) {
          await db.tikTokProductDaily.upsert({
            where: {
              accountId_externalId_date: {
                accountId:  row.id,
                externalId: p.externalId,
                date:       b.date,
              },
            },
            create: {
              accountId:     row.id,
              externalId:    p.externalId,
              date:          b.date,
              gmv:           b.gmv,
              currencyCode:  p.currencyCode,
              itemsSold:     b.itemsSold,
              orderCount:    b.orderCount,
              productViews:  b.productViews,
              productClicks: b.productClicks,
            },
            update: {
              gmv:           b.gmv,
              currencyCode:  p.currencyCode,
              itemsSold:     b.itemsSold,
              orderCount:    b.orderCount,
              productViews:  b.productViews,
              productClicks: b.productClicks,
              capturedAt:    new Date(),
            },
          });
        }
      }

      // 5. get_product_analytics_list — the operator-verified
      //    authoritative source for per-product item_sold_cnt AND
      //    commission. Called with a BROAD date range (one year
      //    back → first-of-next-month, exclusive) so every
      //    product the creator has promoted this year shows up,
      //    with its lifetime-in-window commission and units
      //    sold.
      //
      //    Results overwrite the metadata written by the pair
      //    chain above — the pair chain gives per-day granularity
      //    via TikTokProductDaily but doesn't return commission,
      //    while this endpoint returns commission but only
      //    per-product totals for the range. We keep both writes
      //    to have both dimensions.
      const nowRefresh = new Date();
      const oneYearAgo = new Date(
        Date.UTC(nowRefresh.getUTCFullYear() - 1, nowRefresh.getUTCMonth(), 1),
      );
      const nextMonthStart = new Date(
        Date.UTC(nowRefresh.getUTCFullYear(), nowRefresh.getUTCMonth() + 1, 1),
      );
      // Track whether the broad-window analytics_list call
      // succeeded. Only then can we safely prune stale rows —
      // pair-chain alone covers only the current month, so
      // pruning based on pair-chain-only writes would delete
      // legitimate older products.
      let analyticsListOk = false;
      try {
        const productAnalyticsRows = await tikhub.getProductAnalytics({
          cookie,
          startDate: oneYearAgo,
          endDate:   nextMonthStart,
          maxPages:  30,
        });
        for (const p of productAnalyticsRows) {
          if (!p.externalId) continue;
          await db.tikTokProduct.upsert({
            where: {
              accountId_externalId: {
                accountId: row.id,
                externalId: p.externalId,
              },
            },
            create: {
              accountId:     row.id,
              externalId:    p.externalId,
              title:         p.title,
              gmv:           p.gmv,
              currencyCode:  p.currencyCode,
              itemsSold:     p.itemsSold,
              commission:    p.commission,
              productViews:  0,
              productClicks: 0,
              orderCount:    0,
            },
            update: {
              title:         p.title,
              gmv:           p.gmv,
              currencyCode:  p.currencyCode,
              itemsSold:     p.itemsSold,
              commission:    p.commission,
              capturedAt:    new Date(),
            },
          });
        }
        analyticsListOk = true;
      } catch {
        // Non-fatal — pair-chain metadata already covers the row.
        // TikHub can occasionally 429 the analytics list endpoint
        // on refresh-heavy cycles; keep going. Skip the prune so
        // legitimate older rows aren't nuked.
      }

      // Prune stale product rows — anything for THIS account whose
      // capturedAt is older than the moment this refresh started.
      // Fresh writes above stamped capturedAt = new Date() (or the
      // DB @default on create), all strictly after
      // productsRefreshStartedAt, so they survive; rows written by
      // a previous refresh — potentially against a different cookie
      // still attached to this same account row — are pruned. This
      // is what stops "cookie was accidentally shared, then fixed"
      // from leaving ghost products that read as duplicated data
      // across two accounts on the aggregate view.
      //
      // Only prune when analytics_list succeeded, because that's
      // the broad-window (~1 year) pull. Pair-chain-only refreshes
      // cover only the current month.
      if (analyticsListOk) {
        await db.tikTokProduct.deleteMany({
          where: {
            accountId: row.id,
            capturedAt: { lt: productsRefreshStartedAt },
          },
        });
      }
    }

    // All TikHub calls succeeded → mark the cookie active.
    await db.tikTokAccount.update({
      where: { id: row.id },
      data: {
        cookieStatus: "active",
        cookieError: null,
        lastCheckedAt: new Date(),
      },
    });

    return {
      ok: true,
      message:
        `Refreshed "${row.label}": ${revenueBucketsWritten} day` +
        (revenueBucketsWritten === 1 ? "" : "s") +
        (opts.includeProducts ? `, ${productsCaptured} product${productsCaptured === 1 ? "" : "s"}` : ""),
      detail: { healthCaptured, revenueBucketsWritten, productsCaptured },
    };
  } catch (err) {
    if (tikhub.isCookieExpired(err)) {
      await markCookieError(row.id, "Cookie expired or rejected (401/428).");
      return {
        ok: false,
        message: `"${row.label}" cookie expired. Re-paste from TikTok and Test Cookie again.`,
      };
    }
    const e = err as Error;
    await markCookieError(
      row.id,
      `${e.name}: ${(e.message || "unknown").slice(0, 250)}`,
    );
    return {
      ok: false,
      message: `Refresh failed for "${row.label}": ${e.message}`,
      detail: { healthCaptured, revenueBucketsWritten, productsCaptured },
    };
  }
}

async function markCookieError(
  accountId: string,
  message: string,
): Promise<void> {
  await db.tikTokAccount.update({
    where: { id: accountId },
    data: {
      cookieStatus: message.includes("expired") ? "expired" : "error",
      cookieError: message.slice(0, COOKIE_ERROR_MAX_LEN),
      lastCheckedAt: new Date(),
    },
  });
}

function midnightUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
