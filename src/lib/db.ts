/**
 * Prisma client singleton. In dev, Next.js hot-reloads modules which
 * would otherwise spawn a fresh client every change and exhaust the
 * Postgres connection pool. The globalThis cache below keeps a single
 * client across reloads.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
