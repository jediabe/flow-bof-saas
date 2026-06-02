"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createSampleJob } from "../../jobs/actions";

interface AgentRow {
  id: string;
  name: string;
  baseUrl: string;
  status: string;
}

interface ScanSummary {
  favoritedImages: number | null;
  tilesScanned:    number | null;
  lastScanJobId:   string | null;
  lastScanAt:      string | null;
}

interface VideoSummary {
  submitted:      number | null;
  skipped:        number | null;
  failed:         number | null;
  lastVideoJobId: string | null;
  lastVideoAt:    string | null;
}

/**
 * The "workbench" sections of a batch detail page — image gen, scan
 * favorites, generate videos. Each is its own labeled panel so the
 * user can see the pipeline as a sequence of stages, not a row of
 * unmoored buttons.
 *
 * The actual job-submit path goes through createSampleJob (same as
 * before); the only thing this component owns is the surface.
 */
export default function BatchWorkbench({
  batchId,
  agents,
  scanSummary,
  videoSummary,
}: {
  batchId: string;
  agents: AgentRow[];
  scanSummary: ScanSummary;
  videoSummary: VideoSummary;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [includeAlreadySubmitted, setIncludeAlreadySubmitted] = useState(false);

  const submit = (
    jobType: string,
    payload: Record<string, unknown>,
  ) => {
    setLastError(null);
    setActiveJob(jobType);
    startTransition(async () => {
      const r = await createSampleJob({
        jobType,
        agentId,
        batchId,
        payload,
      });
      // Stay on the batch page either way — surface the result inline
      // via the ?job=<id> query param. The batch page's
      // LatestTaskResult panel reads that param and renders the
      // friendly summary; /jobs/[id] is still linked from there for
      // technical drill-down.
      if (r.jobId) {
        router.push(`/batches/${batchId}?job=${r.jobId}#activity`);
      }
      if (!r.ok) {
        setLastError(r.message);
      }
      setActiveJob(null);
    });
  };

  const disabled = pending || !agentId;

  return (
    <div className="space-y-5">
      {/* Runner selector ---------------------------------------------- */}
      <section className="panel p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[16rem]">
            <label className="label">Runner</label>
            <select
              className="field"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.status}
                </option>
              ))}
            </select>
            <div className="text-[11px] text-muted mt-1">
              Selected runner will receive every action below.
            </div>
          </div>
          <button
            className="btn"
            disabled={disabled}
            onClick={() => submit("health_check", {})}
          >
            {pending && activeJob === "health_check" ? "Pinging…" : "Ping runner"}
          </button>
          <button
            className="btn"
            disabled={disabled}
            onClick={() => submit("check_flow_connection", {})}
          >
            {pending && activeJob === "check_flow_connection"
              ? "Checking…"
              : "Check Flow"}
          </button>
        </div>
      </section>

      {/* Image generation -------------------------------------------- */}
      <section className="panel p-5 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <div className="section-title">Image generation</div>
            <p className="text-xs text-muted mt-1">
              Submit reference images for every pending product so Flow
              renders fresh hero shots.
            </p>
          </div>
          <span className="text-[11px] text-muted">
            generate_flow_images
          </span>
        </div>
        <button
          className="btn btn-primary"
          disabled={disabled}
          onClick={() => submit("generate_flow_images", { regenerate: true })}
        >
          {pending && activeJob === "generate_flow_images"
            ? "Submitting…"
            : "Generate images in Flow"}
        </button>
      </section>

      {/* Favorites ---------------------------------------------------- */}
      <section className="panel p-5 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <div className="section-title">Favorites</div>
            <p className="text-xs text-muted mt-1">
              Sweep the current Flow project and capture every favorited
              tile. The cockpit uses these for the video step.
            </p>
          </div>
          <span className="text-[11px] text-muted">
            scan_favorited_images
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs text-muted">
          <span>
            Last scan:{" "}
            {scanSummary.lastScanAt
              ? new Date(scanSummary.lastScanAt).toLocaleString()
              : "—"}
          </span>
          {scanSummary.favoritedImages !== null && (
            <span>
              <span className="text-ok font-medium">
                {scanSummary.favoritedImages}
              </span>{" "}
              favorited images
            </span>
          )}
          {scanSummary.tilesScanned !== null && (
            <span>{scanSummary.tilesScanned} tiles scanned</span>
          )}
          {scanSummary.lastScanJobId && (
            <Link
              href={`/jobs/${scanSummary.lastScanJobId}`}
              className="text-accent hover:underline"
            >
              View last scan →
            </Link>
          )}
        </div>
        <button
          className="btn btn-primary"
          disabled={disabled}
          onClick={() =>
            submit("scan_favorited_images", {
              include_thumbnail_data_urls: true,
              limit: 30,
            })
          }
        >
          {pending && activeJob === "scan_favorited_images"
            ? "Scanning…"
            : "Scan favorites"}
        </button>
      </section>

      {/* Videos ------------------------------------------------------- */}
      <section className="panel p-5 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <div className="section-title">Videos</div>
            <p className="text-xs text-muted mt-1">
              Push each favorited image through the video generator using
              the blanket video prompt. Generated videos remain in
              Google Flow — download them from{" "}
              <a
                href="https://labs.google/flow"
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                Flow
              </a>{" "}
              when ready.
            </p>
          </div>
          <span className="text-[11px] text-muted">
            generate_flow_videos_from_favorites
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs text-muted">
          <span>
            Last run:{" "}
            {videoSummary.lastVideoAt
              ? new Date(videoSummary.lastVideoAt).toLocaleString()
              : "—"}
          </span>
          {videoSummary.submitted !== null && (
            <span>
              <span className="text-ok font-medium">
                {videoSummary.submitted}
              </span>{" "}
              submitted
            </span>
          )}
          {videoSummary.skipped ? (
            <span>
              <span className="text-warn font-medium">
                {videoSummary.skipped}
              </span>{" "}
              skipped
            </span>
          ) : null}
          {videoSummary.failed ? (
            <span>
              <span className="text-bad font-medium">
                {videoSummary.failed}
              </span>{" "}
              failed
            </span>
          ) : null}
          {videoSummary.lastVideoJobId && (
            <Link
              href={`/jobs/${videoSummary.lastVideoJobId}`}
              className="text-accent hover:underline"
            >
              View last run →
            </Link>
          )}
        </div>
        <label className="flex items-start gap-2 text-xs text-text cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={includeAlreadySubmitted}
            onChange={(e) => setIncludeAlreadySubmitted(e.target.checked)}
          />
          <span>
            <span className="font-medium">Include already submitted favorites</span>
            <span className="block text-muted mt-0.5">
              Re-submit favorites that the runner has already animated in a
              prior run.
            </span>
          </span>
        </label>
        <button
          className="btn btn-primary"
          disabled={disabled}
          onClick={() =>
            submit("generate_flow_videos_from_favorites", {
              limit: 30,
              include_already_submitted: includeAlreadySubmitted,
            })
          }
        >
          {pending && activeJob === "generate_flow_videos_from_favorites"
            ? "Submitting…"
            : "Generate videos"}
        </button>
      </section>

      {lastError && (
        <div className="text-xs text-bad px-1">⚠ {lastError}</div>
      )}
    </div>
  );
}
