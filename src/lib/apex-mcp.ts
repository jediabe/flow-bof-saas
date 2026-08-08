/**
 * APEX MCP client — thin fetch wrapper for calling the co-deployed
 * MCP server from server-side Next.js code.
 *
 * The MCP server runs as its own docker-compose service (`apex-mcp`)
 * reachable at http://apex-mcp:3000 inside the internal Docker
 * network. Not exposed publicly — Caddy has no route to it, no host
 * port is published.
 *
 * Two auth surfaces on the MCP:
 *   /admin/* : shared APEX_SERVICE_KEY as bearer. Used for account
 *              connect / list / status / disconnect. Handled by
 *              mcpAdminRequest below.
 *   /mcp     : per-request HS256 JWT with sub + flow_email claims.
 *              Used for tool calls in the Anthropic agent loop.
 *              Handled by mcpToolRequest (added in a later commit
 *              when the agent loop lands).
 */

const DEFAULT_BASE_URL = "http://apex-mcp:3000";

/** Base URL for reaching the MCP server. Override with APEX_MCP_URL
 *  in .env for local dev if it's running on a different host/port. */
export function mcpBaseUrl(): string {
  return (process.env.APEX_MCP_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** Shared secret guarding /admin/* on the MCP. Must match the same
 *  value the MCP container was started with. Required for every
 *  admin call — routes 401 without it. */
function serviceKey(): string {
  const k = (process.env.APEX_SERVICE_KEY || "").trim();
  if (!k) {
    throw new Error(
      "APEX_SERVICE_KEY is not set. Add it to .env.production alongside the MCP server's env — both containers must have the SAME value.",
    );
  }
  return k;
}

/** Thrown for any non-2xx MCP response. `code` is the machine-
 *  readable identifier the MCP layer surfaces in its error body
 *  (e.g. "invalid_cookies", "no_flow_accounts"); `status` is the
 *  raw HTTP status. Callers decide whether to surface `message`
 *  verbatim to the user. */
export class ApexMcpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "ApexMcpError";
  }
}

/** Generic /admin/* request. Uses the shared service key. Returns
 *  parsed JSON on success, throws ApexMcpError on any failure. */
export async function mcpAdminRequest<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const url = `${mcpBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceKey()}`,
    Accept: "application/json",
  };
  const bodyText =
    init.body !== undefined ? JSON.stringify(init.body) : undefined;
  if (bodyText !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: bodyText,
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
  } catch (err) {
    const e = err as Error;
    throw new ApexMcpError(
      `MCP fetch failed: ${e.name}: ${e.message.slice(0, 200)}`,
      0,
      "network",
    );
  }
  let parsed: unknown = null;
  const rawText = await resp.text().catch(() => "");
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // fall through with parsed=null; error path below handles it
    }
  }
  if (!resp.ok) {
    const p = (parsed as Record<string, unknown>) || {};
    const msg =
      (typeof p.error === "string" && p.error) ||
      (typeof p.message === "string" && p.message) ||
      `MCP returned ${resp.status}`;
    throw new ApexMcpError(
      String(msg).slice(0, 400),
      resp.status,
      typeof p.code === "string" ? p.code : null,
      typeof p.upstreamStatus === "number" ? p.upstreamStatus : null,
    );
  }
  return (parsed ?? {}) as T;
}

/* ------------------------------------------------------------------
 * Typed helpers for the specific admin routes we call from the app
 * ---------------------------------------------------------------- */

export interface ListedAccount {
  email: string;
  health: string;
  created: unknown;
  sessionExpires: unknown;
  nextRefresh: unknown;
}

export interface ListAccountsResponse {
  count: number;
  accounts: ListedAccount[];
}

/** GET /admin/accounts — every Google Flow account already
 *  connected to the useapi.net subscription (whether via our
 *  cookie-paste form OR useapi.net's own automated browser
 *  setup at useapi.net/assets/setup-browser/google-flow).
 *
 *  We show these as pickable options so operators who already
 *  connected via useapi.net don't have to re-capture cookies. */
export async function mcpListAccounts(): Promise<ListAccountsResponse> {
  return mcpAdminRequest<ListAccountsResponse>("/admin/accounts");
}

export interface ConnectedAccountResponse {
  email: string | null;
  name: string | null;
  health: string;
  project: unknown;
  nextRefresh: unknown;
}

/** POST /admin/accounts — connect a Google Flow account by cookie
 *  blob. Returns the newly-connected email so the caller can
 *  persist it on WorkspaceSettings.flowEmail. */
export async function mcpConnectGoogleFlowAccount(input: {
  cookies: string;
}): Promise<ConnectedAccountResponse> {
  return mcpAdminRequest<ConnectedAccountResponse>("/admin/accounts", {
    method: "POST",
    body: { cookies: input.cookies },
    // useapi.net can take a while on this — the cookie handshake
    // + validating a fresh session takes 20-40s in practice.
    timeoutMs: 150_000,
  });
}

export interface AccountStatusResponse {
  email: string;
  health: string;
  healthy: boolean;
  credits: unknown;
  project: unknown;
  nextRefresh: unknown;
}

/** GET /admin/accounts/:email — one account's health + credit
 *  balance. Poll before generating to catch a broken session
 *  before the operator does. */
export async function mcpGetAccountStatus(
  email: string,
): Promise<AccountStatusResponse> {
  return mcpAdminRequest<AccountStatusResponse>(
    `/admin/accounts/${encodeURIComponent(email)}`,
  );
}

/** DELETE /admin/accounts/:email — disconnect. First half of
 *  recovering from a 596 (broken session). */
export async function mcpDisconnectGoogleFlowAccount(
  email: string,
): Promise<{ email: string; deleted: boolean }> {
  return mcpAdminRequest<{ email: string; deleted: boolean }>(
    `/admin/accounts/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}
