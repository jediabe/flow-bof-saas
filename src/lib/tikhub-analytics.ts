/**
 * Shared analytics helpers for the BOF Dashboard pages.
 *
 * Centralises the date-range math, money formatting, and the
 * aggregator that rolls many TikTokAccountRevenue rows up into a
 * single header summary. Used by both the aggregate /analytics
 * page and the per-account /analytics/[accountId] page.
 *
 * Time windows are computed in UTC because the underlying
 * revenue rows store UTC-midnight dates (see lib/tikhub-refresh.ts).
 * Mixing local time would produce off-by-one-day errors when
 * crossing midnight.
 */

export type Window = "today" | "7d" | "30d";

export interface WindowRange {
  /** Inclusive lower bound (UTC midnight). */
  start: Date;
  /** Exclusive upper bound (UTC midnight of next day after the window). */
  endExclusive: Date;
  /** Number of whole days the window covers. */
  days: number;
}

export function windowRange(w: Window, now: Date = new Date()): WindowRange {
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const endExclusive = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const days = w === "today" ? 1 : w === "7d" ? 7 : 30;
  const start = new Date(endExclusive.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, endExclusive, days };
}

export interface RevenueRow {
  gmv: number | string | { toString(): string };
  currencyCode?: string | null;
  estimatedCommission: number | string | { toString(): string };
  videoRevenue: number | string | { toString(): string };
  liveRevenue: number | string | { toString(): string };
  itemsSold: number;
  videoViews?: number | null;
  newFollowerCount?: number | null;
  videoCount?: number | null;
}

export interface RevenueTotals {
  gmv: number;
  /** Picked from the rows summed — first non-empty currency code
   *  wins, falls back to "USD". Mixed-currency totals are
   *  flagged via `currencyMixed` so the UI can downgrade the
   *  display (we never auto-convert; that would lie). */
  currencyCode: string;
  currencyMixed: boolean;
  estimatedCommission: number;
  videoRevenue: number;
  liveRevenue: number;
  itemsSold: number;
  videoViews: number;
  newFollowerCount: number;
  videoCount: number;
}

/**
 * Sum revenue rows into a single totals object. Accepts Prisma's
 * Decimal field (arrives as Decimal/string depending on the
 * driver) by coercing via Number(.toString()). Includes the
 * content-side counters (views / new followers / videos posted)
 * for affiliate accounts that have no sales yet — those metrics
 * are what the dashboard leads with when GMV is zero.
 */
export function sumRevenue(rows: RevenueRow[]): RevenueTotals {
  let currencyCode = "";
  let currencyMixed = false;
  const totals = rows.reduce<{
    gmv: number;
    estimatedCommission: number;
    videoRevenue: number;
    liveRevenue: number;
    itemsSold: number;
    videoViews: number;
    newFollowerCount: number;
    videoCount: number;
  }>(
    (acc, r) => {
      acc.gmv                 += toNum(r.gmv);
      acc.estimatedCommission += toNum(r.estimatedCommission);
      acc.videoRevenue        += toNum(r.videoRevenue);
      acc.liveRevenue         += toNum(r.liveRevenue);
      acc.itemsSold           += Number(r.itemsSold ?? 0);
      acc.videoViews          += Number(r.videoViews ?? 0);
      acc.newFollowerCount    += Number(r.newFollowerCount ?? 0);
      acc.videoCount          += Number(r.videoCount ?? 0);
      const code = (r.currencyCode || "").trim();
      if (code) {
        if (!currencyCode) currencyCode = code;
        else if (currencyCode !== code) currencyMixed = true;
      }
      return acc;
    },
    {
      gmv: 0,
      estimatedCommission: 0,
      videoRevenue: 0,
      liveRevenue: 0,
      itemsSold: 0,
      videoViews: 0,
      newFollowerCount: 0,
      videoCount: 0,
    },
  );
  return {
    ...totals,
    currencyCode: currencyCode || "USD",
    currencyMixed,
  };
}

export interface PnlRow {
  grossCommission: number | string | { toString(): string };
  toolCost: number | string | { toString(): string };
  netProfit: number | string | { toString(): string };
}

export interface PnlTotals {
  grossCommission: number;
  toolCost: number;
  netProfit: number;
  /** netProfit / grossCommission, 0-1. 0 when grossCommission is 0. */
  marginRatio: number;
}

export function sumPnl(rows: PnlRow[]): PnlTotals {
  const totals = rows.reduce<{
    grossCommission: number;
    toolCost: number;
    netProfit: number;
  }>(
    (acc, r) => {
      acc.grossCommission += toNum(r.grossCommission);
      acc.toolCost        += toNum(r.toolCost);
      acc.netProfit       += toNum(r.netProfit);
      return acc;
    },
    { grossCommission: 0, toolCost: 0, netProfit: 0 },
  );
  return {
    ...totals,
    marginRatio: totals.grossCommission > 0
      ? totals.netProfit / totals.grossCommission
      : 0,
  };
}

/** Format a USD amount as $1,234.56. Returns "—" for non-numeric
 *  inputs. Kept for callers that have no currency context. */
export function formatUsd(n: number | null | undefined): string {
  return formatMoney(n, "USD");
}

/** Currency-aware money formatter. Pass the ISO 4217 code (e.g.
 *  "GBP") and the locale-aware Intl formatter picks the symbol +
 *  fraction digits. Falls back to USD for invalid codes. */
export function formatMoney(
  n: number | null | undefined,
  currencyCode: string | null | undefined,
): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const code = (currencyCode || "USD").toUpperCase();
  try {
    return n.toLocaleString("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    // Bad currency code — fall back to numeric formatting with
    // the code as a prefix so the user still sees a value.
    return `${code} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export function formatPercent(ratio: number | null | undefined, fractionDigits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  // Prisma Decimal — has a toString() that returns a parseable string.
  if (typeof v === "object" && v && typeof (v as { toString: () => string }).toString === "function") {
    const n = Number((v as { toString: () => string }).toString());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Map a numeric violation score (0-100) onto a UI tone. Used for
 * the account-health chip across both the aggregate and per-account
 * pages so the colour stays consistent.
 */
export function healthTone(status: string, violationScore: number): "ok" | "warn" | "bad" | "muted" {
  if (status === "restricted") return "bad";
  if (status === "flagged" || violationScore >= 30) return "warn";
  if (status === "healthy") return "ok";
  return "muted";
}
