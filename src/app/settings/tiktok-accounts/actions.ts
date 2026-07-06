"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import {
  parseTikTokCookieString,
} from "@/lib/tikhub-cookie-parser";
import { encryptCookie, decryptCookie } from "@/lib/tikhub-crypto";
import * as tikhub from "@/lib/tikhub";

/**
 * BOF Dashboard — server actions for the /settings/tiktok-accounts
 * page.
 *
 * Every action:
 *   - resolves the current workspace (auth gate)
 *   - scopes its Prisma queries to workspace.id (tenancy gate)
 *   - never returns the plaintext cookie to the client (the client
 *     only ever sees a masked preview + status)
 *
 * The cookie ciphertext lives in TikTokAccount.cookieRaw. To call
 * TikHub, server-side code decrypts inline; that plaintext never
 * leaves the function-call stack.
 */

const VALID_REGIONS = new Set(["US", "UK"]);
const COOKIE_ERROR_MAX_LEN = 500;

type ActionResult = { ok: boolean; message: string };
type ActionResultWithId = ActionResult & { accountId?: string };

/**
 * Add a new TikTok Shop account to the workspace.
 *
 * Flow:
 *   1. Parse the cookie paste, fail fast if any of the six
 *      required keys are missing.
 *   2. Encrypt the normalized cookie string for storage.
 *   3. Insert the row with cookieStatus="unchecked" — the user
 *      hits "Test cookie" separately to validate. This keeps Add
 *      synchronous and snappy even if TikHub is slow.
 */
export async function addTikTokAccount(formData: FormData): Promise<ActionResultWithId> {
  const { workspace } = await getCurrentWorkspace();

  const label = String(formData.get("label") || "").trim();
  const region = String(formData.get("region") || "US").trim().toUpperCase();
  const cookiePaste = String(formData.get("cookieRaw") || "");
  const monthlyToolCostRaw = String(formData.get("monthlyToolCost") || "0").trim();

  if (!label) {
    return { ok: false, message: "Label is required." };
  }
  if (!VALID_REGIONS.has(region)) {
    return { ok: false, message: "Region must be US or UK." };
  }
  const monthlyToolCost = Number(monthlyToolCostRaw);
  if (!Number.isFinite(monthlyToolCost) || monthlyToolCost < 0) {
    return { ok: false, message: "Monthly tool cost must be a non-negative number." };
  }

  const parsed = parseTikTokCookieString(cookiePaste);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  let ciphertext: string;
  try {
    ciphertext = encryptCookie(parsed.normalized);
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      message: `Cookie encryption failed: ${e.message}`,
    };
  }

  const row = await db.tikTokAccount.create({
    data: {
      workspaceId: workspace.id,
      label,
      region,
      cookieRaw: ciphertext,
      monthlyToolCost,
      cookieStatus: "unchecked",
    },
    select: { id: true },
  });

  revalidatePath("/settings/tiktok-accounts");
  return {
    ok: true,
    accountId: row.id,
    message: `Account "${label}" added. Click "Test cookie" to confirm it works.`,
  };
}

/**
 * Update label / region / monthlyToolCost on an existing account.
 * Cookie replacement uses a separate flow (the dedicated paste
 * goes through replaceTikTokCookie) so we don't accidentally wipe
 * a valid cookie when someone just wants to rename.
 */
export async function updateTikTokAccount(formData: FormData): Promise<ActionResult> {
  const { workspace } = await getCurrentWorkspace();

  const accountId = String(formData.get("accountId") || "");
  if (!accountId) return { ok: false, message: "Missing accountId." };

  const label = String(formData.get("label") || "").trim();
  const region = String(formData.get("region") || "US").trim().toUpperCase();
  const monthlyToolCostRaw = String(formData.get("monthlyToolCost") || "0").trim();

  if (!label) return { ok: false, message: "Label is required." };
  if (!VALID_REGIONS.has(region)) {
    return { ok: false, message: "Region must be US or UK." };
  }
  const monthlyToolCost = Number(monthlyToolCostRaw);
  if (!Number.isFinite(monthlyToolCost) || monthlyToolCost < 0) {
    return {
      ok: false,
      message: "Monthly tool cost must be a non-negative number.",
    };
  }

  const existing = await db.tikTokAccount.findFirst({
    where: { id: accountId, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!existing) return { ok: false, message: "Account not found." };

  await db.tikTokAccount.update({
    where: { id: accountId },
    data: { label, region, monthlyToolCost },
  });
  revalidatePath("/settings/tiktok-accounts");
  revalidatePath("/analytics");
  revalidatePath(`/analytics/${accountId}`);
  return { ok: true, message: `Account "${label}" updated.` };
}

/**
 * Replace the cookie on an existing account. Same validation +
 * encryption as add. Resets cookieStatus to "unchecked" — the
 * user verifies with "Test cookie" next.
 */
export async function replaceTikTokCookie(formData: FormData): Promise<ActionResult> {
  const { workspace } = await getCurrentWorkspace();
  const accountId = String(formData.get("accountId") || "");
  const cookiePaste = String(formData.get("cookieRaw") || "");

  if (!accountId) return { ok: false, message: "Missing accountId." };

  const existing = await db.tikTokAccount.findFirst({
    where: { id: accountId, workspaceId: workspace.id },
    select: { id: true, label: true },
  });
  if (!existing) return { ok: false, message: "Account not found." };

  const parsed = parseTikTokCookieString(cookiePaste);
  if (!parsed.ok) return { ok: false, message: parsed.message };

  let ciphertext: string;
  try {
    ciphertext = encryptCookie(parsed.normalized);
  } catch (err) {
    const e = err as Error;
    return { ok: false, message: `Cookie encryption failed: ${e.message}` };
  }

  await db.tikTokAccount.update({
    where: { id: accountId },
    data: {
      cookieRaw: ciphertext,
      cookieStatus: "unchecked",
      cookieError: null,
    },
  });
  revalidatePath("/settings/tiktok-accounts");
  return {
    ok: true,
    message: `Cookie updated for "${existing.label}". Click "Test cookie" to confirm.`,
  };
}

/**
 * Delete an account (and cascade-delete its health / revenue /
 * product / pnl rows via Prisma's onDelete: Cascade).
 */
export async function deleteTikTokAccount(formData: FormData): Promise<ActionResult> {
  const { workspace } = await getCurrentWorkspace();
  const accountId = String(formData.get("accountId") || "");
  if (!accountId) return { ok: false, message: "Missing accountId." };

  const existing = await db.tikTokAccount.findFirst({
    where: { id: accountId, workspaceId: workspace.id },
    select: { id: true, label: true },
  });
  if (!existing) return { ok: false, message: "Account not found." };

  await db.tikTokAccount.delete({ where: { id: accountId } });
  revalidatePath("/settings/tiktok-accounts");
  revalidatePath("/analytics");
  return { ok: true, message: `Account "${existing.label}" deleted.` };
}

/**
 * Validate the stored cookie against TikHub. Updates
 * cookieStatus / cookieError / lastCheckedAt. Cheap call (hits
 * the health endpoint, which TikHub serves fast).
 */
export async function testTikTokCookie(formData: FormData): Promise<ActionResult> {
  const { workspace } = await getCurrentWorkspace();
  const accountId = String(formData.get("accountId") || "");
  if (!accountId) return { ok: false, message: "Missing accountId." };

  const row = await db.tikTokAccount.findFirst({
    where: { id: accountId, workspaceId: workspace.id },
    select: { id: true, cookieRaw: true, label: true },
  });
  if (!row) return { ok: false, message: "Account not found." };

  let plaintext: string;
  try {
    plaintext = decryptCookie(row.cookieRaw);
  } catch (err) {
    const e = err as Error;
    await db.tikTokAccount.update({
      where: { id: accountId },
      data: {
        cookieStatus: "error",
        cookieError: `Cookie decrypt failed: ${e.message}`.slice(0, COOKIE_ERROR_MAX_LEN),
        lastCheckedAt: new Date(),
      },
    });
    revalidatePath("/settings/tiktok-accounts");
    return { ok: false, message: "Stored cookie could not be decrypted. Re-paste from TikTok." };
  }

  const result = await tikhub.testCookie({ cookie: plaintext });
  await db.tikTokAccount.update({
    where: { id: accountId },
    data: {
      cookieStatus: result.status,
      cookieError: result.ok ? null : result.message.slice(0, COOKIE_ERROR_MAX_LEN),
      lastCheckedAt: new Date(),
    },
  });
  revalidatePath("/settings/tiktok-accounts");
  return {
    ok: result.ok,
    message: `${row.label}: ${result.message}`,
  };
}

/**
 * Force an immediate refresh of one account's health + revenue
 * (the cheap, 6-hourly polled bundle). The cron endpoints share
 * the same underlying refreshAccountSnapshot() helper so manual
 * + scheduled refreshes are byte-for-byte equivalent.
 */
export async function refreshTikTokAccountNow(formData: FormData): Promise<ActionResult> {
  const { workspace } = await getCurrentWorkspace();
  const accountId = String(formData.get("accountId") || "");
  if (!accountId) return { ok: false, message: "Missing accountId." };

  const { refreshAccountSnapshot } = await import("@/lib/tikhub-refresh");
  const result = await refreshAccountSnapshot({
    accountId,
    workspaceId: workspace.id,
    includeProducts: true,
  });
  revalidatePath("/settings/tiktok-accounts");
  revalidatePath("/analytics");
  revalidatePath(`/analytics/${accountId}`);
  return result;
}

/**
 * Diagnostic call — fires all four TikHub endpoints for an account
 * independently and returns the raw `data` payload from each so
 * we can see what field names actually exist. Each endpoint is
 * isolated in its own try/catch so a single failure doesn't hide
 * the others.
 *
 * Each payload is truncated to ~4KB of JSON to keep the response
 * manageable in the UI. We log nothing — the data is sensitive
 * (could include account identifiers).
 *
 * The diagnostic intentionally goes WIDER than the normal refresh
 * (videos are NOT polled in refresh; here they are) so an account
 * with no sales but plenty of posted videos still surfaces useful
 * data.
 */
export interface DiagnosticItem {
  label: string;
  endpoint: string;
  ok: boolean;
  /** Raw `data` from TikHub's response envelope, JSON-stringified
   *  and truncated. null when the call failed. */
  raw: string | null;
  /** Error message when ok=false. */
  error: string | null;
}

const DIAGNOSTIC_RAW_MAX = 80_000;

export async function diagnoseTikTokAccount(
  formData: FormData,
): Promise<{ ok: boolean; message: string; items: DiagnosticItem[] }> {
  const { workspace } = await getCurrentWorkspace();
  const accountId = String(formData.get("accountId") || "");
  if (!accountId) {
    return { ok: false, message: "Missing accountId.", items: [] };
  }

  const row = await db.tikTokAccount.findFirst({
    where: { id: accountId, workspaceId: workspace.id },
    select: { id: true, label: true, cookieRaw: true },
  });
  if (!row) return { ok: false, message: "Account not found.", items: [] };

  let cookie: string;
  try {
    cookie = decryptCookie(row.cookieRaw);
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      message: `Decrypt failed: ${e.message}`,
      items: [],
    };
  }

  // We hit the lower-level fetcher directly so we can capture the
  // raw `data` rather than the post-pluck projection.
  const items: DiagnosticItem[] = [];

  async function probe(
    label: string,
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    try {
      const raw = await callRawTikHub(endpoint, { cookie, ...body });
      const json = JSON.stringify(raw, null, 2);
      items.push({
        label,
        endpoint,
        ok: true,
        raw: json.length > DIAGNOSTIC_RAW_MAX
          ? json.slice(0, DIAGNOSTIC_RAW_MAX) + `\n… [truncated, ${json.length - DIAGNOSTIC_RAW_MAX} more bytes]`
          : json,
        error: null,
      });
    } catch (err) {
      const e = err as Error;
      items.push({
        label,
        endpoint,
        ok: false,
        raw: null,
        error: `${e.name}: ${e.message.slice(0, 300)}`,
      });
    }
  }

  // Dates: trailing 30d window in both TikHub formats.
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fmtUS = (d: Date) =>
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;
  const fmtISO = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

  await probe(
    "Health",
    "/api/v1/tiktok/creator/get_account_health_status",
    {},
  );
  await probe(
    "Overview (insights, start_date = 30 days ago)",
    "/api/v1/tiktok/creator/get_account_insights_overview",
    { start_date: fmtUS(thirtyDaysAgo) },
  );
  // Probe variant: pass TODAY as start_date. TikHub maps start_date
  // to a "period selector" rather than a true date range; this
  // variant tells us whether the endpoint returns the current
  // (incomplete) month when asked.
  await probe(
    "Overview (insights, start_date = today)",
    "/api/v1/tiktok/creator/get_account_insights_overview",
    { start_date: fmtUS(today) },
  );
  // Probe variant: pass a date 7 days ago. The dashboard's
  // "last 7 days" view should match THIS window if the
  // parameter behaves like a true lower bound.
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  await probe(
    "Overview (insights, start_date = 7 days ago)",
    "/api/v1/tiktok/creator/get_account_insights_overview",
    { start_date: fmtUS(sevenDaysAgo) },
  );
  await probe(
    "Video list analytics",
    "/api/v1/tiktok/creator/get_video_list_analytics",
    { start_date: fmtUS(thirtyDaysAgo), page: 1 },
  );
  await probe(
    "Product list analytics",
    "/api/v1/tiktok/creator/get_product_analytics_list",
    { start_date: fmtISO(thirtyDaysAgo), end_date: fmtISO(today), page: 1 },
  );
  // Bonus endpoints that aren't part of normal refresh but are
  // useful for content-only accounts:
  await probe(
    "Video analytics summary",
    "/api/v1/tiktok/creator/get_video_analytics_summary",
    { start_date: fmtUS(thirtyDaysAgo) },
  );
  await probe(
    "Creator account info",
    "/api/v1/tiktok/creator/get_creator_account_info",
    {},
  );
  // NEW: live-stream sales overview. TikTok LIVE GMV does NOT
  // show up in get_account_insights_overview's revenue field —
  // it has its own endpoint. If the operator does live selling,
  // this is where the missing revenue lives.
  await probe(
    "Live analytics summary",
    "/api/v1/tiktok/creator/get_live_analytics_summary",
    { start_date: fmtUS(today) },
  );
  // NEW: showcase products — the products the creator has
  // pinned to their TikTok shop showcase. Distinct from
  // get_product_analytics_list which is per-product *sales*
  // analytics. Useful when product_analytics_list returns
  // sparse data.
  await probe(
    "Showcase products",
    "/api/v1/tiktok/creator/get_showcase_product_list",
    { count: 25, offset: 0 },
  );
  // NEW: per-video analytics. When get_product_analytics_list
  // returns zero sales-per-product despite account-level sales
  // being non-zero (common for shop-owner accounts), we can
  // instead walk video-by-video and use each video's
  // associated-products list to attribute sales properly.
  // First step: which videos drove GMV.
  await probe(
    "Video list analytics",
    "/api/v1/tiktok/creator/get_video_list_analytics",
    { start_date: fmtUS(today), page: 1 },
  );

  const failed = items.filter((i) => !i.ok).length;
  return {
    ok: failed === 0,
    message:
      failed === 0
        ? `Probed ${items.length} endpoints for "${row.label}".`
        : `Probed ${items.length} endpoints for "${row.label}" — ${failed} failed.`,
    items,
  };
}

/**
 * Lightweight raw POST to a TikHub endpoint. Mirrors postTikHub
 * but is local to the diagnostics path so we don't pollute the
 * production service layer with a "give me the raw envelope"
 * variant. Returns the unwrapped `data` field on success; throws
 * on 4xx/5xx or non-200 inner code.
 */
async function callRawTikHub(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = (process.env.TIKHUB_API_KEY || "").trim();
  if (!apiKey) throw new Error("TIKHUB_API_KEY unset");
  const resp = await fetch(`https://api.tikhub.io${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ proxy: null, ...body }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 300)}`);
  }
  const json = (await resp.json()) as Record<string, unknown>;
  if (
    json &&
    typeof json === "object" &&
    "code" in json &&
    typeof (json as { code: unknown }).code === "number" &&
    (json as { code: number }).code !== 200 &&
    (json as { code: number }).code !== 0
  ) {
    const msg = String((json as { msg?: unknown }).msg ?? "(no msg)");
    throw new Error(`TikHub inner code ${(json as { code: number }).code}: ${msg}`);
  }
  return (json as { data?: unknown }).data ?? json;
}
