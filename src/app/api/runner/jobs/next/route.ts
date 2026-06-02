import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordRunnerActivity } from "@/lib/runner-auth";
import { parseJson } from "@/lib/json-column";
import { PROTOCOL_VERSION } from "@/lib/agent-client";
import { readJson, requireAgent } from "../../_lib";

export const dynamic = "force-dynamic";

/**
 * Poll for the next queued job for this agent.
 *
 *   - Filters Job rows to agentId == this agent + status == "queued".
 *   - Optionally filters by the runner's declared `capabilities`
 *     (the runner only knows how to handle a fixed set of job types;
 *     we never hand it a `tiktok_draft` if it can't run that).
 *   - Atomically marks the chosen row as "running" so two concurrent
 *     pollers can't claim the same job.
 *
 * Returns `{ job: null }` when nothing is available; the runner sleeps
 * and tries again.
 */
export async function POST(req: Request) {
  const agentOr401 = await requireAgent(req);
  if (agentOr401 instanceof NextResponse) return agentOr401;
  const agent = agentOr401;

  const body = await readJson<{ capabilities?: string[] }>(req);
  const caps = Array.isArray(body.capabilities)
    ? body.capabilities.filter((c) => typeof c === "string")
    : [];

  await recordRunnerActivity(
    { id: agent.id, connectedAt: agent.connectedAt },
    // Polling alone doesn't flip status to online — only /health
    // does, so a runner that's pulling jobs but has never said
    // hello stays in "unknown". (In practice it'll have hit /health
    // first.)
    { markOnline: false },
  );

  // Atomic claim. We pick the oldest queued row, attempt an UPDATE
  // gated on status == "queued", and only return the row if the
  // update matched. Two pollers racing each other will only ever get
  // one win each — Prisma's `updateMany` returns `{ count }` for the
  // matched rows so a `0` means "someone else got it first".
  //
  // Repeats until we either claim a row or run out of candidates.
  // In practice this loop runs once almost every time.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = await db.job.findFirst({
      where: {
        agentId: agent.id,
        status: "queued",
        ...(caps.length > 0 ? { jobType: { in: caps } } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, jobType: true, payload: true },
    });
    if (!candidate) {
      return NextResponse.json(
        { ok: true, job: null },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const claim = await db.job.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running" },
    });
    if (claim.count === 0) {
      // Someone else won the race — pick a different candidate.
      continue;
    }

    return NextResponse.json(
      {
        ok: true,
        job: {
          // Envelope shape mirrors what the agent's CLI / HTTP API
          // would receive from /jobs/run. The runner can hand this
          // dict straight to handle_agent_job().
          id: candidate.id,
          protocol_version: PROTOCOL_VERSION,
          job_id: candidate.id,
          job_type: candidate.jobType,
          payload: parseJson(candidate.payload) ?? {},
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // We thrashed for 5 candidates without claiming one. Almost certainly
  // means another poller is racing us; tell this one to back off and
  // retry on its next tick.
  return NextResponse.json(
    { ok: true, job: null, note: "contended; retry" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
