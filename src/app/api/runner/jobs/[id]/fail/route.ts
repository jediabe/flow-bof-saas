import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encodeJson } from "@/lib/json-column";
import { recordRunnerActivity } from "@/lib/runner-auth";
import { notFound, readJson, requireAgent } from "../../../_lib";

export const dynamic = "force-dynamic";

/**
 * Hard-fail short-circuit. The runner uses this when something blew
 * up *outside* the agent_api handler — e.g. the runner caught an
 * unexpected exception in the polling loop and wants to mark the job
 * failed without going through a full envelope.
 *
 * For the normal sad-path (the handler ran, returned status=failed,
 * and the runner POSTed the envelope to /complete), use /complete
 * instead — it stores both the result and the error.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const agentOr401 = await requireAgent(req);
  if (agentOr401 instanceof NextResponse) return agentOr401;
  const agent = agentOr401;

  const { id } = await ctx.params;
  const job = await db.job.findFirst({
    where: { id, agentId: agent.id },
    select: { id: true },
  });
  if (!job) return notFound("job not found for this agent");

  const body = await readJson<{
    error?: { code?: string; message?: string; details?: unknown };
  }>(req);
  const err = body.error ?? { code: "RUNNER_FAILURE", message: "unspecified" };

  await recordRunnerActivity({
    id: agent.id,
    connectedAt: agent.connectedAt,
  });

  await db.job.update({
    where: { id: job.id },
    data: {
      status: "failed",
      error: encodeJson(err),
    },
  });

  await db.jobEvent.create({
    data: {
      jobId: job.id,
      eventType: "result",
      stage: "failed",
      message: err.message ?? null,
      details: encodeJson(err),
    },
  });

  return NextResponse.json(
    { ok: true, status: "failed" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
