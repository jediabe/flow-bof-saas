"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import {
  buildEnvelope,
  runJob,
  runJobStream,
  type JobEnvelopeResponse,
  type ProgressEvent,
} from "@/lib/agent-client";
import { encodeJson } from "@/lib/json-column";
import { getRunnerMode } from "@/lib/runner-mode";
import { loadOrCreateSettings } from "@/lib/workspace-settings";

/**
 * v0.6.15-alpha — pre-dispatch gates for Flow-driving jobs.
 *
 * Two checks, in order:
 *   1. Cooldown — if the runner reported PUBLIC_ERROR_UNUSUAL_ACTIVITY*
 *      within the last `cooldownHours`, refuse to dispatch. Submitting
 *      while the session score is in the gutter only compounds it.
 *   2. Daily cap — if the workspace has already submitted
 *      `dailyImageSubmitCap` Flow submits (images + videos combined)
 *      in the last 24h (rolling window), refuse. Targets the
 *      PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC volume signal.
 *
 * Video jobs go through the same guard because:
 *   - reCAPTCHA Enterprise scores the SESSION, not the action type.
 *     A video submit hits the same Flow API surface and contributes
 *     to the same risk score.
 *   - End-user observed "1 video succeeded, next 2 hit unusual
 *     activity" on a Family Plan account — clear evidence the
 *     volume signal trips for videos too.
 *   - One shared cap is simpler to reason about than per-type caps.
 *
 * Returns { ok: true } when dispatch is allowed; otherwise a
 * user-facing message explaining which gate fired and roughly when
 * it'll clear.
 */
async function checkFlowDispatchGuards(input: {
  workspaceId: string;
  jobType: string;
  requestedItems: number;
  /** When true, skip the cooldown check. The daily cap still
   *  applies (volume signal is a hard limit; cooldown is more
   *  about "session score is recovering"). Used by the per-
   *  product "Generate anyway" button so an operator who knows
   *  the account is healthy can push one through without
   *  waiting the full cooldown window. */
  bypassCooldown?: boolean;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const settings = await loadOrCreateSettings(input.workspaceId);
  const isVideo = input.jobType === "generate_flow_videos_from_favorites";
  const actionLabel = isVideo ? "video gen" : "image gen";

  // 1. Cooldown check (skipped when bypassCooldown is set).
  if (!input.bypassCooldown && settings.lastUnusualActivityAt) {
    const cooldownMs = settings.cooldownHours * 60 * 60 * 1000;
    const elapsed = Date.now() - settings.lastUnusualActivityAt.getTime();
    if (elapsed < cooldownMs) {
      const remainingMin = Math.ceil((cooldownMs - elapsed) / 60_000);
      const remainingLabel =
        remainingMin >= 60
          ? `${Math.ceil(remainingMin / 60)}h ${remainingMin % 60}m`
          : `${remainingMin}m`;
      const reason = settings.lastUnusualActivityReason ?? "PUBLIC_ERROR_UNUSUAL_ACTIVITY";
      return {
        ok: false,
        message:
          `Google Flow flagged this session with ${reason}. ` +
          `Holding off ${actionLabel} for ${remainingLabel} so the session score ` +
          `recovers — submitting now would compound the score. ` +
          `Use Flow manually in the meantime (browse, generate 1-2 by hand) to help warm the account back up.`,
      };
    }
  }

  // 2. Daily cap check. Sum item counts across BOTH image and video
  //    jobs in the workspace over the last 24h — one shared budget,
  //    since reCAPTCHA scores the session not the action type.
  //    Video jobs don't carry an `items` array in their payload
  //    (they're driven by favorited-tile scan results, not a
  //    pre-built list), so we approximate one tile = one submit
  //    and read `submitted` from the job result when present, else
  //    fall back to 1.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await db.job.findMany({
    where: {
      workspaceId: input.workspaceId,
      jobType: { in: ["generate_flow_images", "generate_flow_videos_from_favorites"] },
      createdAt: { gte: since },
      status: { in: ["queued", "running", "succeeded"] },
    },
    select: { jobType: true, payload: true, result: true },
  });
  let submittedLast24h = 0;
  for (const j of recent) {
    try {
      if (j.jobType === "generate_flow_images") {
        const p = j.payload ? JSON.parse(j.payload) : null;
        const items = Array.isArray(p?.items) ? p.items : [];
        submittedLast24h += items.length;
      } else {
        // Video job — use the final submitted count when available.
        // For in-flight jobs the result is null; assume worst-case
        // 1 to keep the gate conservative.
        const r = j.result ? JSON.parse(j.result) : null;
        const n = typeof r?.submitted === "number" ? r.submitted : 1;
        submittedLast24h += n;
      }
    } catch {
      // Malformed payload — count one submit as a conservative default.
      submittedLast24h += 1;
    }
  }
  if (submittedLast24h + input.requestedItems > settings.dailyImageSubmitCap) {
    return {
      ok: false,
      message:
        `Daily Flow submit cap reached (${submittedLast24h}/${settings.dailyImageSubmitCap} submitted in the last 24h, ` +
        `${input.requestedItems} more requested for ${actionLabel}). The cap ` +
        `defends against the PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC volume ` +
        `signal and counts both images and videos against the same budget ` +
        `(reCAPTCHA scores the session, not the action type). Raise the cap ` +
        `in Settings if you need more headroom, or wait until earlier submits roll off.`,
    };
  }

  return { ok: true };
}

/**
 * SQLite-friendly job status strings. Mirrors the values the Postgres
 * schema enum would carry. Keep in sync with the comment in
 * prisma/schema.prisma.
 */
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * Job types we dispatch via `/jobs/run-stream` so the per-tile progress
 * events become rows in the JobEvent table — the user sees a real
 * timeline instead of just a single result.
 *
 * scan_favorited_images is fast enough that streaming would add more
 * UI complexity than it's worth; it stays on the non-streaming path.
 */
const STREAMING_JOB_TYPES = new Set<string>([
  "generate_flow_videos_from_favorites",
  "generate_flow_images",
]);

/**
 * Create a new Job row + dispatch it to the agent. Persist progress
 * events (for streaming jobs) and the final result; return the
 * Job.id so the caller can navigate to the detail page.
 *
 * Synchronous server-action on purpose — the request blocks for the
 * lifetime of the agent call. For long video batches that can be
 * many minutes; a future Phase-5 background worker will move this
 * off the request thread. The browser polls /jobs/[id] (force-dynamic)
 * if it wants to watch progress before this action resolves.
 */
export async function createSampleJob(input: {
  jobType: string;
  agentId: string;
  batchId?: string | null;
  payload?: Record<string, unknown>;
  /** When true, the cooldown gate is skipped at dispatch time.
   *  Daily cap still applies. Designed for the per-product
   *  "Generate anyway" button — an operator who knows the account
   *  is healthy can push a single product through without waiting
   *  the full cooldown. */
  bypassCooldown?: boolean;
}): Promise<{ ok: boolean; jobId: string; message: string }> {
  const { workspace } = await getCurrentWorkspace();

  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: workspace.id },
  });
  if (!agent) {
    return { ok: false, jobId: "", message: "agent not found in this workspace" };
  }

  // Defensive: catch "user clicked Generate Images with nothing
  // eligible" before the row hits the DB / runner. Without this
  // the runner emits a `MISSING_ITEMS` failure from inside
  // _handle_generate_flow_images and we'd surface a cryptic
  // 'payload.items must be a non-empty list' message to the UI.
  //
  // Only the items-driven types need this gate — health_check,
  // check_flow_connection, scan_favorited_images, and the
  // favorites-driven video job all take empty / sparse payloads
  // on purpose.
  // v0.6.15-alpha anti-block: refuse to dispatch Flow-driving jobs
  // (image + video) while the workspace is in cooldown (within N
  // hours of a PUBLIC_ERROR_UNUSUAL_ACTIVITY*) OR when the shared
  // daily Flow-submit cap is exhausted. The check is BEFORE the
  // Job row is created so a refused dispatch doesn't pollute the
  // timeline. Both job types share one budget because reCAPTCHA
  // scores the SESSION, not the action type — an image submit and
  // a video submit contribute equally to the risk score.
  const FLOW_DRIVING_JOBS = new Set<string>([
    "generate_flow_images",
    "generate_flow_videos_from_favorites",
  ]);
  if (FLOW_DRIVING_JOBS.has(input.jobType)) {
    // Video jobs don't ship an items[] in payload (they discover
    // favorited tiles inside the runner). Best estimate from the
    // SaaS side: 1 submit minimum. The runner's own per-tile
    // unusual-activity abort handles the upper bound at runtime.
    const requestedItems =
      input.jobType === "generate_flow_images"
        ? Array.isArray((input.payload as { items?: unknown })?.items)
          ? ((input.payload as { items?: unknown[] }).items?.length ?? 0)
          : 0
        : 1;
    const guard = await checkFlowDispatchGuards({
      workspaceId: workspace.id,
      jobType: input.jobType,
      requestedItems,
      bypassCooldown: input.bypassCooldown === true,
    });
    if (!guard.ok) {
      return { ok: false, jobId: "", message: guard.message };
    }
  }

  const ITEM_DRIVEN_JOBS = new Set<string>(["generate_flow_images"]);
  if (ITEM_DRIVEN_JOBS.has(input.jobType)) {
    const items = (input.payload as { items?: unknown })?.items;
    const itemsCount = Array.isArray(items) ? items.length : -1;
    // Verbose enough to actually answer "what did the SaaS dispatch?"
    // when the runner returns MISSING_ITEMS. Lands in `docker logs
    // app` on the VPS. No secrets here — payload items are public
    // workspace data the runner already sees.
    console.log(
      `[jobs.createSampleJob] dispatch type=${input.jobType} agent=${input.agentId} ` +
        `batch=${input.batchId ?? "-"} items=${itemsCount} keys=${Object.keys(input.payload ?? {}).join(",")}`,
    );
    if (!Array.isArray(items) || items.length === 0) {
      return {
        ok: false,
        jobId: "",
        message:
          "No products are ready for image generation. Each product needs " +
          "an imagePrompt and a reference image — use the AI Prompt " +
          "Generation panel above, then try again.",
      };
    }
  }

  // Persist the queued job FIRST so failures still leave a trace.
  const job = await db.job.create({
    data: {
      workspaceId: workspace.id,
      batchId: input.batchId || null,
      agentId: agent.id,
      jobType: input.jobType,
      status: "queued",
      payload: encodeJson(input.payload ?? {}),
    },
  });

  // Polling vs direct dispatch.
  //
  // - "polling"  — the runner reaches us, not the other way around.
  //   We just leave the row at status="queued"; the connected runner
  //   pulls it via /api/runner/jobs/next. Used for hosted production
  //   (the SaaS can't punch into the user's localhost).
  // - "direct"   — local-dev path. The SaaS calls the agent's HTTP API
  //   directly and blocks until it returns.
  //
  // Mode is resolved centrally in src/lib/runner-mode.ts so the
  // dispatcher, the health probe, and the UI banner all agree.
  if (getRunnerMode() === "polling") {
    revalidatePath("/jobs");
    revalidatePath(`/jobs/${job.id}`);
    revalidatePath("/dashboard");
    if (input.batchId) revalidatePath(`/batches/${input.batchId}`);
    return {
      ok: true,
      jobId: job.id,
      message:
        "Queued. Waiting for the connected runner to claim it.",
    };
  }

  // Build the envelope using the Job's id so the agent's logs +
  // our DB row share an ID.
  const envelope = buildEnvelope(input.jobType, input.payload ?? {}, job.id);

  await db.job.update({
    where: { id: job.id },
    data: { status: "running" },
  });
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${job.id}`);

  const token = process.env.AGENT_API_TOKEN || undefined;

  // Catch direct-mode connection failures (ECONNREFUSED etc.) and
  // surface them as a clean failed Job. Without this, an offline
  // local runner crashes the whole server-action with `fetch failed`
  // and the user sees a 500 instead of a "Local runner not reachable"
  // result they can act on.
  let envelopeBack: JobEnvelopeResponse;
  try {
    if (STREAMING_JOB_TYPES.has(input.jobType)) {
      envelopeBack = await dispatchStreaming(job.id, agent.baseUrl, envelope, token);
    } else {
      envelopeBack = await runJob(agent.baseUrl, envelope, token);
    }
  } catch (err) {
    const e = err as Error;
    envelopeBack = {
      protocol_version: "0.1",
      job_id:   job.id,
      job_type: input.jobType,
      status:   "failed",
      result:   null,
      error: {
        code:    "AGENT_UNREACHABLE",
        message:
          "Local runner not reachable at " + agent.baseUrl + ": " +
          `${e.name}: ${String(e.message ?? e).slice(0, 200)}`,
      },
    };
  }

  const newStatus: JobStatus =
    envelopeBack.status === "succeeded" ? "succeeded" : "failed";

  await db.job.update({
    where: { id: job.id },
    data: {
      status: newStatus,
      result: envelopeBack.result ? encodeJson(envelopeBack.result) : null,
      error: envelopeBack.error ? encodeJson(envelopeBack.error) : null,
    },
  });

  // v0.6.15-alpha — if the runner reported a Flow risk-engine hit
  // (PUBLIC_ERROR_UNUSUAL_ACTIVITY*), stamp lastUnusualActivityAt
  // on WorkspaceSettings so subsequent dispatches enter cooldown.
  // The runner returns _failure(..., details={risk_phrase}) which
  // lands at envelopeBack.error.details.risk_phrase. Accepts new
  // HTTP-level codes (unusual_activity, unusual_activity_too_much_traffic)
  // and older DOM-scrape strings (too_many_requests / rate_limit /
  // try_again_later / soft_block).
  try {
    const details =
      ((envelopeBack.error as { details?: unknown })?.details ?? null) as
        | { risk_phrase?: string }
        | null;
    const riskPhrase = details?.risk_phrase ?? null;
    if (riskPhrase && typeof riskPhrase === "string") {
      await db.workspaceSettings.update({
        where: { workspaceId: workspace.id },
        data: {
          lastUnusualActivityAt: new Date(),
          lastUnusualActivityReason: riskPhrase,
        },
      });
    }
  } catch {
    // Cooldown bookkeeping must not break the job-result write.
  }

  // Persist a final `result` JobEvent for the timeline. For streaming
  // jobs this caps a series of `progress` events; for non-streaming
  // jobs it's the only event row.
  await db.jobEvent.create({
    data: {
      jobId: job.id,
      eventType: "result",
      stage: newStatus,
      message: envelopeBack.error?.message ?? "ok",
      details: (envelopeBack.result || envelopeBack.error)
        ? encodeJson(envelopeBack.result ?? envelopeBack.error)
        : null,
    },
  });

  // Bump the agent's lastSeenAt if the call returned anything sensible.
  await db.agent.update({
    where: { id: agent.id },
    data: {
      status: envelopeBack.status === "succeeded" ? "online" : "offline",
      lastSeenAt: new Date(),
    },
  });

  revalidatePath("/jobs");
  revalidatePath(`/jobs/${job.id}`);
  revalidatePath("/dashboard");
  if (input.batchId) revalidatePath(`/batches/${input.batchId}`);

  return {
    ok: envelopeBack.status === "succeeded",
    jobId: job.id,
    message:
      envelopeBack.status === "succeeded"
        ? "Job completed."
        : envelopeBack.error?.message ?? "Job failed.",
  };
}

/**
 * Stream a job from /jobs/run-stream and persist each progress event
 * as a JobEvent row.
 *
 * We persist events one-at-a-time (not batched) so a long-running job
 * shows partial progress when the user opens /jobs/[id] mid-flight.
 * SQLite can handle ~one insert per tile easily for our scale (tens
 * of events per batch).
 *
 * Per-event DB write failures are swallowed — the stream MUST keep
 * draining so the agent doesn't stall. If we lose one event the
 * timeline has a gap; the final result envelope still lands.
 */
async function dispatchStreaming(
  jobId: string,
  baseUrl: string,
  envelope: ReturnType<typeof buildEnvelope>,
  token: string | undefined,
): Promise<JobEnvelopeResponse> {
  let lastProgressPath = `/jobs/${jobId}`;
  return runJobStream(
    baseUrl,
    envelope,
    async (event) => {
      if (event.event_type !== "progress") return;
      const p = event as ProgressEvent;
      try {
        await db.jobEvent.create({
          data: {
            jobId,
            eventType: "progress",
            stage: p.stage || null,
            message: p.message || null,
            current: p.current ?? null,
            total: p.total ?? null,
            details: p.details ? encodeJson(p.details) : null,
          },
        });
        // Revalidate /jobs/[id] periodically so an open tab picks up
        // the new event on its next refresh. Cheap — Next coalesces.
        revalidatePath(lastProgressPath);
      } catch {
        // Per-event DB write must not break the stream.
      }
    },
    token,
  );
}
