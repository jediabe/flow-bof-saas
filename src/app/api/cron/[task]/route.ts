import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { refreshAccountSnapshot } from "@/lib/tikhub-refresh";

/**
 * Cron endpoints for the BOF Dashboard.
 *
 * Two tasks today:
 *   - POST /api/cron/health-and-revenue   (6-hourly)
 *       Refreshes health + revenue + P&L for every connected
 *       account in every workspace. Skips per-product detail.
 *   - POST /api/cron/products             (24-hourly)
 *       Same as above plus per-product analytics. Heavier — TikHub
 *       returns many rows per account; runs once a day to keep the
 *       per-key concurrency budget low.
 *
 * Auth: a single shared CRON_SECRET in the request's
 * `Authorization: Bearer <secret>` header. The cron infra (Docker
 * host crontab, Vercel Cron, etc.) holds the secret. Middleware
 * doesn't gate this path because the path lives under /api/ and
 * we want a clean 401 rather than a session-cookie redirect — so
 * we add the route to the middleware skip list separately.
 *
 * Behaviour:
 *   - Iterates accounts ACROSS all workspaces. Tenancy is
 *     preserved by refreshAccountSnapshot() (it takes workspaceId
 *     and filters internally).
 *   - Each account refresh is independent — a failing one does NOT
 *     stop the loop. Errors are recorded against the account row
 *     (cookieStatus = "expired" / "error") and surfaced in the
 *     final summary.
 *   - Returns a JSON summary suitable for cron logs.
 */

const VALID_TASKS = new Set(["health-and-revenue", "products"]);
const MAX_ACCOUNTS_PER_RUN = 500;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ task: string }> },
) {
  const { task } = await ctx.params;
  if (!VALID_TASKS.has(task)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNKNOWN_TASK",
          message: `task '${task}' is not one of ${[...VALID_TASKS].join(", ")}`,
        },
      },
      { status: 404 },
    );
  }

  const auth = req.headers.get("authorization") || "";
  const expected = (process.env.CRON_SECRET || "").trim();
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "CRON_SECRET_UNSET",
          message:
            "CRON_SECRET is not configured on the server. Set it in .env and restart.",
        },
      },
      { status: 500 },
    );
  }
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Bearer auth required." } },
      { status: 401 },
    );
  }
  const presented = auth.slice(7).trim();
  // Constant-time compare to avoid leaking byte-by-byte timing.
  if (!constantTimeEq(presented, expected)) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid CRON_SECRET." } },
      { status: 401 },
    );
  }

  const includeProducts = task === "products";

  // Pull just enough to dispatch — refreshAccountSnapshot re-loads
  // the row by id inside its own transaction so we don't need
  // the full row here.
  const accounts = await db.tikTokAccount.findMany({
    take: MAX_ACCOUNTS_PER_RUN,
    select: { id: true, workspaceId: true, label: true },
    // Deterministic order so a cron retry after a crash re-attempts
    // the same set in the same sequence.
    orderBy: [{ createdAt: "asc" }],
  });

  const results: Array<{
    id: string;
    label: string;
    ok: boolean;
    message: string;
  }> = [];

  for (const a of accounts) {
    try {
      const r = await refreshAccountSnapshot({
        accountId: a.id,
        workspaceId: a.workspaceId,
        includeProducts,
      });
      results.push({ id: a.id, label: a.label, ok: r.ok, message: r.message });
    } catch (err) {
      const e = err as Error;
      results.push({
        id: a.id,
        label: a.label,
        ok: false,
        message: `${e.name}: ${e.message.slice(0, 200)}`,
      });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return NextResponse.json({
    ok: true,
    task,
    summary: {
      attempted: results.length,
      succeeded: ok,
      failed,
    },
    results,
  });
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return m === 0;
}
