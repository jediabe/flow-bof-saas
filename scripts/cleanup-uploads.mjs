#!/usr/bin/env node
/**
 * Cleanup script — keep public/uploads/ small.
 *
 * The SaaS is intentionally NOT a media library:
 *   - Kalodata XLSX bytes never hit disk today (parsed in-memory).
 *   - Reference images are stored per-batch and only useful while the
 *     batch exists.
 *   - Generated videos / images never come back to the SaaS at all —
 *     they live in Google Flow.
 *
 * This script handles two house-keeping cases:
 *
 *   1. Temporary scratch files. Anything under public/uploads/_tmp/
 *      or public/uploads/excel/ older than 24h is deleted, plus empty
 *      sub-directories. Pre-empts any future Excel-persistence or
 *      import-staging tooling that drops working files there.
 *   2. Orphaned reference-image directories. public/uploads/batches/
 *      contains one subdirectory per Batch id; when a batch is
 *      deleted via the UI, the row goes away but the on-disk images
 *      stay. This sweep removes any per-batch directory whose Batch
 *      row no longer exists.
 *
 * Safety:
 *   - Never deletes the Prisma DB or anything outside public/uploads/.
 *   - Won't touch a batch directory whose row still exists — the row
 *     is the source of truth for "active", not file mtime.
 *   - Idempotent. Re-running has no effect after the first pass.
 *
 * Local dev: `npm run cleanup:uploads`.
 *
 * Production (cron, hourly):
 *   0 * * * * cd /opt/flow-bof/flow-bof-saas && \
 *     docker compose --env-file .env.production -f docker-compose.prod.yml \
 *     exec -T app node scripts/cleanup-uploads.mjs
 *
 * Plain ESM JS (not TypeScript) so the production image can execute
 * it directly with `node` — no tsx, no compile step.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PrismaClient } from "@prisma/client";

const PUBLIC_DIR = path.join(process.cwd(), "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
// Two layouts we sweep:
//   - Legacy:    public/uploads/batches/<batchId>/                  (alpha-1)
//   - Current:   public/uploads/workspaces/<wsId>/batches/<batchId>/ (post-auth)
// Both are walked because a long-lived deploy may still have files
// from the legacy layout sitting around.
const LEGACY_BATCHES_DIR = path.join(UPLOADS_DIR, "batches");
const WORKSPACES_DIR = path.join(UPLOADS_DIR, "workspaces");

const TEMP_DIRS = [
  // Conventional scratch locations. Either may be absent — we still
  // list both so future tooling has a defined "this folder gets
  // swept every hour" contract.
  path.join(UPLOADS_DIR, "_tmp"),
  path.join(UPLOADS_DIR, "excel"),
];

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function dirExists(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk a directory, delete every regular file older than the cutoff,
 * then remove now-empty subdirectories. The root dir itself stays.
 */
async function sweepTempDir(dir, cutoffMs, stats) {
  if (!(await dirExists(dir))) return;

  const entries = [];
  async function walk(d) {
    let items;
    try {
      items = await fs.readdir(d, { withFileTypes: true });
    } catch (err) {
      stats.errors += 1;
      console.warn(`readdir ${d}: ${err.message}`);
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        await walk(full);
        entries.push({ full, size: 0, isDir: true });
        continue;
      }
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs <= cutoffMs) {
          entries.push({ full, size: st.size, isDir: false });
        }
      } catch (err) {
        stats.errors += 1;
        console.warn(`stat ${full}: ${err.message}`);
      }
    }
  }
  await walk(dir);

  for (const e of entries) {
    try {
      if (e.isDir) {
        const remaining = await fs.readdir(e.full);
        if (remaining.length === 0) {
          await fs.rmdir(e.full);
        }
      } else {
        await fs.unlink(e.full);
        stats.tempFilesDeleted += 1;
        stats.tempBytesFreed += e.size;
      }
    } catch (err) {
      stats.errors += 1;
      console.warn(`delete ${e.full}: ${err.message}`);
    }
  }
}

/**
 * Walk a batches/ directory and remove subdirectories whose ID
 * doesn't appear in `liveSet`. Returns counts via the shared
 * `stats` object. The DB row is the authoritative signal for
 * "this batch is still active" — never mtime.
 */
async function sweepBatchesUnder(parentDir, liveSet, stats) {
  if (!(await dirExists(parentDir))) return;
  const dirEntries = await fs.readdir(parentDir, { withFileTypes: true });
  const batchDirIds = dirEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const id of batchDirIds) {
    if (liveSet.has(id)) continue;
    const dir = path.join(parentDir, id);
    try {
      const fileEntries = await fs.readdir(dir);
      let bytes = 0;
      for (const f of fileEntries) {
        try {
          const st = await fs.stat(path.join(dir, f));
          bytes += st.size;
        } catch {
          /* best-effort */
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
      stats.orphanBatchesDeleted += 1;
      stats.orphanFilesDeleted += fileEntries.length;
      stats.orphanBytesFreed += bytes;
      console.log(
        `removed orphan batch dir ${dir}: ${fileEntries.length} file(s), ${bytes} bytes`,
      );
    } catch (err) {
      stats.errors += 1;
      console.warn(`rm ${dir}: ${err.message}`);
    }
  }
}

/**
 * Remove orphaned per-batch directories from both layouts:
 *
 *   - Legacy:  public/uploads/batches/<batchId>/
 *   - Current: public/uploads/workspaces/<wsId>/batches/<batchId>/
 *
 * We collect every <batchId> across both trees, ask the DB which are
 * still alive in one query, then delete anything that isn't.
 */
async function sweepOrphanBatchDirs(db, stats) {
  const candidateIds = new Set();

  if (await dirExists(LEGACY_BATCHES_DIR)) {
    for (const e of await fs.readdir(LEGACY_BATCHES_DIR, { withFileTypes: true })) {
      if (e.isDirectory()) candidateIds.add(e.name);
    }
  }

  if (await dirExists(WORKSPACES_DIR)) {
    for (const ws of await fs.readdir(WORKSPACES_DIR, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const batchesDir = path.join(WORKSPACES_DIR, ws.name, "batches");
      if (!(await dirExists(batchesDir))) continue;
      for (const e of await fs.readdir(batchesDir, { withFileTypes: true })) {
        if (e.isDirectory()) candidateIds.add(e.name);
      }
    }
  }

  if (candidateIds.size === 0) return;

  const live = await db.batch.findMany({
    where: { id: { in: Array.from(candidateIds) } },
    select: { id: true },
  });
  const liveSet = new Set(live.map((b) => b.id));

  // Legacy layout.
  await sweepBatchesUnder(LEGACY_BATCHES_DIR, liveSet, stats);

  // Current layout — one batches/ dir per workspace.
  if (await dirExists(WORKSPACES_DIR)) {
    for (const ws of await fs.readdir(WORKSPACES_DIR, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      const batchesDir = path.join(WORKSPACES_DIR, ws.name, "batches");
      await sweepBatchesUnder(batchesDir, liveSet, stats);
      // Collapse a now-empty workspace dir so we don't accumulate
      // empty workspace folders forever.
      try {
        const remaining = await fs.readdir(batchesDir);
        if (remaining.length === 0) await fs.rmdir(batchesDir);
        const wsRoot = path.join(WORKSPACES_DIR, ws.name);
        const wsRemaining = await fs.readdir(wsRoot);
        if (wsRemaining.length === 0) await fs.rmdir(wsRoot);
      } catch {
        /* best-effort */
      }
    }
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

async function main() {
  const cutoff = Date.now() - TEMP_MAX_AGE_MS;
  const stats = {
    tempFilesDeleted: 0,
    tempBytesFreed: 0,
    orphanBatchesDeleted: 0,
    orphanFilesDeleted: 0,
    orphanBytesFreed: 0,
    errors: 0,
  };

  console.log(
    `cleanup-uploads: sweeping temp files older than 24h + orphan batch dirs`,
  );
  console.log(`  uploads root: ${UPLOADS_DIR}`);

  for (const dir of TEMP_DIRS) {
    await sweepTempDir(dir, cutoff, stats);
  }

  const db = new PrismaClient();
  try {
    await sweepOrphanBatchDirs(db, stats);
  } finally {
    await db.$disconnect();
  }

  console.log(
    `done: ${stats.tempFilesDeleted} temp file(s) (${fmtBytes(stats.tempBytesFreed)}), ` +
      `${stats.orphanBatchesDeleted} orphan batch(es) ` +
      `(${stats.orphanFilesDeleted} files, ${fmtBytes(stats.orphanBytesFreed)}), ` +
      `${stats.errors} error(s)`,
  );
}

main().catch((err) => {
  console.error("cleanup-uploads failed:", err);
  process.exit(1);
});
