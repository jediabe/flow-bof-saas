/**
 * Workspace resolution for the skeleton.
 *
 * Real auth (Clerk / Auth.js / Supabase) plugs in here in Phase 4. For
 * the alpha skeleton we just return the first workspace owned by the
 * default user — and create both lazily on first call. This keeps every
 * page/server-action workable without a real login.
 */
import { db } from "@/lib/db";

export async function getCurrentWorkspace() {
  const email = process.env.DEFAULT_USER_EMAIL || "alpha@example.com";
  const name = process.env.DEFAULT_USER_NAME || "Alpha User";
  const wsName = process.env.DEFAULT_WORKSPACE_NAME || "My Workspace";

  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    user = await db.user.create({ data: { email, name } });
  }

  let workspace = await db.workspace.findFirst({
    where: { ownerId: user.id },
    orderBy: { createdAt: "asc" },
  });
  if (!workspace) {
    workspace = await db.workspace.create({
      data: { name: wsName, ownerId: user.id },
    });
  }

  return { user, workspace };
}
