/**
 * Phase 6 — Flow reconciliation ingester.
 *
 * Reads the result of completed runner jobs and upserts FlowItem
 * rows so the batch page can render the reconciliation UI. Two
 * sources:
 *
 *   1. scan_favorited_images jobs return a list of tile items with
 *      media_id / tile_id / edit_id / thumbnail / kind / favorited.
 *      Each item becomes a FlowItem row (upsert keyed on
 *      workspaceId + mediaId). The favorited flag is updated on
 *      every ingest so a re-favoriting in Flow is reflected.
 *
 *   2. generate_flow_images jobs return per-item metadata that
 *      includes media_id for each SaaS-driven generation. We use
 *      that to AUTO-BIND newly-discovered scan items back to the
 *      Product they were generated from, so the user doesn't have
 *      to manually drag-bind their own past generations.
 *
 * The ingester is idempotent — running it twice has no extra
 * effect. We mark each Job with `ingestedAt` (in the Job.result
 * field) once consumed; subsequent runs skip already-ingested
 * jobs. (Optimisation, not correctness — the upserts themselves
 * are safe to repeat.)
 *
 * No user-facing UI yet; the next chunk (6d) renders the new
 * data.
 */

import { db } from "@/lib/db";
import { parseJson } from "@/lib/json-column";

interface ScanItem {
  media_id?: string;
  tile_id?: string;
  edit_id?: string;
  tile_href?: string;
  kind?: string;
  favorited?: boolean;
  thumbnail_src?: string;
}

interface ScanResult {
  items?: ScanItem[];
  favorited_images_count?: number;
  favorited_videos_count?: number;
  tiles_scanned?: number;
}

interface ImageGenItem {
  item_id?: string;     // the SaaS Product.id we dispatched
  status?: string;
  media_id?: string;    // Flow's stable handle (when captured)
  tile_id?: string;
}

interface ImageGenResult {
  items?: ImageGenItem[];
}

export interface FlowItemIngestSummary {
  /** Total scan items seen across all scans for this batch. */
  totalScanItems: number;
  /** New FlowItem rows created by this ingest pass. */
  newRows: number;
  /** Existing FlowItem rows whose favorited/thumbnail/etc. was
   *  refreshed by the latest scan. */
  updatedRows: number;
  /** Rows auto-bound via origin matching during this pass. */
  autoBoundRows: number;
  /** ISO timestamp of the most-recent successful scan ingested,
   *  or null if no scan has run for this batch yet. */
  lastScanAt: string | null;
}

/**
 * Walk the batch's scan + image-gen jobs and bring the FlowItem
 * table up to date. Safe to call on every page render — does
 * nothing when there are no new jobs since the last ingest.
 *
 * Called from src/app/batches/[id]/page.tsx (server-side, before
 * the UI renders) so the Flow items tab always shows fresh data.
 */
export async function ingestFlowItemsForBatch(input: {
  workspaceId: string;
  batchId: string;
}): Promise<FlowItemIngestSummary> {
  const { workspaceId, batchId } = input;

  // ---- Build a lookup of media_id → productId from SaaS-driven
  //      image generations. Used for auto-binding scan items that
  //      came from a SaaS job to the Product that triggered it.
  const imageGenJobs = await db.job.findMany({
    where: {
      workspaceId,
      batchId,
      jobType: "generate_flow_images",
      status: "succeeded",
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, result: true, createdAt: true },
  });

  const mediaIdToProduct = new Map<string, { productId: string; jobId: string }>();
  for (const j of imageGenJobs) {
    const r = j.result ? (parseJson(j.result) as ImageGenResult | null) : null;
    const items = r?.items ?? [];
    for (const it of items) {
      const mid = (it.media_id ?? "").trim();
      const pid = (it.item_id ?? "").trim();
      if (!mid || !pid) continue;
      // First-seen wins — keep the OLDEST job's binding so a re-
      // generation doesn't overwrite the original product link.
      if (!mediaIdToProduct.has(mid)) {
        mediaIdToProduct.set(mid, { productId: pid, jobId: j.id });
      }
    }
  }

  // ---- Walk completed scans, ingest items. Order ASC by createdAt
  //      so newer scans overwrite older ones for shared keys
  //      (correct because a newer scan's favorited state is more
  //      authoritative).
  const scanJobs = await db.job.findMany({
    where: {
      workspaceId,
      batchId,
      jobType: "scan_favorited_images",
      status: "succeeded",
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, result: true, createdAt: true },
  });

  let totalItems = 0;
  let newRows = 0;
  let updatedRows = 0;
  let autoBound = 0;
  let lastScanAt: Date | null = null;

  for (const j of scanJobs) {
    const r = j.result ? (parseJson(j.result) as ScanResult | null) : null;
    const items = r?.items ?? [];
    lastScanAt = j.createdAt;

    for (const it of items) {
      const mediaId = (it.media_id ?? "").trim();
      if (!mediaId) continue;
      totalItems += 1;

      // Decide auto-bind target. Only on FIRST creation — we don't
      // overwrite a user's manual binding on subsequent scans.
      const autoBindTarget = mediaIdToProduct.get(mediaId);

      // Upsert keyed on (workspaceId, mediaId) — the unique index
      // on the table. Existing rows update favorited / thumbnail
      // / tileId / editId from the latest scan but DO NOT touch
      // bindState or productId (user actions are sticky).
      const existing = await db.flowItem.findUnique({
        where: { workspaceId_mediaId: { workspaceId, mediaId } },
      });

      if (existing) {
        await db.flowItem.update({
          where: { id: existing.id },
          data: {
            tileId:       it.tile_id || existing.tileId,
            editId:       it.edit_id || existing.editId,
            tileHref:     it.tile_href || existing.tileHref,
            kind:         (it.kind || existing.kind) || "unknown",
            favorited:    !!it.favorited,
            thumbnailUrl: it.thumbnail_src || existing.thumbnailUrl,
            // Surface this scan as the "still seen" signal. The
            // firstSeenJobId / firstSeenAt stay frozen on first
            // ingest — useful for "when did we first see this?"
            // questions in the UI.
          },
        });
        updatedRows += 1;
      } else {
        await db.flowItem.create({
          data: {
            workspaceId,
            batchId,
            // Auto-bind: if this mediaId was generated by a SaaS
            // job, set bindState="auto" + productId. Otherwise
            // it's unbound and the user can drag-bind manually.
            productId:      autoBindTarget?.productId ?? null,
            bindState:      autoBindTarget ? "auto" : "unbound",
            mediaId,
            tileId:         it.tile_id || null,
            editId:         it.edit_id || null,
            tileHref:       it.tile_href || null,
            kind:           it.kind || "unknown",
            favorited:      !!it.favorited,
            thumbnailUrl:   it.thumbnail_src || null,
            firstSeenJobId: j.id,
            firstSeenAt:    j.createdAt,
          },
        });
        newRows += 1;
        if (autoBindTarget) autoBound += 1;
      }
    }
  }

  return {
    totalScanItems: totalItems,
    newRows,
    updatedRows,
    autoBoundRows: autoBound,
    lastScanAt: lastScanAt?.toISOString() ?? null,
  };
}

/** Convenience: count rows by bindState for a batch. Used by the
 *  Flow items tab header to show "X unmatched · Y bound · Z
 *  ignored" without a separate aggregation query. */
export async function countFlowItemsByState(input: {
  workspaceId: string;
  batchId: string;
}): Promise<{
  unbound: number;
  bound: number;
  ignored: number;
  auto: number;
  total: number;
}> {
  const rows = await db.flowItem.groupBy({
    by: ["bindState"],
    where: {
      workspaceId: input.workspaceId,
      batchId: input.batchId,
    },
    _count: { _all: true },
  });
  const out = { unbound: 0, bound: 0, ignored: 0, auto: 0, total: 0 };
  for (const r of rows) {
    const k = r.bindState as keyof typeof out;
    const n = r._count._all;
    if (k === "unbound" || k === "bound" || k === "ignored" || k === "auto") {
      out[k] = n;
    }
    out.total += n;
  }
  return out;
}
