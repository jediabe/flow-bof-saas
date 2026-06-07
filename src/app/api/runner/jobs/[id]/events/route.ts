import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encodeJson } from "@/lib/json-column";
import { recordRunnerActivity } from "@/lib/runner-auth";
import { readJson, requireAgent, notFound } from "../../../_lib";

export const dynamic = "force-dynamic";

/**
 * Persist a progress event the runner emitted mid-job. Mirrors the
 * NDJSON streaming path the SaaS already uses for direct-mode jobs
 * (see app/jobs/actions.ts:dispatchStreaming) — one JobEvent row per
 * event so the timeline shows progress without re-pulling the final
 * result.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const agentOr401 = await requireAgent(req);
  if (agentOr401 instanceof NextResponse) return agentOr401;
  const agent = agentOr401;

  const { id } = await ctx.params;

  // Scope by both jobId AND agentId — a token compromise on one
  // agent should never let it write to another agent's jobs.
  // Pull `status` too so we can echo a cancellation hint back in
  // the response — the runner uses this to exit cooperative-cancel
  // mid-loop without needing a separate polling endpoint.
  const job = await db.job.findFirst({
    where: { id, agentId: agent.id },
    select: { id: true, status: true },
  });
  if (!job) return notFound("job not found for this agent");

  const body = await readJson<{
    stage?: string;
    message?: string;
    current?: number | null;
    total?: number | null;
    details?: unknown;
    event_type?: string;
  }>(req);

  await recordRunnerActivity({
    id: agent.id,
    connectedAt: agent.connectedAt,
  });

  await db.jobEvent.create({
    data: {
      jobId: job.id,
      // Default "progress" — the dedicated /complete + /fail routes
      // write the final "result" / "error" entries.
      eventType: body.event_type === "result" ? "result" : "progress",
      stage:   body.stage   ?? null,
      message: body.message ?? null,
      current: typeof body.current === "number" ? body.current : null,
      total:   typeof body.total   === "number" ? body.total   : null,
      details: body.details != null ? encodeJson(body.details) : null,
    },
  });

  // Cooperative cancel: when a user clicks "Stop generation" the
  // SaaS sets the Job's status to "cancelled" in the DB. The runner
  // is mid-loop and can't be reached directly, but it ALREADY POSTs
  // an event between items (progress callback). We echo the
  // cancellation hint in the response here so the runner can read
  // it and exit cleanly at the next iteration boundary without
  // needing a separate /should-continue endpoint.
  const cancelled = job.status === "cancelled";

  return NextResponse.json(
    { ok: true, cancelled },
    { headers: { "Cache-Control": "no-store" } },
  );
}
