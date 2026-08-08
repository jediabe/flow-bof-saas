/** Small security helpers. */

import { timingSafeEqual } from "node:crypto";

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length is the only signal.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Masks a token for logs: `user:123…wxyz`. */
export function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/**
 * Masks an email the way useapi.net does in job ids and account listings:
 * `jonathan@gmail.com` -> `jo***@gmail.com`.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
