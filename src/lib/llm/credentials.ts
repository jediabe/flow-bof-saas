/**
 * resolveLlmCredential — the single entry point every LLM call
 * site should route through to get a working set of provider
 * credentials + endpoint/headers/body-shape metadata.
 *
 * Walks the fallback chain (default: user_oauth → user_key →
 * app_key), skipping any credential whose credits_exhausted_until
 * is in the future, and refreshing an OAuth access token that's
 * within 5 minutes of expiry.
 *
 * The three modes are NOT header-compatible — they target
 * different HTTP endpoints with different body shapes:
 *
 *   app_key     → OpenAI /chat/completions or Anthropic /messages
 *   user_key    → same as app_key (user's own key)
 *   user_oauth  → OpenAI /responses (with chatgpt-account-id header)
 *
 * That's why callers get back an entire ResolvedCredential, not
 * just an API key. See the LlmMode / apiShape enums.
 *
 * Order of implementation:
 *   phase 1 (this commit) → app_key mode only; user_key / user_oauth
 *                           throw "not yet wired" until the schema
 *                           lands + the routes exist.
 *   phase 2 → agent-runner + providers.ts adopt this resolver.
 *   phase 3 → user_key route + settings UI.
 *   phase 4 → user_oauth device flow (needs the operator to hand
 *             over the reverse-engineered OpenAI endpoints).
 *   phase 5 → token refresh with per-user lock.
 *   phase 6 → credit exhaustion detection + fallthrough.
 *
 * SECURITY: never log the returned authHeader or the raw token.
 * Log the mode/provider/model instead.
 */

import { db } from "@/lib/db";
import { decryptLlmSecret, encryptLlmSecret } from "./crypto";
import {
  CHATGPT_CODEX_RESPONSES_URL,
  CHATGPT_COMMON_HEADERS,
  extractChatgptAccountId,
  OpenAiRefreshError,
  REFRESH_HORIZON_MS,
  refreshOpenAiOAuthToken,
} from "./openai-oauth";

/* ==================================================================
 * Public types
 * ================================================================ */

export type LlmMode = "app_key" | "user_key" | "user_oauth";
export type LlmProvider = "openai" | "anthropic";

/**
 * Request body shape this credential requires. NOT interchangeable
 * — chat_completions and responses have different message shapes,
 * different tool-use conventions, different streaming events.
 * Callers pick their loop implementation based on this.
 */
export type LlmApiShape =
  | "chat_completions" // OpenAI (and OpenAI-compat) /v1/chat/completions
  | "responses" // OpenAI /v1/responses — used by ChatGPT OAuth
  | "anthropic_messages"; // Anthropic /v1/messages

export interface ResolvedCredential {
  mode: LlmMode;
  provider: LlmProvider;
  endpoint: string;
  /** Full "Authorization: ..." value — do NOT log. */
  authHeader: string;
  /** Extra HTTP headers required by this mode. For user_oauth the
   *  Responses endpoint requires a chatgpt-account-id header. */
  extraHeaders: Record<string, string>;
  apiShape: LlmApiShape;
}

export interface ResolveOptions {
  /** Override the default fallback order for this resolve call.
   *  Rare — used by tests. In production keep the default. */
  order?: readonly LlmMode[];
}

export class LlmCredentialError extends Error {
  code:
    | "no_usable_credential"
    | "not_implemented"
    | "app_key_missing"
    | "decrypt_failed"
    | "invalid_row";
  constructor(
    code: LlmCredentialError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = "LlmCredentialError";
  }
}

/* ==================================================================
 * Endpoint constants
 * ================================================================ */

const OPENAI_CHAT_COMPLETIONS = "https://api.openai.com/v1/chat/completions";
const OPENAI_RESPONSES = "https://api.openai.com/v1/responses";
const ANTHROPIC_MESSAGES = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Default fallback chain. The order matters — user_oauth first
 * because it's the user's paid ChatGPT plan (they'd rather burn
 * their own subscription than an app key). user_key next
 * (still theirs). app_key last (yours, i.e. app-level fallback).
 */
export const DEFAULT_FALLBACK_ORDER: readonly LlmMode[] = [
  "user_oauth",
  "user_key",
  "app_key",
] as const;

/* ==================================================================
 * Public API
 * ================================================================ */

/**
 * Resolve the first usable credential for a user, walking the
 * fallback chain. Throws LlmCredentialError with code
 * "no_usable_credential" if nothing works.
 *
 * Currently (phase 1) only app_key is implemented — user_key and
 * user_oauth throw "not_implemented" internally so the resolver
 * falls straight through to app_key. Phase 2 wires them up.
 */
export async function resolveLlmCredential(
  userId: string,
  options: ResolveOptions = {},
): Promise<ResolvedCredential> {
  const order = options.order ?? DEFAULT_FALLBACK_ORDER;

  // Load the per-user row ONCE and pass it into each mode handler
  // so we don't hit the DB three times. Row is null when the user
  // has no personal credential — resolver falls straight to
  // app_key in that case.
  const row = await db.llmCredential.findUnique({
    where: { userId },
  });

  const errors: string[] = [];
  for (const mode of order) {
    try {
      const resolved = await tryMode(mode, userId, row);
      if (resolved) return resolved;
      // Handler returned null = credential absent for this mode.
      // Skip to next without recording an error.
    } catch (err) {
      // Handler returned a real error (bad decrypt, expired token,
      // etc.). Record it for the terminal error message but keep
      // walking.
      const detail =
        err instanceof Error ? err.message.slice(0, 200) : String(err);
      errors.push(`${mode}: ${detail}`);
    }
  }

  throw new LlmCredentialError(
    "no_usable_credential",
    `No usable LLM credential for user ${userId}. Tried ${order.join(", ")}. ` +
      (errors.length > 0 ? `Details: ${errors.join(" | ")}` : ""),
  );
}

/* ==================================================================
 * Per-mode handlers
 *
 * Return ResolvedCredential when a working credential exists,
 * null when the credential is simply absent (walk to next mode),
 * throw when something IS configured but broken (still walks to
 * next mode, but the error is captured for the terminal message).
 * ================================================================ */

async function tryMode(
  mode: LlmMode,
  userId: string,
  row: LlmCredentialRow | null,
): Promise<ResolvedCredential | null> {
  switch (mode) {
    case "app_key":
      return tryAppKey();
    case "user_key":
      return tryUserKey(userId, row);
    case "user_oauth":
      return tryUserOauth(userId, row);
  }
}

/* ----- app_key ------------------------------------------------- */

/**
 * app_key mode — reads the app-level fallback key from env.
 * Prefers OpenAI when both are set (arbitrary; the app owner can
 * flip it by unsetting the OpenAI key). Returns null when NO app
 * key is configured (that's a valid state — the app just requires
 * users to bring their own).
 */
function tryAppKey(): ResolvedCredential | null {
  const openaiKey = (process.env.APP_OPENAI_API_KEY ?? "").trim();
  const anthropicKey = (process.env.APP_ANTHROPIC_API_KEY ?? "").trim();

  if (openaiKey) {
    return {
      mode: "app_key",
      provider: "openai",
      endpoint: OPENAI_CHAT_COMPLETIONS,
      authHeader: `Bearer ${openaiKey}`,
      extraHeaders: {},
      apiShape: "chat_completions",
    };
  }
  if (anthropicKey) {
    return {
      mode: "app_key",
      provider: "anthropic",
      endpoint: ANTHROPIC_MESSAGES,
      authHeader: `Bearer ${anthropicKey}`,
      extraHeaders: {
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": anthropicKey,
      },
      apiShape: "anthropic_messages",
    };
  }
  return null;
}

/* ----- user_key ------------------------------------------------- */

async function tryUserKey(
  _userId: string,
  row: LlmCredentialRow | null,
): Promise<ResolvedCredential | null> {
  if (!row || row.mode !== "user_key") return null;
  if (!isCurrentlyUsable(row)) return null;
  if (!row.apiKeyEnc) {
    throw new LlmCredentialError(
      "invalid_row",
      "user_key row is missing apiKeyEnc",
    );
  }

  let apiKey: string;
  try {
    apiKey = decryptLlmSecret(row.apiKeyEnc);
  } catch (err) {
    throw new LlmCredentialError(
      "decrypt_failed",
      "Could not decrypt user_key credential — key rotated or row tampered.",
      { cause: err },
    );
  }

  return buildKeyCredential(row.provider as LlmProvider, apiKey, "user_key");
}

/* ----- user_oauth ---------------------------------------------- */

async function tryUserOauth(
  userId: string,
  row: LlmCredentialRow | null,
): Promise<ResolvedCredential | null> {
  if (!row || row.mode !== "user_oauth") return null;
  if (!isCurrentlyUsable(row)) return null;
  if (row.provider !== "openai") {
    // Anthropic has no subscription/OAuth path today. If a row
    // ever ends up here it's a bug in the ingestion layer.
    throw new LlmCredentialError(
      "invalid_row",
      `user_oauth is OpenAI-only; row.provider=${row.provider}`,
    );
  }
  if (
    !row.accessTokenEnc ||
    !row.refreshTokenEnc ||
    !row.accessExpiresAt ||
    !row.chatgptAccountId
  ) {
    throw new LlmCredentialError(
      "invalid_row",
      "user_oauth row missing accessTokenEnc / refreshTokenEnc / accessExpiresAt / chatgptAccountId",
    );
  }

  // Decrypt current tokens. A decrypt failure means the row is
  // unusable and needs re-connection — the caller can catch and
  // fall through.
  let accessToken: string;
  let refreshToken: string;
  try {
    accessToken = decryptLlmSecret(row.accessTokenEnc);
    refreshToken = decryptLlmSecret(row.refreshTokenEnc);
  } catch (err) {
    throw new LlmCredentialError(
      "decrypt_failed",
      "Could not decrypt user_oauth tokens — encryption key rotated or row tampered.",
      { cause: err },
    );
  }

  // Refresh if within the 5-min horizon. Guarded by a per-user
  // lock so concurrent turns don't race two refreshes against
  // each other (only one wins the rotation, the other invalidates
  // its own refresh_token).
  const msUntilExpiry = row.accessExpiresAt.getTime() - Date.now();
  if (msUntilExpiry <= REFRESH_HORIZON_MS) {
    ({ accessToken, refreshToken } = await refreshUnderLock(
      userId,
      refreshToken,
      accessToken,
    ));
  }

  return {
    mode: "user_oauth",
    provider: "openai",
    endpoint: CHATGPT_CODEX_RESPONSES_URL,
    authHeader: `Bearer ${accessToken}`,
    extraHeaders: {
      "chatgpt-account-id": row.chatgptAccountId,
      ...CHATGPT_COMMON_HEADERS,
    },
    apiShape: "responses",
  };
}

/* ==================================================================
 * Per-user refresh lock
 *
 * OpenAI rotates refresh tokens on refresh (opencode notes this
 * too). Two concurrent refreshes for the same user race, one wins,
 * the other's refresh_token becomes invalid — cascading into an
 * "invalid_grant" the next call over. The lock ensures every
 * concurrent caller waits for one refresh and reads the same new
 * pair. In-memory Map is fine — refresh takes <2s and this runs
 * inside a single Next.js process; a multi-instance deployment
 * would need a Redis lock, but that's a follow-up problem.
 * ================================================================ */

const inflightRefresh = new Map<
  string,
  Promise<{ accessToken: string; refreshToken: string }>
>();

async function refreshUnderLock(
  userId: string,
  currentRefreshToken: string,
  currentAccessToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const existing = inflightRefresh.get(userId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const result = await refreshOpenAiOAuthToken(currentRefreshToken);
      // Atomically persist the new pair BEFORE returning it — a
      // crash between refresh and persist wastes the refresh (the
      // rotated refresh_token in memory is lost).
      const newAccountId =
        extractChatgptAccountId(result.accessToken) ?? null;
      await db.llmCredential.update({
        where: { userId },
        data: {
          accessTokenEnc: encryptLlmSecret(result.accessToken),
          refreshTokenEnc: encryptLlmSecret(result.refreshToken),
          accessExpiresAt: new Date(result.expiresAtMs),
          ...(newAccountId ? { chatgptAccountId: newAccountId } : {}),
        },
      });
      console.log(
        `[llm-credentials] refreshed user_oauth for user=${userId}, expires in ${Math.round(
          (result.expiresAtMs - Date.now()) / 1000,
        )}s`,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
    } catch (err) {
      if (err instanceof OpenAiRefreshError && err.code === "invalid_grant") {
        // Refresh token is dead. Clear the row so subsequent
        // resolves fall through to user_key / app_key, and the
        // operator is prompted to re-connect. Do NOT throw
        // through the lock — return the OLD access token so if
        // it hasn't expired yet the current call can still limp
        // through this last time.
        console.warn(
          `[llm-credentials] user_oauth invalid_grant for user=${userId}; clearing credential`,
        );
        await db.llmCredential
          .delete({ where: { userId } })
          .catch(() => {});
        return {
          accessToken: currentAccessToken,
          refreshToken: currentRefreshToken,
        };
      }
      // Transient failure — keep the credential, propagate so
      // this turn errors out. Next turn will retry.
      throw err;
    }
  })();

  inflightRefresh.set(userId, promise);
  try {
    return await promise;
  } finally {
    inflightRefresh.delete(userId);
  }
}

/* ==================================================================
 * Helpers
 * ================================================================ */

/**
 * Shared response for user_key + app_key when the provider is
 * OpenAI or Anthropic. Kept as a helper so the two branches don't
 * drift.
 */
function buildKeyCredential(
  provider: LlmProvider,
  apiKey: string,
  mode: "user_key" | "app_key",
): ResolvedCredential {
  if (provider === "openai") {
    return {
      mode,
      provider: "openai",
      endpoint: OPENAI_CHAT_COMPLETIONS,
      authHeader: `Bearer ${apiKey}`,
      extraHeaders: {},
      apiShape: "chat_completions",
    };
  }
  // anthropic
  return {
    mode,
    provider: "anthropic",
    endpoint: ANTHROPIC_MESSAGES,
    authHeader: `Bearer ${apiKey}`,
    extraHeaders: {
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": apiKey,
    },
    apiShape: "anthropic_messages",
  };
}

/**
 * Skip this credential if it's under a credit-exhaustion cooldown
 * from the last "quota exceeded" response. The window is set by
 * phase 6's exhaustion detector; here we just enforce it.
 */
function isCurrentlyUsable(row: LlmCredentialRow): boolean {
  if (!row.creditsExhaustedUntil) return true;
  return row.creditsExhaustedUntil.getTime() <= Date.now();
}

/**
 * Local type for the row shape we care about. Kept independent of
 * Prisma's generated types so the exports remain stable if the
 * schema grows more columns.
 */
interface LlmCredentialRow {
  userId: string;
  mode: string;
  provider: string;
  apiKeyEnc: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessExpiresAt: Date | null;
  chatgptAccountId: string | null;
  creditsExhaustedUntil: Date | null;
}
