import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encodeJson } from "@/lib/json-column";
import { recordRunnerActivity } from "@/lib/runner-auth";
import {
  badRequest,
  notFound,
  readJson,
  requireAgent,
} from "../../../_lib";

export const dynamic = "force-dynamic";

/**
 * Final-result POST from the runner. Body shape:
 *
 *   {
 *     "envelope": {
 *       "protocol_version": "0.1",
 *       "job_id": "...",
 *       "job_type": "...",
 *       "status": "succeeded" | "failed",
 *       "result": {...} | null,
 *       "error":  {...} | null
 *     }
 *   }
 *
 * We map envelope.status -> Job.status and persist result/error.
 * The final `result` JobEvent matches the shape direct-mode jobs
 * already write (see app/jobs/actions.ts:createSampleJob's tail).
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
    select: { id: true, batchId: true },
  });
  if (!job) return notFound("job not found for this agent");

  const body = await readJson<{
    envelope?: {
      status?: string;
      result?: unknown;
      error?: { code?: string; message?: string; details?: unknown } | null;
    };
  }>(req);

  const env = body.envelope;
  if (!env) return badRequest("missing `envelope` in request body");

  const succeeded = env.status === "succeeded";
  const newStatus = succeeded ? "succeeded" : "failed";

  await recordRunnerActivity({
    id: agent.id,
    connectedAt: agent.connectedAt,
  });

  await db.job.update({
    where: { id: job.id },
    data: {
      status: newStatus,
      result: env.result != null ? encodeJson(env.result) : null,
      error:  env.error  != null ? encodeJson(env.error)  : null,
    },
  });

  await db.jobEvent.create({
    data: {
      jobId: job.id,
      eventType: "result",
      stage: newStatus,
      message: env.error?.message ?? "ok",
      details:
        env.result != null || env.error != null
          ? encodeJson(env.result ?? env.error)
          : null,
    },
  });

  return NextResponse.json(
    { ok: true, status: newStatus },
    { headers: { "Cache-Control": "no-store" } },
  );
}
