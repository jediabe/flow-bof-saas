import { prettyJson } from "@/lib/json-column";

/**
 * Vertical activity timeline. Renders a list of JobEvent rows (or any
 * shape that quacks like one) with a glowing dot per row and a thin
 * connecting line. Per-row details collapse under a disclosure so
 * the timeline stays scannable even for long video batches.
 *
 * Variant is inferred per event:
 *   - eventType="result" + stage="succeeded"  → ok (green glow)
 *   - eventType="result" + stage="failed"     → bad (red glow)
 *   - eventType="progress" + stage="tile_failed" → bad
 *   - eventType="progress" + stage starts with "skipped" → muted
 *   - jobIsRunning + last event                → running (pulsing)
 *   - otherwise                                → accent (cyan)
 */
export interface TimelineEvent {
  id: string;
  eventType: string;
  stage: string | null;
  message: string | null;
  current: number | null;
  total: number | null;
  details: unknown;
  createdAt: Date | string;
}

type DotVariant = "ok" | "bad" | "warn" | "muted" | "accent" | "running";

function dotVariant(
  e: TimelineEvent,
  isLast: boolean,
  jobIsRunning: boolean,
): DotVariant {
  if (e.eventType === "result") {
    if (e.stage === "succeeded") return "ok";
    if (e.stage === "failed")    return "bad";
    return "warn";
  }
  if (e.stage === "tile_failed" || e.stage === "item_failed") return "bad";
  if (e.stage?.startsWith("skipped"))                          return "muted";
  if (isLast && jobIsRunning)                                  return "running";
  return "accent";
}

const DOT_CLASS: Record<DotVariant, string> = {
  ok:      "timeline-dot timeline-dot-ok",
  bad:     "timeline-dot timeline-dot-bad",
  warn:    "timeline-dot timeline-dot-warn",
  muted:   "timeline-dot timeline-dot-muted",
  accent:  "timeline-dot timeline-dot-accent",
  running: "timeline-dot timeline-dot-running",
};

const STAGE_TONE: Record<string, string> = {
  succeeded: "text-ok",
  failed:    "text-bad",
};

export default function ActivityTimeline({
  events,
  jobIsRunning = false,
  emptyHint = "No events recorded.",
}: {
  events: TimelineEvent[];
  jobIsRunning?: boolean;
  emptyHint?: string;
}) {
  if (!events.length) {
    return <p className="text-sm text-muted">{emptyHint}</p>;
  }

  return (
    <ol className="relative pl-4">
      {/* Vertical guide line behind the dots. */}
      <span
        aria-hidden="true"
        className="absolute left-[5px] top-2 bottom-2 w-px bg-border"
      />
      {events.map((e, i) => {
        const variant = dotVariant(e, i === events.length - 1, jobIsRunning);
        return (
          <li key={e.id} className="relative pl-5 py-2.5 flex gap-3">
            <span
              className={`${DOT_CLASS[variant]} absolute -left-[3px]`}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                {e.stage && (
                  <code className={`text-xs ${STAGE_TONE[e.stage ?? ""] ?? "text-text"}`}>
                    {e.stage}
                  </code>
                )}
                {(e.current !== null || e.total !== null) && (
                  <span className="chip">
                    {e.current ?? "?"} / {e.total ?? "?"}
                  </span>
                )}
                <time
                  className="text-[11px] text-muted ml-auto whitespace-nowrap"
                  dateTime={
                    e.createdAt instanceof Date
                      ? e.createdAt.toISOString()
                      : String(e.createdAt)
                  }
                >
                  {new Date(e.createdAt).toLocaleTimeString()}
                </time>
              </div>
              {e.message && (
                <div className="text-sm text-text/85 mt-0.5 break-words">
                  {e.message}
                </div>
              )}
              {e.details !== null && e.details !== undefined && e.details !== "" && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[11px] text-muted hover:text-text select-none">
                    details
                  </summary>
                  <pre className="mt-1 text-[11px] bg-bg/80 border border-border rounded-lg p-2 overflow-x-auto">
{prettyJson(e.details)}
                  </pre>
                </details>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
