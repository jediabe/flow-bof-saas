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

/* ------------------------------------------------------------------
 * /mcp — MCP tool client (JWT-authenticated, per-request)
 *
 * The MCP server's /mcp endpoint is stateless: a fresh transport
 * and server per POST, no sessions. We use the official MCP SDK's
 * Client + StreamableHTTPClientTransport to speak JSON-RPC over
 * that endpoint.
 *
 * Auth: per-request HS256 JWT signed with APEX_JWT_SECRET. The
 * MCP server verifies signature + reads sub (user/workspace id)
 * and flow_email (which connected Google Flow account to act as)
 * from the payload.
 *
 * Never expose flow_email to the model — it comes from the
 * workspace's persisted binding (WorkspaceSettings.flowEmail),
 * NOT from anywhere the model or a user-supplied field can
 * influence. That's the whole point of the signed-claim design.
 * ---------------------------------------------------------------- */

import jwt from "jsonwebtoken";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** HS256 secret shared with the MCP server. Both containers must
 *  have the SAME value. */
function jwtSecret(): string {
  const s = (process.env.APEX_JWT_SECRET || "").trim();
  if (!s) {
    throw new Error(
      "APEX_JWT_SECRET is not set. Add it to .env.production — must match the MCP container's value.",
    );
  }
  return s;
}

/** Mint an HS256 JWT for a single MCP request. Short expiry so
 *  a leaked token can't be replayed indefinitely. sub identifies
 *  the workspace/user (currently workspace id — see the deferred
 *  per-user migration memo); flow_email picks which connected
 *  Google Flow account the MCP server should act as. */
export function mintMcpJwt(input: {
  sub: string;
  flowEmail: string;
  /** Seconds until expiry. Default 5 min — plenty for one tool
   *  call including polling; short enough to limit blast radius
   *  on leak. */
  expiresInSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = input.expiresInSeconds ?? 300;
  return jwt.sign(
    {
      sub:        input.sub,
      flow_email: input.flowEmail,
      iat:        now,
      exp:        now + expiresIn,
    },
    jwtSecret(),
    { algorithm: "HS256" },
  );
}

/** Build a fresh MCP client bound to a JWT. Callers should call
 *  connect() before use and close() afterwards. Stateless: don't
 *  cache — every logical operation (list-tools, one-tool-call)
 *  gets its own connection so a JWT expiring mid-loop doesn't
 *  poison the whole conversation. */
export async function connectMcpClient(input: {
  sub: string;
  flowEmail: string;
}): Promise<Client> {
  const token = mintMcpJwt(input);
  const url = new URL(`${mcpBaseUrl()}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  const client = new Client(
    { name: "flow-bof-saas", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/** One-shot: discover the tools available on the MCP server for
 *  this JWT. Used at agent-loop start to bind the tool schemas
 *  into the Anthropic Messages API `tools` parameter. */
export async function listMcpTools(input: {
  sub: string;
  flowEmail: string;
}): Promise<Array<{
  name: string;
  description: string | undefined;
  inputSchema: unknown;
}>> {
  const client = await connectMcpClient(input);
  try {
    const resp = await client.listTools();
    return resp.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

/** One-shot: call a tool and return the structured result. */
export async function callMcpTool(input: {
  sub: string;
  flowEmail: string;
  name: string;
  args: Record<string, unknown>;
}): Promise<{
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}> {
  const client = await connectMcpClient(input);
  try {
    const result = await client.callTool({
      name: input.name,
      arguments: input.args,
    });
    return {
      isError: Boolean(result.isError),
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: (result as { structuredContent?: unknown })
        .structuredContent,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Convenience wrapper — resolve a FlowGeneratedVideo's
 * mediaGenerationId into a fresh signed URL via
 * google_flow_get_asset.
 *
 * Signed URLs are valid for ~6 hours; the id itself is stable
 * indefinitely. We call this every time the mobile posting page
 * renders so operators never see a stale/expired URL.
 *
 * Returns null when the MCP call fails OR the response doesn't
 * carry a url (deleted asset, unknown id, MCP down). Callers
 * render an "URL unavailable" affordance and can prompt a retry.
 */
export async function mcpGetAssetUrl(input: {
  sub: string;
  flowEmail: string;
  mediaGenerationId: string;
}): Promise<string | null> {
  try {
    const result = await callMcpTool({
      sub: input.sub,
      flowEmail: input.flowEmail,
      name: "google_flow_get_asset",
      args: { media_generation_id: input.mediaGenerationId },
    });
    if (result.isError) return null;
    const structured = result.structuredContent as
      | { url?: unknown }
      | undefined;
    const url = structured?.url;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch (err) {
    console.warn(
      `[apex-mcp] get_asset failed for ${input.mediaGenerationId}:`,
      err,
    );
    return null;
  }
}
