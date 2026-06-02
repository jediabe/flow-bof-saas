/**
 * Seeds a single default workspace + user so the skeleton renders
 * something on first run. Real auth replaces this in Phase 4.
 *
 * Run with:  npm run db:seed
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const email = process.env.DEFAULT_USER_EMAIL || "alpha@example.com";
  const name = process.env.DEFAULT_USER_NAME || "Alpha User";
  const wsName = process.env.DEFAULT_WORKSPACE_NAME || "My Workspace";

  const user = await db.user.upsert({
    where: { email },
    update: { name },
    create: { email, name },
  });

  // One workspace per user for the skeleton — find-or-create by
  // (ownerId, name).
  const ws = await db.workspace.findFirst({
    where: { ownerId: user.id, name: wsName },
  });
  if (!ws) {
    await db.workspace.create({
      data: { name: wsName, ownerId: user.id },
    });
  }

  console.log(`Seeded user ${email} + workspace "${wsName}".`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
