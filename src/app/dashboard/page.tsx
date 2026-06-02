import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import MetricCard from "@/components/ui/MetricCard";
import StatusChip from "@/components/StatusChip";
import EmptyState from "@/components/ui/EmptyState";
import { parseJson } from "@/lib/json-column";
import { friendlyJobType } from "@/lib/job-types";

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

// Pipeline counters derived from the most recent scan_favorited_images
// result + the most recent generate_flow_videos_from_favorites result.
// These are best-effort: if the user hasn't run a scan yet, we show "—".
async function getPipelineMetrics(workspaceId: string) {
  const [productsCount, lastScan, lastVideoRun] = await Promise.all([
    db.product.count({ where: { batch: { workspaceId } } }),
    db.job.findFirst({
      where: {
        workspaceId,
        jobType: "scan_favorited_images",
        status: "succeeded",
      },
      orderBy: { createdAt: "desc" },
      select: { result: true, createdAt: true },
    }),
    db.job.findFirst({
      where: {
        workspaceId,
        jobType: "generate_flow_videos_from_favorites",
        status: "succeeded",
      },
      orderBy: { createdAt: "desc" },
      select: { result: true, createdAt: true },
    }),
  ]);

  const scan = lastScan?.result
    ? (parseJson(lastScan.result) as {
        favorited_images_count?: number;
        tiles_scanned?: number;
      } | null)
    : null;
  const video = lastVideoRun?.result
    ? (parseJson(lastVideoRun.result) as {
        submitted?: number;
      } | null)
    : null;

  return {
    productsCount,
    imagesSubmitted: scan?.tiles_scanned ?? null,
    favoritedImages: scan?.favorited_images_count ?? null,
    videosGenerated: video?.submitted ?? null,
    lastScanAt: lastScan?.createdAt ?? null,
  };
}

export default async function DashboardPage() {
  const { workspace } = await getCurrentWorkspace();

  const [agent, lastFlowCheck, activeBatch, recentJobs, metrics] =
    await Promise.all([
      db.agent.findFirst({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "asc" },
      }),
      db.job.findFirst({
        where: {
          workspaceId: workspace.id,
          jobType: "check_flow_connection",
          status: "succeeded",
        },
        orderBy: { createdAt: "desc" },
        select: { result: true, createdAt: true },
      }),
      db.batch.findFirst({
        where: { workspaceId: workspace.id },
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { products: true, jobs: true } } },
      }),
      db.job.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: {
          id: true,
          jobType: true,
          status: true,
          createdAt: true,
          batch: { select: { name: true } },
        },
      }),
      getPipelineMetrics(workspace.id),
    ]);

  const flowProbe = lastFlowCheck?.result
    ? (parseJson(lastFlowCheck.result) as {
        chrome_reachable?: boolean;
        flow_reachable?: boolean;
      } | null)
    : null;

  // Choose the single "next recommended action" based on what's
  // missing. Priorities mirror the user's pipeline: get a runner →
  // create a batch → scan favorites → generate videos.
  const nextAction = (() => {
    if (!agent)
      return {
        title: "Register your local runner",
        body:
          "The cockpit needs a local runner to drive Flow. Add one on the Runner page.",
        href: "/agents",
        cta: "Open Runner",
      };
    if (agent.status !== "online")
      return {
        title: "Test your runner",
        body:
          "Your runner hasn't checked in. Test it to confirm Chrome and Flow are reachable.",
        href: "/agents",
        cta: "Test runner",
      };
    if (!activeBatch)
      return {
        title: "Create your first batch",
        body: "Batches group products through the image → favorite → video pipeline.",
        href: "/batches",
        cta: "New batch",
      };
    if ((metrics.favoritedImages ?? 0) === 0)
      return {
        title: "Scan favorited images",
        body:
          "Once you've favorited tiles in Flow, scan them so the cockpit knows what to animate.",
        href: `/batches/${activeBatch.id}`,
        cta: "Open batch",
      };
    return {
      title: "Generate videos from favorites",
      body:
        "Favorites detected. Generate videos to push them through the next stage.",
      href: `/batches/${activeBatch.id}`,
      cta: "Open batch",
    };
  })();

  const runnerOnline = agent?.status === "online";

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h-page">{workspace.name}</h1>
        <p className="text-sm text-muted mt-1">
          Cockpit overview · {new Date().toLocaleString()}
        </p>
      </header>

      {/* Top row: runner status (left, wide) + next action (right) ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel
          className="lg:col-span-2"
          title="Local runner"
          action={
            <Link
              href="/agents"
              className="text-xs text-accent hover:underline"
            >
              Manage →
            </Link>
          }
        >
          {!agent ? (
            <EmptyState
              icon="◇"
              title="No runner registered yet"
              hint="Register your local flow-bof-automation install to start driving Flow from the cockpit."
              action={
                <Link href="/agents" className="btn btn-primary">
                  Register runner
                </Link>
              }
            />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                label="Runner"
                value={runnerOnline ? "Connected" : "Offline"}
                tone={runnerOnline ? "ok" : "bad"}
                hint={agent.name}
              />
              <MetricCard
                label="Chrome"
                value={
                  flowProbe?.chrome_reachable === undefined
                    ? "Unknown"
                    : flowProbe.chrome_reachable
                      ? "Reachable"
                      : "Not reachable"
                }
                tone={
                  flowProbe?.chrome_reachable === true
                    ? "ok"
                    : flowProbe?.chrome_reachable === false
                      ? "bad"
                      : "muted"
                }
              />
              <MetricCard
                label="Flow"
                value={
                  flowProbe?.flow_reachable === undefined
                    ? "Unknown"
                    : flowProbe.flow_reachable
                      ? "Reachable"
                      : "Not reachable"
                }
                tone={
                  flowProbe?.flow_reachable === true
                    ? "ok"
                    : flowProbe?.flow_reachable === false
                      ? "bad"
                      : "muted"
                }
              />
              <MetricCard
                label="Last seen"
                value={timeAgo(agent.lastSeenAt)}
                tone="muted"
                hint={
                  agent.lastSeenAt
                    ? new Date(agent.lastSeenAt).toLocaleString()
                    : undefined
                }
              />
            </div>
          )}
        </Panel>

        <Panel variant="accent" title="Next action">
          <div className="space-y-3">
            <div className="text-base font-medium text-text">
              {nextAction.title}
            </div>
            <p className="text-sm text-muted leading-relaxed">
              {nextAction.body}
            </p>
            <Link href={nextAction.href} className="btn btn-primary inline-flex">
              {nextAction.cta} →
            </Link>
          </div>
        </Panel>
      </div>

      {/* Pipeline + active batch row ---------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel
          className="lg:col-span-2"
          title="Creative pipeline"
          action={
            metrics.lastScanAt && (
              <span className="text-[11px] text-muted">
                last scan {timeAgo(metrics.lastScanAt)}
              </span>
            )
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard label="Products" value={metrics.productsCount} />
            <MetricCard
              label="Images submitted"
              value={metrics.imagesSubmitted ?? "—"}
              tone={metrics.imagesSubmitted ? "accent" : "muted"}
            />
            <MetricCard
              label="Favorited images"
              value={metrics.favoritedImages ?? "—"}
              tone={metrics.favoritedImages ? "ok" : "muted"}
            />
            <MetricCard
              label="Videos generated"
              value={metrics.videosGenerated ?? "—"}
              tone={metrics.videosGenerated ? "accent" : "muted"}
            />
          </div>
        </Panel>

        <Panel
          title="Active batch"
          action={
            activeBatch && (
              <Link
                href={`/batches/${activeBatch.id}`}
                className="text-xs text-accent hover:underline"
              >
                Open →
              </Link>
            )
          }
        >
          {!activeBatch ? (
            <EmptyState
              icon="▤"
              title="No batches yet"
              hint="Create a batch to start grouping products."
              action={
                <Link href="/batches" className="btn btn-primary">
                  New batch
                </Link>
              }
            />
          ) : (
            <div className="space-y-3">
              <div>
                <div className="text-base font-medium text-text">
                  {activeBatch.name}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  updated {timeAgo(activeBatch.updatedAt)}
                </div>
              </div>
              <div className="flex gap-2">
                <StatusChip label={activeBatch.status} variant="muted" />
                <StatusChip
                  label={`${activeBatch._count.products} products`}
                  variant="muted"
                />
                <StatusChip
                  label={`${activeBatch._count.jobs} jobs`}
                  variant="muted"
                />
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* Recent activity --------------------------------------------- */}
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
            hint="Sample jobs run from any batch detail page will land here."
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
