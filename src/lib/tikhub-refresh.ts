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
    if (opts.includeProducts) {
      const products = await tikhub.getProductAnalytics({ cookie });
      for (const p of products) {
        if (!p.externalId) continue;
        await db.tikTokProduct.upsert({
          where: {
            accountId_externalId: {
              accountId: row.id,
              externalId: p.externalId,
            },
          },
          create: {
            accountId: row.id,
            externalId: p.externalId,
            title: p.title,
            gmv: p.gmv,
            itemsSold: p.itemsSold,
            commission: p.commission,
          },
          update: {
            title: p.title,
            gmv: p.gmv,
            itemsSold: p.itemsSold,
            commission: p.commission,
            capturedAt: new Date(),
          },
        });
        productsCaptured++;
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
