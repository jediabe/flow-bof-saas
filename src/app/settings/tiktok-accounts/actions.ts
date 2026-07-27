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
  return await addTikTokAccountForWorkspace({
    workspaceId: workspace.id,
    label: String(formData.get("label") || ""),
    region: String(formData.get("region") || "US"),
    cookieRaw: String(formData.get("cookieRaw") || ""),
    monthlyToolCostRaw: String(formData.get("monthlyToolCost") || "0"),
  });
}

/**
 * Workspace-scoped add-account core. Extracted from
 * addTikTokAccount so the /api/tiktok-accounts/add API endpoint
 * (Bearer-auth'd, called by flow-bof-automation's cookie fetcher)
 * can share the same parse + encrypt + insert path without
 * duplicating validation or crypto.
 *
 * Assumes workspaceId is already trusted — caller must have
 * authenticated the request via session cookie OR workspace API
 * token. This helper never checks auth itself.
 */
export async function addTikTokAccountForWorkspace(input: {
  workspaceId: string;
  label: string;
  region: string;
  cookieRaw: string;
  monthlyToolCostRaw?: string;
}): Promise<ActionResultWithId> {
  const label = input.label.trim();
  const region = (input.region || "US").trim().toUpperCase();
  const cookiePaste = input.cookieRaw;
  const monthlyToolCostRaw = (input.monthlyToolCostRaw || "0").trim();

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
      workspaceId: input.workspaceId,
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
 *
 * Rate limit: max 3 SUCCESSFUL manual refreshes per rolling 12h
 * per account. Cron refreshes are NOT counted — cron is bounded
 * by its own schedule. Failed refreshes are not counted either
 * (the user should be able to keep trying after fixing a cookie).
 * Enforcement lives here (the action) rather than in
 * refreshAccountSnapshot itself so cron stays uncapped.
 */
const MANUAL_REFRESH_WINDOW_MS = 12 * 60 * 60 * 1000;
const MANUAL_REFRESH_MAX_PER_WINDOW = 3;
const MANUAL_REFRESH_LOG_CAP = 5;

export async function refreshTikTokAccountNow(formData: FormData): Promise<ActionResult> {
  const { workspace } = await getCurrentWorkspace();
  const accountId = String(formData.get("accountId") || "");
  if (!accountId) return { ok: false, message: "Missing accountId." };

  const account = await db.tikTokAccount.findFirst({
    where: { id: accountId, workspaceId: workspace.id },
    select: { id: true, label: true, manualRefreshLog: true },
  });
  if (!account) return { ok: false, message: "Account not found." };

  const now = new Date();
  const windowStart = new Date(now.getTime() - MANUAL_REFRESH_WINDOW_MS);
  const priorLog = parseManualRefreshLog(account.manualRefreshLog);
  const inWindow = priorLog
    .filter((d) => d >= windowStart)
    .sort((a, b) => a.getTime() - b.getTime());

  if (inWindow.length >= MANUAL_REFRESH_MAX_PER_WINDOW) {
    // Next slot opens when the oldest in-window entry ages out.
    const nextAllowedAt = new Date(
      inWindow[0].getTime() + MANUAL_REFRESH_WINDOW_MS,
    );
    return {
      ok: false,
      message:
        `"${account.label}" hit the manual refresh cap (${MANUAL_REFRESH_MAX_PER_WINDOW} per 12h). ` +
        `Try again ${formatRelativeFuture(nextAllowedAt, now)} ` +
        `(${nextAllowedAt.toISOString()}). Scheduled cron refreshes continue on their own.`,
    };
  }

  const { refreshAccountSnapshot } = await import("@/lib/tikhub-refresh");
  const result = await refreshAccountSnapshot({
    accountId,
    workspaceId: workspace.id,
    includeProducts: true,
  });

  // Only successful refreshes get logged toward the cap. Failed
  // attempts (expired cookie, TikHub 5xx, etc.) don't count, so
  // an operator fixing a broken cookie isn't blocked from
  // retrying.
  if (result.ok) {
    const nextLog = [...inWindow, now]
      .sort((a, b) => b.getTime() - a.getTime())
      .slice(0, MANUAL_REFRESH_LOG_CAP)
      .map((d) => d.toISOString())
      .join(",");
    await db.tikTokAccount.update({
      where: { id: accountId },
      data: { manualRefreshLog: nextLog },
    });
  }

  revalidatePath("/settings/tiktok-accounts");
  revalidatePath("/analytics");
  revalidatePath(`/analytics/${accountId}`);
  return result;
}

/**
 * Refresh every TikTok account in the current workspace in one
 * shot. Iterates serially — TikHub throttles concurrent calls
 * from the same API key, and cron does the same for the same
 * reason.
 *
 * Rate limit: same per-account 12h cap as the single-account
 * button. Accounts already at the cap are skipped (not errored) so
 * a "refresh all" that partially hits the cap still refreshes the
 * accounts that have room.
 *
 * Returns a summary — succeeded / rate-limited / failed — that the
 * toast surfaces to the operator.
 */
export async function refreshAllTikTokAccounts(): Promise<ActionResult> {
  const { workspace } = await getCurrentWorkspace();

  const accounts = await db.tikTokAccount.findMany({
    where: { workspaceId: workspace.id },
    select: { id: true, label: true, manualRefreshLog: true },
    orderBy: [{ createdAt: "asc" }],
  });
  if (accounts.length === 0) {
    return { ok: false, message: "No accounts to refresh." };
  }

  const { refreshAccountSnapshot } = await import("@/lib/tikhub-refresh");
  const windowStart = new Date(Date.now() - MANUAL_REFRESH_WINDOW_MS);
  let succeeded = 0;
  let rateLimited = 0;
  let failed = 0;

  for (const a of accounts) {
    const inWindow = parseManualRefreshLog(a.manualRefreshLog).filter(
      (d) => d >= windowStart,
    );
    if (inWindow.length >= MANUAL_REFRESH_MAX_PER_WINDOW) {
      rateLimited++;
      continue;
    }

    let ok = false;
    try {
      const r = await refreshAccountSnapshot({
        accountId: a.id,
        workspaceId: workspace.id,
        includeProducts: true,
      });
      ok = r.ok;
    } catch {
      ok = false;
    }

    if (ok) {
      succeeded++;
      const nextLog = [...inWindow, new Date()]
        .sort((x, y) => y.getTime() - x.getTime())
        .slice(0, MANUAL_REFRESH_LOG_CAP)
        .map((d) => d.toISOString())
        .join(",");
      await db.tikTokAccount.update({
        where: { id: a.id },
        data: { manualRefreshLog: nextLog },
      });
    } else {
      failed++;
    }
  }

  revalidatePath("/settings/tiktok-accounts");
  revalidatePath("/analytics");

  const parts = [`${succeeded}/${accounts.length} refreshed`];
  if (rateLimited > 0) parts.push(`${rateLimited} at 12h cap`);
  if (failed > 0) parts.push(`${failed} failed`);
  // "ok" if we actually refreshed something OR if the only reason
  // we didn't was that everything was rate-limited (a "come back
  // later" situation, not a failure).
  return {
    ok: succeeded > 0 || (failed === 0 && rateLimited > 0),
    message: parts.join(" · "),
  };
}

/** CSV of ISO timestamps → Date[]. Silently drops malformed entries. */
function parseManualRefreshLog(raw: string | null): Date[] {
  if (!raw) return [];
  const out: Date[] = [];
  for (const s of raw.split(",")) {
    const t = s.trim();
    if (!t) continue;
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) out.push(d);
  }
  return out;
}

/** "in 3h 12m" / "in 47m" — coarse-grained, good enough for the toast. */
function formatRelativeFuture(future: Date, from: Date): string {
  const diffMs = Math.max(0, future.getTime() - from.getTime());
  const totalMin = Math.ceil(diffMs / 60_000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
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

  // ===== Multi-step attribution probe =====
  // Chain: recent videos → their tagged products → per-pair sales
  // stats via get_video_to_product_stats. This is the one endpoint
  // that returns product_sales_cnt, product_revenue, etc. If it
  // shows non-zero data for even one pair, we know sales attribution
  // works and can wire this into refresh proper.
  await probeVideoProductChain(cookie, items, today);

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

/**
 * Walk the multi-step attribution chain and append probe results
 * to the shared diagnostic items array. Used to test whether
 * TikHub can attribute per-product sales via the video ↔ product
 * pair endpoint, which is the one endpoint documented to expose
 * `product_sales_cnt` / `product_revenue`.
 *
 * Chain (all TikHub calls; each incurs a charge):
 *   1. get_video_list_analytics — recent videos
 *   2. get_video_associated_product_list — products tagged per video
 *      (batched: accepts an array of item_ids)
 *   3. get_video_to_product_stats — per-(video, product) sales stats
 *      (probes up to 5 pairs)
 *
 * ~7 TikHub calls per invocation. Bail early at each step if the
 * previous step returned nothing useful, so a dry account still
 * only costs 1-2 calls instead of the full 7.
 */
async function probeVideoProductChain(
  cookie: string,
  items: DiagnosticItem[],
  today: Date,
): Promise<void> {
  const fmtUS = (d: Date) =>
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${d.getUTCFullYear()}`;

  // --- Step 1: pull the TOP-SELLING video list — sort by
  // VIDEO_LIST_ITEM_SOLD_CNT, page=0 (0-indexed), start_date
  // pinned to MM-01-YYYY per docs
  // (https://docs.tikhub.io/289437016e0). Zero-sales videos are
  // filtered out downstream since the list is sorted desc; the
  // first zero means everything after it is also zero.
  const monthAnchor = `${String(today.getUTCMonth() + 1).padStart(2, "0")}-01-${today.getUTCFullYear()}`;
  let videoIds: string[] = [];
  try {
    const raw = await callRawTikHub(
      "/api/v1/tiktok/creator/get_video_list_analytics",
      {
        cookie,
        start_date: monthAnchor,
        page: 0,
        rules: "VIDEO_LIST_ITEM_SOLD_CNT",
      },
    );
    videoIds = extractVideoIds(raw).slice(0, 5);
  } catch (err) {
    items.push({
      label: "Chain: recent videos (for attribution probe)",
      endpoint: "/api/v1/tiktok/creator/get_video_list_analytics",
      ok: false,
      raw: null,
      error: (err as Error).message.slice(0, 300),
    });
    return;
  }
  items.push({
    label: `Chain step 1 — recent video IDs (${videoIds.length})`,
    endpoint: "/api/v1/tiktok/creator/get_video_list_analytics",
    ok: true,
    raw: JSON.stringify(videoIds, null, 2),
    error: null,
  });
  if (videoIds.length === 0) return;

  // --- Step 2: batch-fetch associated products for the first N
  // videos in ONE call (endpoint accepts item_ids: array).
  let pairs: Array<{ item_id: string; product_id: string; product_name: string }> = [];
  try {
    const raw = await callRawTikHub(
      "/api/v1/tiktok/creator/get_video_associated_product_list",
      { cookie, start_date: fmtUS(today), item_ids: videoIds },
    );
    pairs = extractVideoProductPairs(raw);
    items.push({
      label: `Chain step 2 — video↔product pairs (${pairs.length})`,
      endpoint: "/api/v1/tiktok/creator/get_video_associated_product_list",
      ok: true,
      raw: JSON.stringify(pairs.slice(0, 20), null, 2),
      error: null,
    });
  } catch (err) {
    items.push({
      label: "Chain step 2 — video associated products",
      endpoint: "/api/v1/tiktok/creator/get_video_associated_product_list",
      ok: false,
      raw: null,
      error: (err as Error).message.slice(0, 300),
    });
    return;
  }
  if (pairs.length === 0) {
    items.push({
      label: "Chain step 3 — SKIPPED (no video↔product pairs found)",
      endpoint: "/api/v1/tiktok/creator/get_video_to_product_stats",
      ok: false,
      raw: null,
      error:
        "extractVideoProductPairs found nothing in the step-2 response. " +
        "Paste the raw JSON of step 2 back and I'll adjust the extractor.",
    });
    return;
  }

  // --- Step 3: probe up to 5 (video, product) pairs.
  const probePairs = pairs.slice(0, 5);
  for (const p of probePairs) {
    const label = `Chain step 3 — pair stats · vid …${p.item_id.slice(-6)} × prod …${p.product_id.slice(-6)}`;
    try {
      const raw = await callRawTikHub(
        "/api/v1/tiktok/creator/get_video_to_product_stats",
        {
          cookie,
          start_date: fmtUS(today),
          item_id: p.item_id,
          product_id: p.product_id,
        },
      );
      const json = JSON.stringify(raw, null, 2);
      items.push({
        label,
        endpoint: "/api/v1/tiktok/creator/get_video_to_product_stats",
        ok: true,
        raw:
          json.length > DIAGNOSTIC_RAW_MAX
            ? json.slice(0, DIAGNOSTIC_RAW_MAX) +
              `\n… [truncated, ${json.length - DIAGNOSTIC_RAW_MAX} more bytes]`
            : json,
        error: null,
      });
    } catch (err) {
      items.push({
        label,
        endpoint: "/api/v1/tiktok/creator/get_video_to_product_stats",
        ok: false,
        raw: null,
        error: (err as Error).message.slice(0, 300),
      });
    }
  }
}

/**
 * Walk a get_video_list_analytics response and pull out the recent
 * video IDs. Defensive against shape drift — the plucker for real
 * lists is in tikhub.ts, but here we only care about the ids.
 */
function extractVideoIds(raw: unknown): string[] {
  const r = unwrapDataEnvelope(raw);
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const timedLists = Array.isArray(s.timed_lists)
      ? (s.timed_lists as unknown[])
      : [];
    for (const tl of timedLists) {
      if (!tl || typeof tl !== "object") continue;
      const stats = Array.isArray((tl as Record<string, unknown>).stats)
        ? ((tl as Record<string, unknown>).stats as unknown[])
        : [];
      for (const item of stats) {
        if (!item || typeof item !== "object") continue;
        const meta = ((item as Record<string, unknown>).video_meta ?? {}) as Record<
          string,
          unknown
        >;
        const id = String(meta.item_id ?? "");
        if (id && !out.includes(id)) out.push(id);
      }
    }
  }
  return out;
}

/**
 * Walk a get_video_associated_product_list response and pull out
 * (video_id, product_id, product_name) triples. Response shape per
 * TikHub docs: segments[].timed_lists[].videoToProductsMap =
 * { item_id, products: [{ id, name }] }.
 */
function extractVideoProductPairs(raw: unknown): Array<{
  item_id: string;
  product_id: string;
  product_name: string;
}> {
  const r = unwrapDataEnvelope(raw);
  const out: Array<{ item_id: string; product_id: string; product_name: string }> =
    [];
  const seen = new Set<string>();

  /** Emit a single (video, product) pair, dedup by (video::product). */
  const emit = (itemId: string, productId: string, productName: string): void => {
    if (!itemId || !productId) return;
    const key = `${itemId}::${productId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ item_id: itemId, product_id: productId, product_name: productName });
  };

  /** Walk a products array under a known item_id. Handles both
   *  {id, name} and {product_id, product_name} shapes. */
  const walkProducts = (itemId: string, products: unknown): void => {
    if (!Array.isArray(products)) return;
    for (const p of products) {
      if (!p || typeof p !== "object") continue;
      const pp = p as Record<string, unknown>;
      const productId = String(pp.id ?? pp.product_id ?? "");
      const productName = String(pp.name ?? pp.title ?? pp.product_name ?? "");
      emit(itemId, productId, productName);
    }
  };

  /** Walk a videoToProductsMap-like object. TikHub may return this
   *  as either:
   *    (a) an object with item_id + products fields,
   *    (b) an array of such objects,
   *    (c) a hashmap keyed by video ID → { products: [...] }
   *  Try all three shapes. */
  const walkMaps = (maps: unknown): void => {
    if (!maps || typeof maps !== "object") return;

    // Case (b): array of {item_id, products} objects.
    if (Array.isArray(maps)) {
      for (const entry of maps) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const itemId = String(e.item_id ?? e.itemId ?? e.video_id ?? "");
        walkProducts(itemId, e.products ?? e.product_list);
      }
      return;
    }

    const obj = maps as Record<string, unknown>;

    // Case (a): a single {item_id, products} object.
    if ("item_id" in obj || "itemId" in obj || "video_id" in obj) {
      const itemId = String(obj.item_id ?? obj.itemId ?? obj.video_id ?? "");
      walkProducts(itemId, obj.products ?? obj.product_list);
      return;
    }

    // Case (c): keyed hashmap where each key IS the video ID.
    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== "object") continue;
      // The key looks like a TikTok video ID (long numeric string) —
      // treat it as the item_id.
      if (/^\d{15,}$/.test(key)) {
        const v = value as Record<string, unknown>;
        walkProducts(key, v.products ?? v.product_list ?? v);
      }
    }
  };

  // Walk segments[].timed_lists[] (documented shape) …
  const segments = Array.isArray(r.segments) ? (r.segments as unknown[]) : [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const s = seg as Record<string, unknown>;
    const timedLists = Array.isArray(s.timed_lists)
      ? (s.timed_lists as unknown[])
      : [];
    for (const tl of timedLists) {
      if (!tl || typeof tl !== "object") continue;
      const t = tl as Record<string, unknown>;
      const map =
        t.videoToProductsMap ??
        t.video_to_products_map ??
        t.videoToProducts ??
        t.item_products ??
        // If nothing named-map exists, fall back to the timed_list
        // itself in case TikHub inlined the structure.
        t;
      walkMaps(map);
    }
  }

  // …AND fall back to a top-level videoToProductsMap if TikHub
  // dropped the segments/timed_lists wrapper entirely.
  if (out.length === 0) {
    walkMaps(
      r.videoToProductsMap ??
        r.video_to_products_map ??
        r.videoToProducts ??
        r,
    );
  }

  return out;
}

/**
 * Local unwrap helper — same idea as tikhub.ts's unwrapEnvelope but
 * we keep a copy here to avoid coupling actions.ts to the internals
 * of the service module. Peels a single {code, data} envelope layer.
 */
function unwrapDataEnvelope(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  if ("code" in r && "data" in r && r.data && typeof r.data === "object") {
    return r.data as Record<string, unknown>;
  }
  return r;
}
