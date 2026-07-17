import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentWorkspace } from "@/lib/workspace";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json-column";
import Panel from "@/components/ui/Panel";
import MetricCard from "@/components/ui/MetricCard";
import StatusChip from "@/components/StatusChip";
import EmptyState from "@/components/ui/EmptyState";
import {
  windowRange,
  sumRevenue,
  sumPnl,
  formatUsd,
  formatMoney,
  formatPercent,
  formatInt,
  healthTone,
  type Window,
} from "@/lib/tikhub-analytics";

/**
 * BOF Dashboard — single-account detail.
 *
 * Drilldown from the aggregate /analytics page. Same data sources,
 * scoped to one accountId. The page is read-only; account edits +
 * cookie re-pasting happen in /settings/tiktok-accounts.
 */

export const dynamic = "force-dynamic";

export default async function AccountAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ window?: string }>;
}) {
  const [{ workspace }, { accountId }, sp] = await Promise.all([
    getCurrentWorkspace(),
    params,
    searchParams,
  ]);
  const windowKey: Window =
    sp.window === "today" || sp.window === "30d" ? sp.window : "7d";
  const range = windowRange(windowKey);

  const account = await db.tikTokAccount.findFirst({
    where: { id: accountId, workspaceId: workspace.id },
    select: {
      id: true,
      label: true,
      region: true,
      monthlyToolCost: true,
      cookieStatus: true,
      cookieError: true,
      lastCheckedAt: true,
      createdAt: true,
      // Monthly snapshot from the video-list paginator — the
      // authoritative source for "this month" GMV / items sold.
      currentMonthGmv: true,
      currentMonthDirectGmv: true,
      currentMonthItemsSold: true,
      currentMonthCurrency: true,
      currentMonthAnchor: true,
      currentMonthCapturedAt: true,
      previousMonthGmv: true,
      previousMonthDirectGmv: true,
      previousMonthItemsSold: true,
      previousMonthCurrency: true,
      previousMonthAnchor: true,
      previousMonthCapturedAt: true,
    },
  });
  if (!account) notFound();

  const [revenue, pnl, productGroups, productMeta, healthHistory] = await Promise.all([
    db.tikTokAccountRevenue.findMany({
      where: {
        accountId,
        date: { gte: range.start, lt: range.endExclusive },
      },
      orderBy: [{ date: "asc" }],
    }),
    db.tikTokAccountPnl.findMany({
      where: {
        accountId,
        date: { gte: range.start, lt: range.endExclusive },
      },
      orderBy: [{ date: "asc" }],
    }),
    // Per-product totals from get_product_analytics_list (via
    // TikTokProduct). Operator confirmed this endpoint returns
    // authoritative item_sold_cnt and commission per product for
    // the current calendar month, so we show whatever's in that
    // table without window-filtering (window toggle affects the
    // account-level cards; the products list is always "this
    // month's product performance").
    db.tikTokProduct.findMany({
      where: { accountId },
      orderBy: [{ itemsSold: "desc" }, { gmv: "desc" }],
      select: {
        externalId: true,
        title: true,
        currencyCode: true,
        gmv: true,
        itemsSold: true,
        commission: true,
      },
    }),
    // No separate metadata query needed — combined into the row
    // above. Passthrough to preserve the destructure.
    Promise.resolve([] as Array<never>),
    db.tikTokAccountHealth.findMany({
      where: { accountId },
      orderBy: [{ capturedAt: "desc" }],
      take: 10,
    }),
  ]);

  const totalRev = sumRevenue(revenue);
  const totalPnl = sumPnl(pnl);
  const latestHealth = healthHistory[0] ?? null;

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs text-muted mb-1">
            <Link href="/analytics" className="hover:text-text">
              ← All accounts
            </Link>
          </div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <h1 className="h-page">{account.label}</h1>
            <StatusChip label={account.region} variant="muted" />
            {latestHealth && (
              <StatusChip
                label={`${latestHealth.status} · score ${latestHealth.violationScore}`}
                variant={healthTone(
                  latestHealth.status,
                  latestHealth.violationScore,
                )}
              />
            )}
            {account.cookieStatus !== "active" && (
              <StatusChip
                label={`cookie: ${account.cookieStatus}`}
                variant="bad"
              />
            )}
          </div>
          <div className="text-xs text-muted mt-1">
            tool cost ${Number(account.monthlyToolCost).toFixed(2)}/mo ·
            last checked{" "}
            {account.lastCheckedAt
              ? new Date(account.lastCheckedAt).toLocaleString()
              : "never"}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <WindowLink current={windowKey} target="today" label="Today" accountId={accountId} />
          <WindowLink current={windowKey} target="7d" label="7d" accountId={accountId} />
          <WindowLink current={windowKey} target="30d" label="30d" accountId={accountId} />
        </div>
      </header>

      {/* Cookie health warning. Mirrors what the settings page
          shows so the user doesn't have to switch surfaces to
          understand why data is stale. */}
      {account.cookieStatus !== "active" && (
        <Panel variant="ghost">
          <div className="rounded-2xl border border-bad/40 bg-bad/[0.08] px-4 py-3 text-sm text-bad">
            <div className="font-medium mb-1">
              Cookie is {account.cookieStatus}. Analytics may be stale.
            </div>
            <p className="text-xs leading-relaxed text-bad/90">
              {account.cookieError ??
                "Re-paste the TikTok Shop session cookie on the accounts page to resume refreshes."}{" "}
              <Link
                href="/settings/tiktok-accounts"
                className="underline"
              >
                Go to accounts →
              </Link>
            </p>
          </div>
        </Panel>
      )}

      {/* Content metrics — lead row. Meaningful even for
          content-only accounts (no sales yet). */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricCard
          label={`Video views · ${windowLabel(windowKey)}`}
          value={formatInt(totalRev.videoViews)}
          hint={`avg ${formatInt(Math.round(totalRev.videoViews / Math.max(1, totalRev.videoCount)))}/video`}
          tone="accent"
        />
        <MetricCard
          label="New followers"
          value={formatInt(totalRev.newFollowerCount)}
          hint={`${windowLabel(windowKey)} window`}
        />
        <MetricCard
          label="Videos posted"
          value={formatInt(totalRev.videoCount)}
          hint={`${windowLabel(windowKey)} window`}
        />
        <MetricCard
          label="Items sold"
          value={formatInt(totalRev.itemsSold)}
          hint={`${windowLabel(windowKey)} window`}
        />
      </div>

      {/* Revenue + P&L — second row. GMV and net profit come from
          the video-list snapshot (currentMonth* on the account
          row), which is written by the products refresh from
          summing per-video month totals across all pages of
          get_video_list_analytics. That's a fresher, more
          reliable source than summing the daily insights buckets
          (which lag today's activity). Est. commission stays as
          the derived take-rate calc since the video-list
          endpoint doesn't report commission. */}
      {(() => {
        // Money cards = whatever get_account_insights_overview
        // returned for the window, straight-through. No proration,
        // no derivation, no video-list adjustment. If TikHub lags
        // for today, today shows what TikHub says (usually 0) —
        // honest to what the endpoint reports.
        const currencyCode = totalRev.currencyCode;
        const daysInWindow =
          windowKey === "today" ? 1 : windowKey === "7d" ? 7 : 30;
        const salesGmv        = totalRev.gmv;
        const salesItems      = totalRev.itemsSold;
        const salesCommission = totalRev.estimatedCommission;
        const monthlyCost     = Number(account.monthlyToolCost ?? 0);
        const costForWindow   = monthlyCost * (daysInWindow / 30);
        const salesNetProfit  = salesCommission - costForWindow;
        const salesMargin     = salesCommission > 0
          ? salesNetProfit / salesCommission
          : 0;
        const salesWindowLabel =
          windowKey === "today" ? "today"
          : windowKey === "7d"  ? "last 7 days"
          : "last 30 days";
        return (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricCard
          label={`GMV · ${salesWindowLabel} · ${currencyCode}`}
          value={formatMoney(salesGmv, currencyCode)}
          hint={`${formatInt(salesItems)} items`}
        />
        <MetricCard
          label={`Est. commission · ${salesWindowLabel}`}
          value={formatMoney(salesCommission, currencyCode)}
          hint={
            salesGmv > 0
              ? `take rate ${formatPercent(salesCommission / salesGmv)}`
              : "no GMV in window yet"
          }
        />
        <MetricCard
          label={`Net profit · ${salesWindowLabel}`}
          value={formatMoney(salesNetProfit, currencyCode)}
          hint={`tool cost ${formatMoney(costForWindow, currencyCode)} (${daysInWindow}d)`}
          tone={salesNetProfit > 0 ? "ok" : salesNetProfit < 0 ? "bad" : "muted"}
        />
        <MetricCard
          label={`Net margin · ${salesWindowLabel}`}
          value={formatPercent(salesMargin)}
          hint="net profit / commission"
        />
        </div>
        );
      })()}

      {/* Daily breakdown */}
      <Panel title={`Daily breakdown · ${windowLabel(windowKey)}`}>
        {revenue.length === 0 ? (
          <EmptyState
            icon="◌"
            title="No data captured in this window yet"
            hint="The 6-hour cron populates this. You can also click 'Refresh now' on the accounts page."
          />
        ) : (
          <DailyTable
            rows={revenue.map((r) => ({
              date: r.date,
              gmv: Number(r.gmv ?? 0),
              currencyCode: r.currencyCode ?? "USD",
              estimatedCommission: Number(r.estimatedCommission ?? 0),
              videoViews: r.videoViews ?? 0,
              newFollowerCount: r.newFollowerCount ?? 0,
              videoCount: r.videoCount ?? 0,
              itemsSold: r.itemsSold,
            }))}
          />
        )}
      </Panel>

      {/* Winning products for THIS account — sums TikTokProductDaily
          rows inside the current dashboard window. Because the
          daily table stores per-day per-product buckets, the
          numbers now genuinely match whatever window the toggle
          points at (7d / 30d / today), rather than always showing
          the last calendar month. */}
      {(() => {
        // Direct passthrough of TikTokProduct rows written from
        // get_product_analytics_list. Shows ALL products the
        // creator has — no window filter, no zero filter. Items
        // sold + commission are per-product totals for the
        // current calendar month, straight from TikHub.
        const rows = productGroups.map((p) => ({
          id: p.externalId,
          title: p.title,
          currencyCode: p.currencyCode ?? totalRev.currencyCode,
          gmv: Number(p.gmv ?? 0),
          itemsSold: p.itemsSold ?? 0,
          commission: Number(p.commission ?? 0),
        }));
        return (
          <Panel title="Top products by units sold · this month">
            {rows.length === 0 ? (
              <EmptyState
                icon="◌"
                title="No products captured yet"
                hint="Click Refresh now on the account to pull the latest product analytics."
              />
            ) : (
              <ProductTable
                currencyCode={totalRev.currencyCode}
                rows={rows}
              />
            )}
          </Panel>
        );
      })()}

      {/* Health history (last 10) */}
      <Panel title="Account health · last 10 captures">
        {healthHistory.length === 0 ? (
          <EmptyState
            icon="◌"
            title="No health data yet"
            hint="The 6-hour cron writes this. Click 'Refresh now' on the accounts page to capture immediately."
          />
        ) : (
          <ul className="space-y-1.5">
            {healthHistory.map((h) => {
              const restrictions =
                (parseJson<string[]>(h.restrictions ?? null) ?? []).filter(Boolean);
              return (
                <li
                  key={h.id}
                  className="flex items-baseline justify-between gap-3 text-sm border-b border-border/40 pb-1.5"
                >
                  <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                    <StatusChip
                      label={h.status}
                      variant={healthTone(h.status, h.violationScore)}
                    />
                    <span className="text-muted">
                      score {h.violationScore}
                    </span>
                    {restrictions.length > 0 && (
                      <span className="text-bad text-xs">
                        {restrictions.join(", ")}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-muted shrink-0">
                    {new Date(h.capturedAt).toLocaleString()}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function WindowLink({
  current,
  target,
  label,
  accountId,
}: {
  current: Window;
  target: Window;
  label: string;
  accountId: string;
}) {
  const active = current === target;
  const href =
    target === "7d"
      ? `/analytics/${accountId}`
      : `/analytics/${accountId}?window=${target}`;
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-xl text-xs ${
        active
          ? "bg-accent-soft text-bg"
          : "text-muted hover:text-text hover:bg-panel2"
      }`}
    >
      {label}
    </Link>
  );
}

function windowLabel(w: Window): string {
  return w === "today" ? "today" : w === "7d" ? "7 days" : "30 days";
}

function DailyTable({
  rows,
}: {
  rows: Array<{
    date: Date;
    gmv: number;
    currencyCode: string;
    estimatedCommission: number;
    videoViews: number;
    newFollowerCount: number;
    videoCount: number;
    itemsSold: number;
  }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] text-muted uppercase tracking-wide border-b border-border">
            <th className="pb-2 font-medium">Date</th>
            <th className="pb-2 font-medium text-right">Views</th>
            <th className="pb-2 font-medium text-right">Followers</th>
            <th className="pb-2 font-medium text-right">Videos</th>
            <th className="pb-2 font-medium text-right">GMV</th>
            <th className="pb-2 font-medium text-right">Items</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.date.toISOString()}
              className="border-b border-border/40"
            >
              <td className="py-2 pr-3 font-mono text-muted">
                {r.date.toISOString().slice(0, 10)}
              </td>
              <td className="py-2 pr-3 text-right font-mono">
                {formatInt(r.videoViews)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-muted">
                +{formatInt(r.newFollowerCount)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-muted">
                {formatInt(r.videoCount)}
              </td>
              <td className="py-2 pr-3 text-right font-mono">
                {formatMoney(r.gmv, r.currencyCode)}
              </td>
              <td className="py-2 text-right font-mono text-muted">
                {formatInt(r.itemsSold)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductTable({
  rows,
  currencyCode,
}: {
  rows: Array<{
    id: string;
    title: string;
    gmv: number;
    itemsSold: number;
    commission: number;
  }>;
  currencyCode: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] text-muted uppercase tracking-wide border-b border-border">
            <th className="pb-2 font-medium">Product</th>
            <th className="pb-2 font-medium text-right">Items Sold</th>
            <th className="pb-2 font-medium text-right">GMV</th>
            <th className="pb-2 font-medium text-right">Commission</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b border-border/40 hover:bg-bg/40"
            >
              <td className="py-2 pr-3 max-w-md truncate" title={r.title}>
                {r.title}
              </td>
              <td className="py-2 pr-3 text-right font-mono">
                {formatInt(r.itemsSold)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-muted">
                {formatMoney(r.gmv, currencyCode)}
              </td>
              <td className="py-2 text-right font-mono">
                {formatMoney(r.commission, currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
