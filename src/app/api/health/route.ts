import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Health endpoint. Used by:
 *   - Docker compose's healthcheck (if added later).
 *   - Caddy/Hostinger uptime probes.
 *   - Hand-rolled monitoring (curl https://app.example.com/api/health).
 *
 * Always returns HTTP 200 — even when the DB is unreachable — because
 * a JSON body with `database: "unreachable"` is more useful to a probe
 * than a connection-refused response. Flip to 503 here if you want
 * load balancers to drop the node on DB failure.
 *
 * Bypasses basic auth (see src/middleware.ts), so probes don't need
 * credentials.
 */

export const dynamic = "force-dynamic";

const VERSION = process.env.npm_package_version || "0.1.0";

export async function GET() {
  let database: "reachable" | "unreachable" = "unreachable";
  let dbError: string | null = null;
  try {
    // Minimal-cost ping. Works on both SQLite and Postgres.
    await db.$queryRawUnsafe<unknown>("SELECT 1");
    database = "reachable";
  } catch (err) {
    dbError = `${(err as Error).name}: ${String((err as Error).message ?? err).slice(0, 200)}`;
  }

  return NextResponse.json(
    {
      ok: true,
      version: VERSION,
      database,
      ...(dbError ? { databaseError: dbError } : {}),
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
