/**
 * OpenAI ChatGPT-subscription OAuth constants + token refresh.
 *
 * These endpoints and the client_id are extracted from OpenAI's
 * official Codex CLI + the opencode-openai-codex-auth plugin
 * (see the README linked from src/lib/llm/credentials.ts). They
 * are NOT part of OpenAI's published API — they're the auth
 * flow the Codex CLI uses to authenticate with ChatGPT
 * subscriptions. OpenAI could change them at any time; if that
 * happens the symptom will be a 401 from the token endpoint
 * and refresh failures.
 *
 * The API endpoint the OAuth tokens hit is DIFFERENT from the
 * standard /v1/responses — subscription-authenticated calls go
 * to https://chatgpt.com/backend-api/codex/responses with extra
 * headers (chatgpt-account-id, OpenAI-Beta, originator).
 *
 * Non-secret; safe to check into the repo. The user-specific
 * tokens live encrypted in LlmCredential.
 */

/* ==================================================================
 * OAuth constants
 * ================================================================ */

/** OpenAI's Codex CLI client id. Used by opencode too. */
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Authorization endpoint — browser popup (PKCE). Not used by
 *  our current phase-4 import path but reserved for the future
 *  "connect via UI" flow. */
export const OPENAI_OAUTH_AUTHORIZE_URL =
  "https://auth.openai.com/oauth/authorize";

/** Token endpoint — grants + refreshes. */
export const OPENAI_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Callback URL the Codex/opencode flow expects. Their local
 *  server listens on this port. Not applicable here; we ingest
 *  tokens directly. */
export const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";

/** Scopes the Codex CLI requests. offline_access is what gets
 *  the refresh_token back. */
export const OPENAI_OAUTH_SCOPES = "openid profile email offline_access";

/**
 * ChatGPT-plan API base + Codex responses path. The full URL is
 *   https://chatgpt.com/backend-api/codex/responses
 * Auth: Bearer <access_token>; requires chatgpt-account-id +
 * OpenAI-Beta: responses=experimental + originator: codex_cli_rs.
 */
export const CHATGPT_BACKEND_API_BASE = "https://chatgpt.com/backend-api";
export const CHATGPT_CODEX_RESPONSES_URL = `${CHATGPT_BACKEND_API_BASE}/codex/responses`;

/** Headers every model call needs on top of Authorization +
 *  chatgpt-account-id. `originator` is what the Codex CLI sends
 *  and is what OpenAI's backend expects for subscription auth. */
export const CHATGPT_COMMON_HEADERS: Record<string, string> = {
  "OpenAI-Beta": "responses=experimental",
  originator: "codex_cli_rs",
};

/** Refresh access tokens this many ms BEFORE they expire. 5 min
 *  matches the spec — long enough to safely start a Style 2
 *  video (which can run 10+ min mid-request) without a mid-turn
 *  401 recovery. */
export const REFRESH_HORIZON_MS = 5 * 60 * 1_000;

/* ==================================================================
 * Refresh
 * ================================================================ */

export interface OpenAiRefreshResult {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry timestamp (ms). Computed from
   *  Date.now() + expires_in * 1000 on grant. */
  expiresAtMs: number;
}

export class OpenAiRefreshError extends Error {
  code:
    | "network"
    | "invalid_grant"
    | "invalid_response"
    | "http_error";
  status?: number;
  constructor(
    code: OpenAiRefreshError["code"],
    message: string,
    options?: { cause?: unknown; status?: number },
  ) {
    super(message, options);
    this.code = code;
    this.name = "OpenAiRefreshError";
    if (options?.status !== undefined) this.status = options.status;
  }
}

/**
 * Refresh a ChatGPT-OAuth access token using the stored
 * refresh_token. Returns the new access + refresh + expiry
 * triple; callers are responsible for atomically persisting it
 * BEFORE using the new access token, otherwise a crash between
 * refresh and persist wastes the refresh (OpenAI rotates
 * refresh tokens on some grants — assume ours does).
 *
 * Fails distinctly on invalid_grant vs transport error so the
 * caller can:
 *   invalid_grant → clear the credential, force re-connect
 *   network / http_error → keep the credential, surface the error
 */
export async function refreshOpenAiOAuthToken(
  refreshToken: string,
): Promise<OpenAiRefreshResult> {
  let resp: Response;
  try {
    resp = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OPENAI_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new OpenAiRefreshError(
      "network",
      `OpenAI token endpoint fetch failed: ${(err as Error).message?.slice(0, 200)}`,
      { cause: err },
    );
  }

  const bodyText = await resp.text();
  let body: Record<string, unknown> = {};
  try {
    body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    throw new OpenAiRefreshError(
      "invalid_response",
      `OpenAI token endpoint returned non-JSON body (${resp.status}): ${bodyText.slice(0, 200)}`,
      { status: resp.status },
    );
  }

  if (!resp.ok) {
    // OpenAI returns 400 with { error: "invalid_grant" } when
    // the refresh token has been rotated / revoked / expired.
    // Anything else is transient (rate limit, upstream flap).
    const errCode = String(body.error ?? "");
    if (errCode === "invalid_grant") {
      throw new OpenAiRefreshError(
        "invalid_grant",
        `OpenAI refresh_token rejected (invalid_grant). The credential must be re-connected.`,
        { status: resp.status },
      );
    }
    throw new OpenAiRefreshError(
      "http_error",
      `OpenAI token endpoint HTTP ${resp.status}: ${bodyText.slice(0, 200)}`,
      { status: resp.status },
    );
  }

  const accessToken =
    typeof body.access_token === "string" ? body.access_token : "";
  const newRefresh =
    typeof body.refresh_token === "string"
      ? body.refresh_token
      : refreshToken; // Some grants don't rotate the refresh token — keep the existing one if not returned.
  const expiresIn =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 0;
  if (!accessToken || expiresIn <= 0) {
    throw new OpenAiRefreshError(
      "invalid_response",
      `OpenAI token response missing access_token or expires_in: ${bodyText.slice(0, 200)}`,
      { status: resp.status },
    );
  }
  return {
    accessToken,
    refreshToken: newRefresh,
    expiresAtMs: Date.now() + expiresIn * 1_000,
  };
}

/**
 * Decode a ChatGPT-OAuth access token (JWT) enough to pull the
 * ChatGPT account id out. The claim path is
 *   payload["https://api.openai.com/auth"].chatgpt_account_id
 *
 * Returns null if the token isn't a JWT, if the claim is absent,
 * or if decoding fails — callers should treat null as "use the
 * stored chatgpt_account_id, don't re-derive". We do NOT verify
 * the signature; the token comes from OpenAI's OAuth endpoint
 * over TLS, and we trust the transport.
 */
export function extractChatgptAccountId(accessToken: string): string | null {
  if (typeof accessToken !== "string" || !accessToken) return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(padBase64(parts[1] ?? ""), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** JWTs use base64url without padding; Node's Buffer.from needs
 *  standard base64 with `=` padding. Convert and pad. */
function padBase64(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  return pad === 0 ? normalized : normalized + "=".repeat(4 - pad);
}
