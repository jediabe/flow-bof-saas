/**
 * Password hashing — bcryptjs (pure JS, no native bindings).
 *
 * bcrypt rounds: 10 is the industry default. Bumping to 12 doubles
 * the verify cost; on a typical VPS that's ~250ms per login. Stay
 * at 10 unless brute-force becomes a measurable concern.
 */

import bcrypt from "bcryptjs";

const ROUNDS = 10;

/** Hash a plaintext password. Never log the input or output. */
export async function hashPassword(plaintext: string): Promise<string> {
  return await bcrypt.hash(plaintext, ROUNDS);
}

/** Constant-time compare via bcrypt. Safe to call with hash=null
 *  (returns false) so callers don't need to branch on the user's
 *  existence first. */
export async function verifyPassword(
  plaintext: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Validate a password against the alpha policy. Returns the first
 * problem found or null when the password is acceptable.
 *
 * Policy is intentionally permissive — alpha-quality signups. Bump
 * the floor when the product moves to public-signup.
 */
export function validatePassword(plaintext: string): string | null {
  if (typeof plaintext !== "string") return "Password is required.";
  if (plaintext.length < 8) return "Password must be at least 8 characters.";
  if (plaintext.length > 200) return "Password is too long.";
  return null;
}

/** Crude email validation. The DB has a unique constraint as the
 *  belt + suspenders; this is just to catch typos at the form. */
export function validateEmail(email: string): string | null {
  const trimmed = (email || "").trim();
  if (!trimmed) return "Email is required.";
  if (trimmed.length > 320) return "Email is too long.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email.";
  return null;
}
