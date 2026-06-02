import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordRunnerActivity } from "@/lib/runner-auth";
import { readJson, requireAgent } from "../_lib";

export const dynamic = "force-dynamic";

/**
 * Runner check-in. The polling client calls this at startup and then
 * periodically inside its main loop. We:
 *
 *   1. Authenticate via Bearer token.
 *   2. Stamp lastSeenAt/lastPollAt = now, mark status=online, and
 *      set connectedAt iff this is the first health call after
 *      generation.
 *   3. Optionally persist the runner's reported capabilities — for
 *      now we just echo them back; a future ALPHA-2 milestone may
 *      add a capabilities column.
 *
 * Returns the agentId so the runner can sanity-check the binding.
 */
export async function POST(req: Request) {
  const agentOr401 = await requireAgent(req);
  if (agentOr401 instanceof NextResponse) return agentOr401;
  const agent = agentOr401;

  const body = await readJson<{
    runnerVersion?: string;
    platform?: string;
    capabilities?: string[];
  }>(req);

  await recordRunnerActivity(
    { id: agent.id, connectedAt: agent.connectedAt },
    { markOnline: true },
  );

  // We don't store capabilities yet — they're cheap to log and let
  // us flag a stale runner that's missing job types the UI is about
  // to ship. The /api/runner/jobs/next endpoint trusts the runner
  // to send them again every call, so persistence isn't required.
  const caps =
    Array.isArray(body.capabilities) ? body.capabilities.length : 0;
  if (caps > 0 || body.runnerVersion) {
    // No-op DB write — just logged via Prisma's default logger if
    // someone has it enabled. Intentionally NOT writing the raw
    // values to a separate audit table here.
    await db.agent.update({
      where: { id: agent.id },
      data: {}, // touches updatedAt
    });
  }

  return NextResponse.json(
    {
      ok: true,
      agentId: agent.id,
      serverTime: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
