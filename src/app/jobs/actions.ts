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
}): Promise<{ ok: boolean; jobId: string; message: string }> {
  const { workspace } = await getCurrentWorkspace();

  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: workspace.id },
  });
  if (!agent) {
    return { ok: false, jobId: "", message: "agent not found in this workspace" };
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

  let envelopeBack: JobEnvelopeResponse;
  if (STREAMING_JOB_TYPES.has(input.jobType)) {
    envelopeBack = await dispatchStreaming(job.id, agent.baseUrl, envelope, token);
  } else {
    envelopeBack = await runJob(agent.baseUrl, envelope, token);
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
