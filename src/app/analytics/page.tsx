import Link from "next/link";
import { getCurrentWorkspace } from "@/lib/workspace";
import { db } from "@/lib/db";
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
 * BOF Dashboard — aggregate analytics across all connected
 * TikTok Shop accounts.
 *
 * Window is a query-param toggle (?window=today|7d|30d), so it
 * survives URL shares + bookmarks and the layout can re-render
 * server-side without any client-side date juggling.
 *
 * Everything reads from the DB — no TikHub call during a page
 * render. Cron writes; render reads. Keeps the page fast even on
 * a slow TikHub day.
 */

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const { workspace } = await getCurrentWorkspace();
  const sp = await searchParams;
  const windowKey: Window =
    sp.window === "today" || sp.window === "30d" ? sp.window : "7d";
  const range = windowRange(windowKey);

  // Pull everything in one round-trip. Each table is small enough
  // for an unbounded fetch within the window; we sort + cap on the
  // product list since that's the only one that can grow large.
  const [accounts, revenue, pnl, products, latestHealthByAccount] =
    await Promise.all([
      db.tikTokAccount.findMany({
        where: { workspaceId: workspace.id },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          label: true,
          region: true,
          cookieStatus: true,
          monthlyToolCost: true,
        },
      }),
      db.tikTokAccountRevenue.findMany({
        where: {
          account: { workspaceId: workspace.id },
          date: { gte: range.start, lt: range.endExclusive },
        },
        select: {
          accountId: true,
          gmv: true,
          currencyCode: true,
          estimatedCommission: true,
          videoRevenue: true,
          liveRevenue: true,
          itemsSold: true,
          videoViews: true,
          newFollowerCount: true,
          videoCount: true,
        },
      }),
      db.tikTokAccountPnl.findMany({
        where: {
          account: { workspaceId: workspace.id },
          date: { gte: range.start, lt: range.endExclusive },
        },
        select: {
          accountId: true,
          grossCommission: true,
          toolCost: true,
          netProfit: true,
        },
      }),
      db.tikTokProduct.findMany({
        where: { account: { workspaceId: workspace.id } },
        // Sort by units sold first (what the operator actually
        // cares about — "which products moved"), then by GMV as
        // tiebreaker for products with the same unit count.
        orderBy: [{ itemsSold: "desc" }, { gmv: "desc" }],
        take: 25,
        select: {
          id: true,
          accountId: true,
          title: true,
          gmv: true,
          itemsSold: true,
          commission: true,
        },
      }),
      // Latest health row per account. SQLite + Prisma don't have
      // a clean DISTINCT-ON, so we fetch the N rows per account
      // and pick the freshest in code.
      db.tikTokAccountHealth.findMany({
        where: { account: { workspaceId: workspace.id } },
        orderBy: [{ capturedAt: "desc" }],
        take: 200,
        select: {
          accountId: true,
          status: true,
          violationScore: true,
          restrictions: true,
          capturedAt: true,
        },
      }),
    ]);

  // First wins for latest-per-account because we ordered desc.
  const latestHealth = new Map<
    string,
    {
      status: string;
      violationScore: number;
      restrictions: string | null;
      capturedAt: Date;
    }
  >();
  for (const h of latestHealthByAccount) {
    if (!latestHealth.has(h.accountId)) latestHealth.set(h.accountId, h);
  }

  const totalRevenue = sumRevenue(revenue);
  const totalPnl = sumPnl(pnl);
  const totalAccounts = accounts.length;

  // Empty state when no accounts connected — keep the toggles + nav
  // visible so the user knows where they are.
  if (totalAccounts === 0) {
    return (
      <div className="space-y-6">
        <PageHeader windowKey={windowKey} />
        <Panel title="No accounts connected" variant="ghost">
          <EmptyState
            icon="◇"
            title="Connect a TikTok Shop account"
            hint="Head to Settings → TikTok accounts to paste a session cookie. Once connected, analytics start flowing here within a few minutes."
            action={
              <Link
                href="/settings/tiktok-accounts"
                className="btn btn-primary text-xs"
              >
                Add account
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  // Account-level revenue rollup so we can sort the per-account
  // list by GMV within the window.
  const perAccountRevenue = new Map<string, ReturnType<typeof sumRevenue>>();
  for (const a of accounts) {
    perAccountRevenue.set(
      a.id,
      sumRevenue(revenue.filter((r) => r.accountId === a.id)),
    );
  }

  const sortedAccounts = [...accounts].sort((a, b) => {
    const ag = perAccountRevenue.get(a.id)?.gmv ?? 0;
    const bg = perAccountRevenue.get(b.id)?.gmv ?? 0;
    return bg - ag;
  });

  return (
    <div className="space-y-6">
      <PageHeader windowKey={windowKey} />

      {/* Content metrics — meaningful even when GMV is zero, so
          they lead. Affiliate creators who haven't started selling
          yet still grow audience + post content; the dashboard
          shouldn't look "empty" for them. */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricCard
          label={`Video views · ${windowLabel(windowKey)}`}
          value={formatInt(totalRevenue.videoViews)}
          hint={`across ${totalAccounts} account${totalAccounts === 1 ? "" : "s"}`}
          tone="accent"
        />
        <MetricCard
          label="New followers"
          value={formatInt(totalRevenue.newFollowerCount)}
          hint={`gained in ${windowLabel(windowKey)}`}
        />
        <MetricCard
          label="Videos posted"
          value={formatInt(totalRevenue.videoCount)}
          hint={`${windowLabel(windowKey)} window`}
        />
        <MetricCard
          label="Items sold"
          value={formatInt(totalRevenue.itemsSold)}
          hint={`${windowLabel(windowKey)} window`}
        />
      </div>

      {/* Revenue + P&L — second row. Still useful for accounts
          with sales; degrades to dashes / zeros otherwise. */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <MetricCard
          label={
            totalRevenue.currencyMixed
              ? "GMV (mixed currency)"
              : `GMV · ${totalRevenue.currencyCode}`
          }
          value={
            totalRevenue.currencyMixed
              ? formatInt(totalRevenue.gmv)
              : formatMoney(totalRevenue.gmv, totalRevenue.currencyCode)
          }
          hint={
            totalRevenue.currencyMixed
              ? "raw sum across currencies — review per-account"
              : `${formatInt(totalRevenue.itemsSold)} items`
          }
        />
        <MetricCard
          label="Est. commission"
          value={formatMoney(totalRevenue.estimatedCommission, totalRevenue.currencyCode)}
          hint={
            totalRevenue.gmv > 0
              ? `take rate ${formatPercent(totalRevenue.estimatedCommission / totalRevenue.gmv)}`
              : "no GMV in window"
          }
        />
        <MetricCard
          label="Net profit"
          value={formatMoney(totalPnl.netProfit, totalRevenue.currencyCode)}
          hint={`tool cost ${formatMoney(totalPnl.toolCost, totalRevenue.currencyCode)}`}
          tone={totalPnl.netProfit > 0 ? "ok" : totalPnl.netProfit < 0 ? "bad" : "muted"}
        />
        <MetricCard
          label="Net margin"
          value={formatPercent(totalPnl.marginRatio)}
          hint={`net profit / commission · ${totalAccounts} acct${totalAccounts === 1 ? "" : "s"}`}
        />
      </div>

      {/* Per-account list — sorted by window GMV desc */}
      <Panel title={`Accounts (${totalAccounts})`}>
        <div className="space-y-2">
          {sortedAccounts.map((a) => {
            const rev = perAccountRevenue.get(a.id) ?? {
              gmv: 0,
              currencyCode: "USD",
              currencyMixed: false,
              estimatedCommission: 0,
              videoRevenue: 0,
              liveRevenue: 0,
              itemsSold: 0,
              videoViews: 0,
              newFollowerCount: 0,
              videoCount: 0,
            };
            const h = latestHealth.get(a.id);
            const healthVariant = h
              ? healthTone(h.status, h.violationScore)
              : "muted";
            return (
              <Link
                key={a.id}
                href={`/analytics/${a.id}`}
                className="block rounded-2xl border border-border bg-bg/40 hover:border-border-strong hover:bg-bg/60 transition-colors px-4 py-3"
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                    <span className="font-medium text-text truncate">
                      {a.label}
                    </span>
                    <StatusChip label={a.region} variant="muted" />
                    <StatusChip
                      label={
                        h
                          ? `${h.status} · score ${h.violationScore}`
                          : "no health data"
                      }
                      variant={healthVariant}
                    />
                    {a.cookieStatus !== "active" && (
                      <StatusChip
                        label={`cookie: ${a.cookieStatus}`}
                        variant="bad"
                      />
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {/* If the account has sales activity, lead
                        with GMV (currency-aware). Otherwise lead
                        with views — the meaningful headline for
                        content-only accounts. */}
                    {rev.gmv > 0 || rev.itemsSold > 0 ? (
                      <>
                        <div className="text-sm text-text font-medium">
                          {formatMoney(rev.gmv, rev.currencyCode)}
                        </div>
                        <div className="text-[11px] text-muted">
                          {formatInt(rev.itemsSold)} items ·{" "}
                          {formatInt(rev.videoViews)} views
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm text-text font-medium">
                          {formatInt(rev.videoViews)} views
                        </div>
                        <div className="text-[11px] text-muted">
                          {formatInt(rev.videoCount)} videos ·{" "}
                          +{formatInt(rev.newFollowerCount)} followers
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </Panel>

      {/* Top products across all accounts — sorted by units sold.
          Same filter as the per-account view: hide showcase items
          with no attributed sales so the panel isn't a wall of
          zeros for accounts where TikHub's product endpoint
          doesn't see the shop-owner attribution. */}
      {(() => {
        const withSales = products.filter(
          (p) => p.itemsSold > 0 || Number(p.gmv ?? 0) > 0,
        );
        return (
          <Panel title="Top products by units sold (across all accounts)">
            {withSales.length === 0 ? (
              <EmptyState
                icon="◌"
                title="No product-level sales in this window"
                hint={
                  totalRevenue.itemsSold > 0
                    ? "Account-level GMV is populated but TikHub's product endpoint didn't attribute those sales to individual showcase products. Common for shop-owner direct sales."
                    : "The daily products cron writes this once wired up."
                }
              />
            ) : (
              <ProductTable
                rows={withSales.map((p) => ({
                  id: p.id,
                  accountId: p.accountId,
                  accountLabel:
                    accounts.find((a) => a.id === p.accountId)?.label ?? "—",
                  title: p.title,
                  gmv: Number(p.gmv ?? 0),
                  // Look up currency from the same account's revenue
                  // rollup — accounts don't mix currencies.
                  currencyCode:
                    perAccountRevenue.get(p.accountId)?.currencyCode ?? "USD",
                  itemsSold: p.itemsSold,
                  commission: Number(p.commission ?? 0),
                }))}
              />
            )}
          </Panel>
        );
      })()}
    </div>
  );
}

function PageHeader({ windowKey }: { windowKey: Window }) {
  const item = (key: Window, label: string) => {
    const active = key === windowKey;
    return (
      <Link
        href={key === "7d" ? "/analytics" : `/analytics?window=${key}`}
        className={`px-3 py-1.5 rounded-xl text-xs ${
          active
            ? "bg-accent-soft text-bg"
            : "text-muted hover:text-text hover:bg-panel2"
        }`}
      >
        {label}
      </Link>
    );
  };
  return (
    <header className="flex items-baseline justify-between gap-4 flex-wrap">
      <div>
        <h1 className="h-page">BOF Dashboard</h1>
        <p className="text-sm text-muted mt-1">
          Multi-account TikTok Shop analytics. Data is captured on
          a schedule; freshness varies per account (see the&nbsp;
          <Link
            href="/settings/tiktok-accounts"
            className="text-accent hover:underline"
          >
            accounts page
          </Link>
          ).
        </p>
      </div>
      <div className="flex items-center gap-1">
        {item("today", "Today")}
        {item("7d", "7d")}
        {item("30d", "30d")}
      </div>
    </header>
  );
}

function windowLabel(w: Window): string {
  return w === "today" ? "today" : w === "7d" ? "7 days" : "30 days";
}

function ProductTable({
  rows,
}: {
  rows: Array<{
    id: string;
    accountId: string;
    accountLabel: string;
    title: string;
    gmv: number;
    currencyCode: string;
    itemsSold: number;
    commission: number;
  }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] text-muted uppercase tracking-wide border-b border-border">
            <th className="pb-2 font-medium">Product</th>
            <th className="pb-2 font-medium">Account</th>
            <th className="pb-2 font-medium text-right">Items</th>
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
              <td className="py-2 pr-3 text-muted">
                <Link
                  href={`/analytics/${r.accountId}`}
                  className="hover:text-text"
                >
                  {r.accountLabel}
                </Link>
              </td>
              <td className="py-2 pr-3 text-right font-mono">
                {formatInt(r.itemsSold)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-muted">
                {formatMoney(r.gmv, r.currencyCode)}
              </td>
              <td className="py-2 text-right font-mono">
                {formatMoney(r.commission, r.currencyCode)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
