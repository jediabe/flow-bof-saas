import Link from "next/link";
import { parseJson } from "@/lib/json-column";
import { friendlyJobType } from "@/lib/job-types";
import Panel from "@/components/ui/Panel";
import StatusChip from "@/components/StatusChip";

/**
 * Compact "Latest task result" panel shown on the batch page when the
 * URL carries `?job=<jobId>`. The point of this panel is to let the
 * user stay on /batches/[id] after running a workflow action — they
 * see the summary inline instead of being teleported to /jobs/[id].
 *
 * Type-specific summaries borrow shape from the matching renderer in
 * src/components/results/, but render in a single tight row (no big
 * MetricCard grid). The "View technical details →" link keeps the
 * full /jobs/[id] page accessible for debugging.
 */

const STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  queued:    "muted",
  running:   "warn",
  succeeded: "ok",
  failed:    "bad",
  cancelled: "muted",
};

export interface LatestTaskJob {
  id: string;
  jobType: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Build the per-type summary line. Returns the array of fragments the
 * panel renders inline (label + tone). Each fragment is a tiny pill so
 * the panel reads as a single row.
 */
function summarize(jobType: string, result: unknown): Array<{
  label: string;
  tone?: "ok" | "warn" | "bad" | "muted" | "accent";
}> {
  if (!result) return [];
  const r = result as Record<string, unknown>;
  const out: Array<{ label: string; tone?: "ok" | "warn" | "bad" | "muted" | "accent" }> = [];
  const num = (k: string): number | null =>
    typeof r[k] === "number" ? (r[k] as number) : null;

  switch (jobType) {
    case "scan_favorited_images": {
      const tiles = num("tiles_scanned");
      const favs = num("favorited_images_count");
      if (tiles !== null) out.push({ label: `${tiles} tiles scanned` });
      if (favs !== null)
        out.push({
          label: `${favs} favorited`,
          tone: favs > 0 ? "ok" : "muted",
        });
      break;
    }
    case "generate_flow_videos_from_favorites": {
      const submitted = num("submitted") ?? 0;
      const skipped = num("skipped_already_submitted") ?? 0;
      const failed = num("failed") ?? 0;
      out.push({ label: `${submitted} submitted`, tone: submitted ? "ok" : "muted" });
      if (skipped) out.push({ label: `${skipped} skipped`, tone: "warn" });
      if (failed) out.push({ label: `${failed} failed`, tone: "bad" });
      break;
    }
    case "generate_flow_images": {
      const submitted = num("submitted") ?? 0;
      const skipped = num("skipped") ?? 0;
      const failed = num("failed") ?? 0;
      out.push({ label: `${submitted} submitted`, tone: submitted ? "ok" : "muted" });
      if (skipped) out.push({ label: `${skipped} skipped`, tone: "warn" });
      if (failed) out.push({ label: `${failed} failed`, tone: "bad" });
      break;
    }
    case "check_flow_connection": {
      const chrome = r.chrome_reachable;
      const flow = r.flow_reachable;
      out.push({
        label: chrome ? "Chrome reachable" : "Chrome unreachable",
        tone: chrome ? "ok" : "bad",
      });
      out.push({
        label: flow ? "Flow reachable" : "Flow unreachable",
        tone: flow ? "ok" : "bad",
      });
      break;
    }
    case "health_check": {
      const ok = r.ok;
      out.push({
        label: ok ? "Runner healthy" : "Runner unhealthy",
        tone: ok ? "ok" : "bad",
      });
      break;
    }
  }
  return out;
}

export default function LatestTaskResult({ job }: { job: LatestTaskJob }) {
  const parsedResult = parseJson(job.result);
  const parsedError =
    job.error && job.status === "failed"
      ? (parseJson(job.error) as { code?: string; message?: string } | null)
      : null;

  const elapsed = ((job.updatedAt.getTime() - job.createdAt.getTime()) / 1000);
  const summary = summarize(job.jobType, parsedResult);

  return (
    <Panel
      variant="accent"
      title="Latest task result"
      action={
        <Link
          href={`/jobs/${job.id}`}
          className="text-xs text-accent hover:underline"
        >
          View technical details →
        </Link>
      }
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-base font-medium text-text">
          {friendlyJobType(job.jobType)}
        </span>
        <StatusChip
          label={job.status}
          variant={STATUS_VARIANT[job.status] ?? "muted"}
        />
        {summary.map((s, i) => (
          <StatusChip key={i} label={s.label} variant={s.tone ?? "muted"} />
        ))}
        {elapsed > 0 && job.status !== "running" && (
          <span className="text-[11px] text-muted ml-auto">
            elapsed {elapsed.toFixed(1)}s
          </span>
        )}
      </div>
      {parsedError?.message && (
        <div className="mt-2 text-xs text-bad">
          {parsedError.code ? `${parsedError.code}: ` : ""}
          {parsedError.message}
        </div>
      )}
    </Panel>
  );
}
