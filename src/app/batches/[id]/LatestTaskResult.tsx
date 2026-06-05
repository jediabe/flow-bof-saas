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
      ? (parseJson(job.error) as {
          code?: string;
          message?: string;
          details?: Record<string, unknown> | null;
        } | null)
      : null;

  const elapsed = ((job.updatedAt.getTime() - job.createdAt.getTime()) / 1000);
  const summary = summarize(job.jobType, parsedResult);

  // Phase-7 rate-limit cooldown banner. Renders a prominent panel
  // above the normal task-result row when the runner reports that
  // Google Flow's risk engine flagged the session. End-user copy
  // explains the cooldown + what stopped vs what's left, since the
  // generic "failed" chip alone doesn't tell them they can recover
  // by just waiting.
  const isRateLimit =
    parsedError?.code === "FLOW_RATE_LIMIT_OR_SUSPICIOUS_ACTIVITY";

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
      {isRateLimit && (
        <RateLimitBanner details={parsedError?.details ?? null} />
      )}
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
      {parsedError?.message && !isRateLimit && (
        // Suppress the small text-bad row when the rate-limit banner
        // is shown — the banner already carries the same info in a
        // much more readable form.
        <div className="mt-2 text-xs text-bad">
          {parsedError.code ? `${parsedError.code}: ` : ""}
          {parsedError.message}
        </div>
      )}
    </Panel>
  );
}

/**
 * Prominent banner shown when the runner reports
 * FLOW_RATE_LIMIT_OR_SUSPICIOUS_ACTIVITY — Google Flow's risk
 * engine flagged the session and refused to keep generating. End
 * users see this as a clear, actionable message instead of a
 * generic "failed" chip.
 */
function RateLimitBanner({
  details,
}: {
  details: Record<string, unknown> | null;
}) {
  // Pull the numeric details safely. Runner sets all of these on
  // the failure envelope but coerce defensively in case the schema
  // ever changes.
  const num = (k: string): number | null =>
    typeof details?.[k] === "number" ? (details![k] as number) : null;
  const submitted = num("submitted");
  const unsubmitted = num("unsubmitted");
  const stoppedAfter = num("stopped_after_item");
  const riskPhrase =
    typeof details?.["risk_phrase"] === "string"
      ? (details!["risk_phrase"] as string)
      : null;

  return (
    <div className="mb-3 rounded-2xl border border-warn/40 bg-warn/[0.08] px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-warn font-medium">⏸ Google Flow rate-limited this session</span>
        {riskPhrase && (
          <span className="text-[11px] text-muted">
            (detected: <code className="id-mono">{riskPhrase}</code>)
          </span>
        )}
      </div>
      <p className="text-xs text-text/85 mt-1.5">
        Flow&apos;s anti-abuse risk engine flagged the session and
        started rejecting submits. The runner stopped to avoid
        raising the risk score further.
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {submitted !== null && (
          <span>
            <span className="text-ok font-medium">{submitted}</span>{" "}
            <span className="text-muted">submitted before stop</span>
          </span>
        )}
        {stoppedAfter !== null && (
          <span>
            <span className="text-warn font-medium">item {stoppedAfter}</span>{" "}
            <span className="text-muted">was the last attempted</span>
          </span>
        )}
        {unsubmitted !== null && unsubmitted > 0 && (
          <span>
            <span className="text-bad font-medium">{unsubmitted}</span>{" "}
            <span className="text-muted">unsubmitted — retry after cooldown</span>
          </span>
        )}
      </div>
      <div className="mt-3 rounded-xl bg-bg/40 px-3 py-2 text-[11px] text-muted leading-relaxed">
        <span className="text-text font-medium">What to do:</span>{" "}
        wait 30-60 minutes before re-running this batch. To reduce
        the chance of it happening again, try smaller batches
        (10-15 products), longer between-product delays
        (<code className="id-mono">IMAGE_BETWEEN_PRODUCTS_MS</code>{" "}
        env on the runner), or spread runs across the day. The
        runner now adds random jitter to inter-item delays
        automatically — older builds were faster and tripped this
        more often.
      </div>
    </div>
  );
}
