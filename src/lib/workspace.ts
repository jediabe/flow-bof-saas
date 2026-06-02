/**
 * Resolve the authenticated user + their workspace.
 *
 * Every server action, server component, and API route that touches
 * user data MUST call `getCurrentWorkspace()` and scope its Prisma
 * queries to `workspace.id`. Skipping that scope is how
 * cross-workspace leaks happen; the audit in this milestone tracked
 * down every existing caller.
 *
 * Auth contract:
 *   - Reads the signed session cookie (`flowbof_session`).
 *   - Verifies it with the symmetric AUTH_SECRET key.
 *   - Loads the matching User row + their owned Workspace row.
 *   - If anything is missing/invalid, redirects to /login by default.
 *
 * Test-mode hatch:
 *   When ALLOW_AUTH_BYPASS=true (only honoured outside production),
 *   we fall back to the env-driven default user + workspace. That
 *   keeps the seed script and a quick-dev "no signup needed" mode
 *   working. NEVER set this in production.
 */
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { readSessionToken, verifySession } from "@/lib/auth";

export interface CurrentUser {
  id:        string;
  email:     string;
  name:      string | null;
  createdAt: Date;
}

export interface CurrentWorkspace {
  id:        string;
  name:      string;
  ownerId:   string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resolve the authenticated user. Redirects to /login if no valid
 * session is present (the redirect throws, so callers can treat the
 * return value as always-truthy).
 *
 * Pass `{ optional: true }` from places that genuinely have no
 * fallback (e.g. the /login page itself, where redirecting again
 * would loop).
 */
export async function getCurrentUser(opts?: {
  optional?: boolean;
}): Promise<CurrentUser | null> {
  const claims = await readClaims();
  if (claims) {
    const user = await db.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (user) return user;
  }

  // Dev-only bypass: lets the seed script + `ALLOW_AUTH_BYPASS=true
  // npm run dev` keep working without forcing a real signup. Refuse
  // to honour it in production no matter what.
  if (
    process.env.NODE_ENV !== "production" &&
    (process.env.ALLOW_AUTH_BYPASS || "").toLowerCase() === "true"
  ) {
    const fallback = await loadOrCreateDevUser();
    if (fallback) return fallback;
  }

  if (opts?.optional) return null;
  redirect("/login");
}

/**
 * Resolve the user's owned workspace. Creates one on first login —
 * a freshly-signed-up user always has exactly one workspace, named
 * after them, so we lazy-init here instead of in the signup handler.
 *
 * The signature returns both user + workspace so most server actions
 * keep the existing one-line pattern:
 *
 *   const { user, workspace } = await getCurrentWorkspace();
 */
export async function getCurrentWorkspace(): Promise<{
  user: CurrentUser;
  workspace: CurrentWorkspace;
}> {
  const user = await getCurrentUser();
  if (!user) {
    // getCurrentUser will already have redirected; this is just to
    // narrow the type for TS.
    redirect("/login");
  }

  let workspace = await db.workspace.findFirst({
    where: { ownerId: user.id },
    orderBy: { createdAt: "asc" },
  });
  if (!workspace) {
    const name = user.name?.trim()
      ? `${user.name.trim()}'s Workspace`
      : "My Workspace";
    workspace = await db.workspace.create({
      data: { name, ownerId: user.id },
    });
  }
  return { user, workspace };
}

async function readClaims() {
  const token = await readSessionToken();
  if (!token) return null;
  return await verifySession(token);
}

/**
 * Dev-only: get-or-create a default user/workspace pair driven by
 * env. Used by the seed script + the ALLOW_AUTH_BYPASS escape
 * hatch. Refuses to run in production.
 */
async function loadOrCreateDevUser(): Promise<CurrentUser | null> {
  if (process.env.NODE_ENV === "production") return null;
  const email = process.env.DEFAULT_USER_EMAIL || "alpha@example.com";
  const name = process.env.DEFAULT_USER_NAME || "Alpha User";
  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    user = await db.user.create({ data: { email, name } });
  }
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  };
}
