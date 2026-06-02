"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSampleJob } from "../../jobs/actions";

interface AgentRow {
  id: string;
  name: string;
  baseUrl: string;
  status: string;
}

// Per-job-type default payloads. The agent treats missing fields as
// defaults, so we only set what the SaaS specifically wants different
// from the agent's defaults.
//
// scan_favorited_images: ask for base64-PNG screenshots of each tile
// (thumbnail_data_url). Flow's CDN thumbnails (thumbnail_src) only
// work when the browser carries the user's Google session cookie —
// which the SaaS origin doesn't have. Data URLs are self-contained
// and render reliably.
const SAMPLE_JOBS: ReadonlyArray<{
  type: string;
  label: string;
  payload: Record<string, unknown>;
}> = [
  { type: "health_check",                        label: "Health check",                       payload: {} },
  { type: "check_flow_connection",               label: "Check Flow connection",              payload: {} },
  { type: "scan_favorited_images",               label: "Scan favorited images",
    payload: { include_thumbnail_data_urls: true, limit: 30 } },
  { type: "generate_flow_videos_from_favorites", label: "Generate videos from favorites",     payload: {} },
] as const;

export default function SampleJobButtons({
  batchId,
  agents,
}: {
  batchId: string;
  agents: AgentRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [lastError, setLastError] = useState<string | null>(null);
  // Per-job knob: when the user clicks "Generate videos from favorites",
  // this flag overrides the payload to ask the agent to re-submit
  // favorites that were already animated in a prior run. False by
  // default — first runs proceed without picking up old work.
  const [includeAlreadySubmitted, setIncludeAlreadySubmitted] =
    useState<boolean>(false);

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label">Agent</label>
          <select
            className="field"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} — {a.baseUrl} ({a.status})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Per-job-type extra controls. Only the
          generate_flow_videos_from_favorites button reads this; for
          the other buttons it's a no-op. */}
      <div className="border-t border-border pt-3">
        <label className="flex items-start gap-2 text-xs text-text cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={includeAlreadySubmitted}
            onChange={(e) => setIncludeAlreadySubmitted(e.target.checked)}
          />
          <span>
            <span className="font-medium">
              Include already submitted favorited images
            </span>
            <span className="block text-muted mt-0.5">
              Use this if you want to regenerate videos for favorites that
              were already submitted before. Applies only to{" "}
              <code>generate_flow_videos_from_favorites</code>.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {SAMPLE_JOBS.map((s) => (
          <button
            key={s.type}
            className="btn"
            disabled={pending || !agentId}
            onClick={() => {
              setLastError(null);
              // Build the payload. For the videos-from-favorites
              // button, merge the checkbox state on top of the
              // SAMPLE_JOBS default. Other buttons use their default
              // payload verbatim.
              const payload =
                s.type === "generate_flow_videos_from_favorites"
                  ? {
                      ...s.payload,
                      limit: 30,
                      include_already_submitted: includeAlreadySubmitted,
                    }
                  : s.payload;
              startTransition(async () => {
                const r = await createSampleJob({
                  jobType: s.type,
                  agentId,
                  batchId,
                  payload,
                });
                if (r.ok) {
                  router.push(`/jobs/${r.jobId}`);
                } else {
                  setLastError(r.message);
                }
              });
            }}
          >
            {pending ? "Running…" : s.label}
          </button>
        ))}
      </div>

      {lastError && (
        <div className="text-xs text-bad">⚠ {lastError}</div>
      )}

      <p className="text-xs text-muted">
        Clicks above POST a job envelope to the selected agent's{" "}
        <code>/jobs/run</code> endpoint, persist the result, and route
        you to the Job detail page.
      </p>
    </div>
  );
}
