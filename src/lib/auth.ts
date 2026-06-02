/**
 * Session helpers — sign + verify HS256 JWTs stored in an HttpOnly
 * cookie. Pure Web-Crypto (`jose`), works in both the Node and Edge
 * runtimes so middleware can read sessions without pulling in
 * Prisma.
 *
 * We deliberately don't ship the user's name/email inside the JWT
 * claims — only their id. That way a rename / email change doesn't
 * silently leave stale info in active sessions; the server actions
 * always re-load the row.
 */

import { cookies } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const COOKIE_NAME = "flowbof_session";
const ALGO = "HS256";
// Same lifetime the cookie carries — keep them in sync.
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface SessionClaims {
  /** User.id. */
  sub: string;
  /** Issued at, seconds since epoch. */
  iat: number;
}

/** Resolve the symmetric signing key. Throws if AUTH_SECRET is unset
 *  or too short to be meaningful (32 chars minimum — `openssl rand
 *  -base64 48` clears it). */
function getKey(): Uint8Array {
  const raw = process.env.AUTH_SECRET ?? "";
  if (raw.length < 32) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Generate one with " +
        "`openssl rand -base64 48` and set it in your env.",
    );
  }
  return new TextEncoder().encode(raw);
}

/**
 * Sign a session JWT for a given user. Caller is responsible for
 * setting the resulting string as a cookie — kept separate so this
 * function works in both server actions (cookies()) and route
 * handlers (Response.headers).
 */
export async function signSession(userId: string): Promise<string> {
  return await new SignJWT({ sub: userId } satisfies Partial<SessionClaims>)
    .setProtectedHeader({ alg: ALGO })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getKey());
}

/**
 * Verify a session JWT. Returns the claims on success, null on any
 * failure (expired, tampered, missing). Never throws — callers
 * branch on the null and either ignore it (middleware redirects) or
 * 401 (route handlers).
 */
export async function verifySession(token: string): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getKey(), {
      algorithms: [ALGO],
    });
    return payloadToClaims(payload);
  } catch {
    return null;
  }
}

function payloadToClaims(p: JWTPayload): SessionClaims | null {
  if (typeof p.sub !== "string" || !p.sub) return null;
  if (typeof p.iat !== "number") return null;
  return { sub: p.sub, iat: p.iat };
}

// ---------------------------------------------------------------------
// Cookie reads/writes (server-side helpers — Node runtime only)
// ---------------------------------------------------------------------

/**
 * Bake the session cookie into the request's response. Safe to call
 * from server actions (`cookies()` is read/write there).
 */
export async function setSessionCookie(userId: string): Promise<void> {
  const token = await signSession(userId);
  const jar = await cookies();
  jar.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Clear the session cookie (logout). */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

/** Read the raw cookie value from a server context. Returns "" when
 *  no cookie is present. */
export async function readSessionToken(): Promise<string> {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value ?? "";
}

/** Session cookie name — exposed so middleware can also read it. */
export const SESSION_COOKIE_NAME = COOKIE_NAME;
