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
  const job = await db.job.findFirst({
    where: { id, agentId: agent.id },
    select: { id: true },
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

  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}
