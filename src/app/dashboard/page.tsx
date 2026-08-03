import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import StatusChip from "@/components/StatusChip";
import EmptyState from "@/components/ui/EmptyState";
import ApexLogo from "@/components/ApexLogo";
import { friendlyJobType } from "@/lib/job-types";

/**
 * APEX Hub — landing page for the APEX Initiative TikTok Shop
 * dashboard.
 *
 * Structure:
 *   1. Hero  — big //APEX mark + workspace name + workspace
 *              scoped 7d GMV headline (or a "connect an account"
 *              CTA when nothing's linked yet).
 *   2. Primary tiles — three cards, one per top-level surface
 *              (Shop Analytics, Hooks & Prompts, Mobile Posting).
 *              Each shows a headline number + short prompt.
 *   3. Recent activity — small table below the fold. Held on to
 *              during the Style 1 wind-down so operators still
 *              see runner-era jobs if any remain in-flight.
 *
 * The old "Tools row" (Image Gen / Runner Setup / Jobs) was
 * removed with the Style 1 pivot — that pipeline drove Google
 * Flow via the local Python runner and no longer maps to how
 * videos get made (Flow agent chat in-browser + CapCut on phone).
 * The routes still work as URLs for anyone bookmarking them.
 *
 * All data reads are best-effort — an empty database renders the
 * hub cleanly with prompts to add first-run content.
 */

export const dynamic = "force-dynamic";

const JOB_STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  queued:    "muted",
  running:   "warn",
  succeeded: "ok",
  failed:    "bad",
  cancelled: "muted",
};

function timeAgo(d: Date | null | undefined): string {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** GBP first, then whatever, then USD. UK-first because that's who
 *  the APEX curriculum is currently built for. */
function formatCurrency(amount: number, code: string): string {
  const symbol = code === "GBP" ? "£" : code === "USD" ? "$" : "";
  return `${symbol}${Math.round(amount).toLocaleString()}`;
}

export default async function HubPage() {
  const { workspace } = await getCurrentWorkspace();

  // 7-day window for the headline metric — matches the /analytics
  // page default so the numbers reconcile.
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // activeBatch + agent used to feed the "02 Tools" row (Image
  // Gen / Runner Setup / Jobs) which was removed with the Style 1
  // pivot. Those queries are gone; recentJobs stays because the
  // "Recent activity" panel below still shows the last 5 jobs
  // (useful for debugging runner-era batches during the wind-down).
  const [
    accountsCount,
    revenue7d,
    productsCount,
    recentJobs,
  ] = await Promise.all([
    db.tikTokAccount.count({ where: { workspaceId: workspace.id } }),
    db.tikTokAccountRevenue.findMany({
      where: {
        account: { workspaceId: workspace.id },
        date: { gte: sevenDaysAgo },
      },
      select: { gmv: true, currencyCode: true, itemsSold: true },
    }),
    db.tikTokProduct.count({
      where: { account: { workspaceId: workspace.id } },
    }),
    db.job.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        jobType: true,
        status: true,
        createdAt: true,
        batch: { select: { name: true } },
      },
    }),
  ]);

  // Aggregate 7d GMV in the dominant currency; if operators mix
  // currencies we surface "mixed" and skip the symbol.
  const currencyCounts = new Map<string, number>();
  let gmv7d = 0;
  let items7d = 0;
  for (const r of revenue7d) {
    const c = r.currencyCode || "USD";
    currencyCounts.set(c, (currencyCounts.get(c) ?? 0) + 1);
    gmv7d += Number(r.gmv ?? 0);
    items7d += r.itemsSold ?? 0;
  }
  const dominantCurrency =
    [...currencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    "GBP";
  const currencyMixed = currencyCounts.size > 1;

  return (
    <div className="space-y-8">
      {/* Hero ------------------------------------------------------- */}
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 pb-2">
        <div>
          <ApexLogo size="lg" subline="TikTok Shop hub" />
          <div className="text-sm text-muted mt-3">
            {workspace.name} · {new Date().toLocaleDateString()}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
            GMV · last 7 days
          </div>
          <div className="text-3xl font-bold tracking-tight text-text mt-1">
            {accountsCount === 0
              ? "—"
              : currencyMixed
                ? gmv7d.toLocaleString()
                : formatCurrency(gmv7d, dominantCurrency)}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            {accountsCount === 0
              ? "no accounts connected yet"
              : `${items7d.toLocaleString()} items · ${accountsCount} account${accountsCount === 1 ? "" : "s"}`}
          </div>
        </div>
      </header>

      {/* Primary tiles --------------------------------------------- */}
      <section>
        <div className="flex items-center gap-3 mb-4">
          <span className="chip-num">01</span>
          <h2 className="text-xs uppercase tracking-[0.16em] text-muted font-medium">
            Everyday surfaces
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <HubTile
            variant="blue"
            title="Shop Analytics"
            body={
              accountsCount === 0
                ? "Connect a TikTok Shop account to start pulling health, revenue, and product analytics."
                : `${accountsCount} account${accountsCount === 1 ? "" : "s"} connected · ${productsCount} product${productsCount === 1 ? "" : "s"} tracked.`
            }
            cta={accountsCount === 0 ? "Connect first account" : "Open dashboard"}
            href={
              accountsCount === 0
                ? "/settings/tiktok-accounts"
                : "/analytics"
            }
          />
          <HubTile
            variant="red"
            title="Hooks & Prompts"
            body="Generate all seven APEX hook families per product — I'm So Sorry, Wait, POV, Curiosity, Scarcity, Deal, Social Proof — plus caption and hashtag block."
            cta="Generate hooks"
            href="/prompts"
          />
          <HubTile
            variant="blue"
            title="Mobile Posting"
            body="Import a Kalodata batch on Hooks & Prompts, review products on your phone, and post from the mobile posting checklist — Flow script, voice, copy, hashtags in one flow."
            cta="Open Hooks & Prompts"
            href="/prompts"
          />
        </div>
      </section>

      {/* Recent activity ------------------------------------------- */}
      <Panel
        title="Recent activity"
        action={
          <Link href="/jobs" className="text-xs text-accent hover:underline">
            All jobs →
          </Link>
        }
      >
        {recentJobs.length === 0 ? (
          <EmptyState
            icon="≡"
            title="No activity yet"
            hint="Jobs run from any batch detail page will land here."
          />
        ) : (
          <ul className="divide-y divide-border">
            {recentJobs.map((j) => (
              <li
                key={j.id}
                className="py-3 flex items-center gap-3 text-sm"
              >
                <StatusChip
                  label={j.status}
                  variant={JOB_STATUS_VARIANT[j.status] ?? "muted"}
                />
                <Link
                  href={`/jobs/${j.id}`}
                  className="font-medium text-text hover:text-accent transition-colors"
                >
                  {friendlyJobType(j.jobType)}
                </Link>
                <span className="text-xs text-muted">
                  {j.batch?.name ?? "no batch"}
                </span>
                <span className="text-xs text-muted ml-auto">
                  {timeAgo(j.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

    </div>
  );
}

/**
 * Large primary tile — one of the top-row cards. Uses the
 * APEX card accents (blue or red left-border) from the shared
 * primitives so it matches the curriculum PDF's callout style.
 */
function HubTile({
  variant,
  title,
  body,
  cta,
  href,
}: {
  variant: "blue" | "red";
  title: string;
  body: string;
  cta: string;
  href: string;
}) {
  const cardClass =
    variant === "blue" ? "card-accent-blue" : "card-accent-red";
  const ctaColour =
    variant === "blue" ? "text-accent" : "text-accent-red";
  return (
    <Link
      href={href}
      className={`${cardClass} p-5 flex flex-col gap-3 min-h-[180px] hover:border-border-strong transition-colors group`}
    >
      <div className="text-base font-semibold tracking-tight text-text">
        {title}
      </div>
      <p className="text-sm text-muted leading-relaxed flex-1">{body}</p>
      <div
        className={`text-[13px] font-medium ${ctaColour} group-hover:underline`}
      >
        {cta} →
      </div>
    </Link>
  );
}


