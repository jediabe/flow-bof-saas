import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import StatusChip from "@/components/StatusChip";
import Panel from "@/components/ui/Panel";
import JsonDetails from "@/components/ui/JsonDetails";
import ActivityTimeline from "@/components/ui/ActivityTimeline";
import ScanFavoritesResult from "@/components/results/ScanFavoritesResult";
import VideoFavoritesResult from "@/components/results/VideoFavoritesResult";
import GenerateImagesResult from "@/components/results/GenerateImagesResult";
import { friendlyJobType } from "@/lib/job-types";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  queued:    "muted",
  running:   "warn",
  succeeded: "ok",
  failed:    "bad",
  cancelled: "muted",
};


export default async function JobDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspace } = await getCurrentWorkspace();
  const job = await db.job.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      agent: true,
      batch: true,
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!job) notFound();

  const friendlyTitle = friendlyJobType(job.jobType);
  const isRunning = job.status === "running";

  // Which renderer handles the type-specific "Result" panel? Fall
  // back to the JsonDetails view when we don't have a friendly one.
  const renderer = (() => {
    if (!job.result) return null;
    switch (job.jobType) {
      case "scan_favorited_images":
        return <ScanFavoritesResult result={job.result} />;
      case "generate_flow_videos_from_favorites":
        return <VideoFavoritesResult result={job.result} />;
      case "generate_flow_images":
        return <GenerateImagesResult result={job.result} />;
      default:
        return null;
    }
  })();

  return (
    <div className="space-y-6">
      <header>
        <Link href="/jobs" className="text-xs text-muted hover:text-text">
          ← Jobs
        </Link>
        <div className="flex items-baseline flex-wrap gap-3 mt-1">
          <h1 className="h-page">{friendlyTitle}</h1>
          <StatusChip
            label={job.status}
            variant={STATUS_VARIANT[job.status] ?? "muted"}
          />
        </div>
        <div className="text-xs text-muted mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {job.agent && <span>runner {job.agent.name}</span>}
          {job.batch && (
            <>
              <span>·</span>
              <Link
                href={`/batches/${job.batch.id}`}
                className="hover:text-text"
              >
                batch {job.batch.name}
              </Link>
            </>
          )}
          <span>·</span>
          <span>{new Date(job.createdAt).toLocaleString()}</span>
        </div>
      </header>

      {/* Friendly result view first (the point of the page) */}
      {renderer && (
        <section className="space-y-3">{renderer}</section>
      )}

      {/* Error, if any --------------------------------------------- */}
      {job.error && (
        <Panel
          title="Error"
          className="border-bad/40"
        >
          <pre className="text-xs overflow-x-auto bg-bg/80 border border-border rounded-xl p-3 leading-relaxed">
{typeof job.error === "string" ? job.error : JSON.stringify(job.error, null, 2)}
          </pre>
        </Panel>
      )}

      {/* Timeline -------------------------------------------------- */}
      <Panel
        title={`Activity (${job.events.length})`}
        action={
          isRunning && (
            <span className="text-[11px] text-warn">
              ⟳ running — reload for more events
            </span>
          )
        }
      >
        <ActivityTimeline
          events={job.events.map((e) => ({
            id: e.id,
            eventType: e.eventType,
            stage: e.stage,
            message: e.message,
            current: e.current,
            total: e.total,
            details: e.details,
            createdAt: e.createdAt,
          }))}
          jobIsRunning={isRunning}
          emptyHint="No events recorded yet."
        />
      </Panel>

      {/* Developer details: payload, raw result, identifiers ------ */}
      <Panel title="Developer details" variant="ghost">
        <div className="space-y-2">
          <div className="text-[11px] text-muted">
            job id <code className="id-mono">{job.id}</code>
          </div>
          <JsonDetails value={job.payload} label="Request payload" />
          <JsonDetails value={job.result}  label="Raw result envelope" />
        </div>
      </Panel>
    </div>
  );
}
