import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import StatusChip from "@/components/StatusChip";
import { friendlyJobType } from "@/lib/job-types";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  queued:    "muted",
  running:   "warn",
  succeeded: "ok",
  failed:    "bad",
  cancelled: "muted",
};

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function JobsPage() {
  const { workspace } = await getCurrentWorkspace();
  const jobs = await db.job.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      agent: { select: { name: true } },
      batch: { select: { name: true, id: true } },
    },
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h-page">Jobs</h1>
        <p className="text-sm text-muted mt-1">
          Every job dispatched to a runner, newest first.
        </p>
      </header>

      {jobs.length === 0 ? (
        <EmptyState
          icon="≡"
          title="No jobs yet"
          hint="Trigger one from any batch workbench."
          action={
            <Link href="/batches" className="btn btn-primary">
              Open batches
            </Link>
          }
        />
      ) : (
        <Panel>
          <ul className="divide-y divide-border">
            {jobs.map((j) => (
              <li
                key={j.id}
                className="py-3 flex items-center gap-3 text-sm flex-wrap"
              >
                <StatusChip
                  label={j.status}
                  variant={STATUS_VARIANT[j.status] ?? "muted"}
                />
                <Link
                  href={`/jobs/${j.id}`}
                  className="font-medium text-text hover:text-accent transition-colors"
                >
                  {friendlyJobType(j.jobType)}
                </Link>
                {j.batch && (
                  <Link
                    href={`/batches/${j.batch.id}`}
                    className="text-xs text-muted hover:text-text"
                  >
                    {j.batch.name}
                  </Link>
                )}
                {j.agent && (
                  <span className="text-xs text-muted">{j.agent.name}</span>
                )}
                <span className="text-xs text-muted ml-auto">
                  {timeAgo(j.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
