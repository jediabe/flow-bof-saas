/**
 * Connected-runner token utilities.
 *
 * The polling runner authenticates against /api/runner/* with
 * `Authorization: Bearer <runner_token>`. The full token is shown to
 * the user exactly once (right after generation); only its SHA-256
 * digest lands in the DB. A dump of the Agent row therefore never
 * yields a usable credential.
 *
 * Token shape: `runner_<base64url(32 random bytes)>` (~ 43 chars after
 * the prefix). The prefix gives us a cheap "this is a runner token"
 * sniff before we even hit the database.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

export interface MintedRunnerToken {
  token: string;       // full token, shown to user ONCE
  tokenHash: string;   // SHA-256 hex digest — what we store
  last4: string;       // last 4 chars of the token, safe to display later
}

/**
 * Mint a fresh runner token. Returns the full token (so the caller
 * can show it to the user one time), the hash to persist, and the
 * last-4 preview.
 */
export function mintRunnerToken(): MintedRunnerToken {
  // 32 bytes → 43-char base64url (no padding). Plenty of entropy
  // (256 bits) without making the token unwieldy to copy/paste.
  const raw = randomBytes(32).toString("base64url");
  const token = `runner_${raw}`;
  return {
    token,
    tokenHash: hashToken(token),
    last4: token.slice(-4),
  };
}

/** SHA-256 hex digest. Stable, fast, no salt — tokens are random
 *  per-agent so a rainbow table buys nothing. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Pull the bearer token out of an Authorization header. Tolerates the
 * usual whitespace + case variations. Returns "" when no usable
 * token is present so callers can fail with a single 401 branch.
 */
export function extractBearer(header: string | null | undefined): string {
  if (!header) return "";
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : "";
}

/**
 * Constant-time compare for two SHA-256 hex digests. Hash mismatch is
 * the *failed-auth* code path; we don't want to leak how-different
 * the wrong token was via timing.
 */
export function timingSafeHashEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export interface AgentForRunner {
  id: string;
  workspaceId: string;
  name: string;
  status: string;
  connectedAt: Date | null;
}

/**
 * Look up an agent by the raw token from an Authorization header.
 * Returns null when the header is missing/malformed or no Agent row
 * matches the hash. Side-effect-free — bump `lastPollAt`/`status` in
 * the caller after the auth succeeds.
 *
 * The double lookup (hash filter + timing-safe re-check) is paranoia:
 * Prisma's unique-where short-circuits but the explicit eq guards
 * against any future DB feature that returns prefix matches.
 */
export async function findAgentForToken(
  authHeader: string | null | undefined,
): Promise<AgentForRunner | null> {
  const token = extractBearer(authHeader);
  if (!token || !token.startsWith("runner_")) return null;

  const hash = hashToken(token);
  const agent = await db.agent.findUnique({
    where: { runnerTokenHash: hash },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      status: true,
      connectedAt: true,
      runnerTokenHash: true,
    },
  });
  if (!agent || !agent.runnerTokenHash) return null;
  if (!timingSafeHashEq(agent.runnerTokenHash, hash)) return null;
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    status: agent.status,
    connectedAt: agent.connectedAt,
  };
}

/**
 * Bump bookkeeping columns after a successful authenticated runner
 * request. Cheap — single UPDATE.
 *
 * - `lastPollAt` / `lastSeenAt` bump every call.
 * - `status` flips to "online" on a health POST (passed via
 *   `markOnline`).
 * - `connectedAt` is *sticky* once set — only health POSTs may set
 *   it, and only the first time. Revoke-and-regenerate is how the
 *   user clears it (the action explicitly nulls the column).
 */
export async function recordRunnerActivity(
  agent: { id: string; connectedAt?: Date | null } | string,
  opts: { markOnline?: boolean } = {},
): Promise<void> {
  const now = new Date();
  const agentId = typeof agent === "string" ? agent : agent.id;
  const setConnectedAt =
    typeof agent !== "string" && opts.markOnline && !agent.connectedAt;
  await db.agent.update({
    where: { id: agentId },
    data: {
      lastPollAt: now,
      lastSeenAt: now,
      ...(opts.markOnline ? { status: "online" } : {}),
      ...(setConnectedAt ? { connectedAt: now } : {}),
    },
  });
}
