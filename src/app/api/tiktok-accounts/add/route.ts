import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { addTikTokAccountForWorkspace } from "@/app/settings/tiktok-accounts/actions";

/**
 * POST /api/tiktok-accounts/add
 *
 * Programmatic entry-point to add a TikTok Shop account without
 * pasting the cookie by hand. Called by flow-bof-automation's
 * scripts/fetch_tiktok_cookies.py after Patchright captures fresh
 * cookies from a logged-in browser context.
 *
 * Auth: `Authorization: Bearer <token>` where <token> is a
 * workspace-scoped API token minted from /settings. The token
 * unambiguously identifies which workspace the new account
 * belongs to — no separate workspaceId param needed.
 *
 * Request body (JSON):
 *   {
 *     "label":            "main_uk",              // required
 *     "region":           "UK",                    // required — "UK" | "US"
 *     "cookieRaw":        "sessionid=...; ...",    // required — TikTok Cookie header
 *     "monthlyToolCost":  0                        // optional, defaults to 0
 *   }
 *
 * Response (200):
 *   { "ok": true, "accountId": "cxxx...", "message": "Account ..." }
 *
 * Errors:
 *   401  Missing / bad Bearer token
 *   400  Body invalid (missing field, bad region, unparseable cookie)
 *   500  Server error (encryption failed, DB write failed)
 *
 * Design notes:
 *   - No CSRF check needed — Bearer-token endpoints don't rely on
 *     the browser session, and cookies are never sent from cross-
 *     origin JS anyway (the endpoint is under /api/, not /pages).
 *   - Payload never logged verbatim (contains the plaintext cookie).
 *     Only the resulting accountId + label appears in logs.
 *   - Rate-limiting deliberately not added yet — this is a manual
 *     tool invoked by the workspace owner; noise is negligible.
 *     Add if we ever expose a public signup that mints tokens.
 */

// Middleware must not touch this path — cookies aren't the auth
// surface here. Add to the middleware skip list at the same time
// as merging this file if it isn't already caught by the /api/
// pattern.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  // ---- Auth ---------------------------------------------------
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return jsonError(401, "UNAUTHORIZED", "Bearer token required.");
  }
  const presented = auth.slice(7).trim();
  if (!presented) {
    return jsonError(401, "UNAUTHORIZED", "Bearer token is empty.");
  }
  const workspace = await db.workspace.findUnique({
    where: { apiToken: presented },
    select: { id: true, name: true },
  });
  if (!workspace) {
    // Opaque message — never leak "token exists but doesn't match"
    // vs "token is well-formed but unknown".
    return jsonError(401, "UNAUTHORIZED", "Invalid API token.");
  }

  // ---- Parse body --------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "BAD_JSON", "Request body must be JSON.");
  }
  if (!body || typeof body !== "object") {
    return jsonError(400, "BAD_JSON", "Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const label = typeof b.label === "string" ? b.label : "";
  const region = typeof b.region === "string" ? b.region : "";
  const cookieRaw = typeof b.cookieRaw === "string" ? b.cookieRaw : "";
  const monthlyToolCostRaw =
    typeof b.monthlyToolCost === "number"
      ? String(b.monthlyToolCost)
      : typeof b.monthlyToolCost === "string"
        ? b.monthlyToolCost
        : "0";

  if (!label || !region || !cookieRaw) {
    return jsonError(
      400,
      "MISSING_FIELD",
      "Body requires label, region, and cookieRaw.",
    );
  }

  // ---- Delegate to the shared action ------------------------
  const result = await addTikTokAccountForWorkspace({
    workspaceId: workspace.id,
    label,
    region,
    cookieRaw,
    monthlyToolCostRaw,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "REJECTED", message: result.message } },
      { status: 400 },
    );
  }

  console.log(
    `[tiktok-accounts/add] wrote account ${result.accountId} ` +
      `(label=${label}, region=${region}) into workspace=${workspace.id}`,
  );
  return NextResponse.json({
    ok: true,
    accountId: result.accountId,
    message: result.message,
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status },
  );
}
