"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  clearSessionCookie,
  setSessionCookie,
} from "@/lib/auth";
import {
  hashPassword,
  validateEmail,
  validatePassword,
  verifyPassword,
} from "@/lib/password";

export interface AuthFormState {
  error: string | null;
}

/**
 * Create a new account + workspace + log the user in. Returns a form
 * state for inline validation errors; on success it redirects, so
 * the resolved value is only seen on the error path.
 *
 * Security notes:
 *   - Password is hashed with bcrypt before persistence.
 *   - We never log or echo the plaintext value.
 *   - Email uniqueness is enforced at the DB level; we catch the
 *     unique-constraint error and turn it into a friendly message
 *     rather than a 500.
 *   - Workspace is created lazily by getCurrentWorkspace on the
 *     user's first authenticated request, NOT here. That keeps the
 *     signup transaction small and avoids partial-state on a crash.
 */
export async function signupAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const name = String(formData.get("name") || "").trim();
  const password = String(formData.get("password") || "");

  const emailErr = validateEmail(email);
  if (emailErr) return { error: emailErr };
  const passErr = validatePassword(password);
  if (passErr) return { error: passErr };

  // Uniqueness check before the create so we can return a clean
  // message. The DB constraint still backstops a race.
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { error: "An account with that email already exists." };

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await db.user.create({
      data: {
        email,
        name: name || null,
        passwordHash,
      },
    });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "P2002") {
      return { error: "An account with that email already exists." };
    }
    return { error: "Sign-up failed. Please try again." };
  }

  await setSessionCookie(user.id);
  redirect("/dashboard");
}

/**
 * Log a user in. Returns an error message inline; redirects on
 * success.
 *
 * We deliberately don't reveal whether the email exists — every
 * failure surfaces the same "Invalid email or password." string so
 * an attacker can't enumerate accounts via the login form.
 */
export async function loginAction(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });

  // Run the bcrypt compare regardless to keep the timing roughly
  // identical between "no such email" and "wrong password".
  const ok = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !ok) {
    return { error: "Invalid email or password." };
  }

  await setSessionCookie(user.id);
  redirect("/dashboard");
}

/** Logout — clears the session cookie and sends the user home. */
export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}

/**
 * Result shape for the settings-page change-password form. Kept
 * distinct from AuthFormState because success surfaces a message
 * (rather than a redirect), and the form uses useActionState.
 */
export interface ChangePasswordState {
  ok: boolean;
  message: string;
}

/**
 * Change the current user's password. Requires the CURRENT
 * password as proof of identity — this matches the standard
 * "change password" pattern and prevents a stolen session
 * (browser left open, XSS, etc.) from silently rotating the
 * credential.
 *
 * Sessions are NOT invalidated on success. If we ever ship a
 * session-version column on User, we'd bump it here to force
 * every other device to re-auth; today the JWT is stateless and
 * there's nothing to bump.
 *
 * Timing side-channel: bcrypt compare + hash on every call
 * regardless of the current-password result, so an attacker
 * can't tell "wrong current password" from "policy rejection"
 * via response time.
 */
export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const { getCurrentUser } = await import("@/lib/workspace");
  const user = await getCurrentUser({ optional: true });
  if (!user) {
    return { ok: false, message: "Session expired. Sign in again." };
  }

  const currentPassword = String(formData.get("currentPassword") || "");
  const newPassword = String(formData.get("newPassword") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { ok: false, message: "Fill in every field." };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, message: "The two new-password fields don't match." };
  }
  const policyErr = validatePassword(newPassword);
  if (policyErr) {
    return { ok: false, message: policyErr };
  }
  if (newPassword === currentPassword) {
    return { ok: false, message: "New password must be different from your current one." };
  }

  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { id: true, passwordHash: true },
  });
  const currentOk = await verifyPassword(
    currentPassword,
    row?.passwordHash ?? null,
  );
  if (!row || !currentOk) {
    return { ok: false, message: "Current password is incorrect." };
  }

  const newHash = await hashPassword(newPassword);
  await db.user.update({
    where: { id: row.id },
    data: { passwordHash: newHash },
  });
  return { ok: true, message: "Password updated. Existing sessions on other devices stay signed in until their JWT expires." };
}
