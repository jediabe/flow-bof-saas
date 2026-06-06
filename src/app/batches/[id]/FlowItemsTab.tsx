"use client";

import { useMemo, useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import {
  bindFlowItemToProduct,
  unbindFlowItem,
  ignoreFlowItem,
  unignoreFlowItem,
} from "../actions";

/**
 * Phase 6 — Flow reconciliation tab.
 *
 * Split view:
 *   - Left: grid of unmatched FlowItem tiles (the things the
 *     scanner found that the SaaS hasn't matched to a product).
 *     Each tile is draggable.
 *   - Right: list of products in this batch. Each row is a drop
 *     target; dropping a tile onto a product calls
 *     bindFlowItemToProduct.
 *   - Bottom: collapsible "Bound (N)" and "Ignored (N)" sections
 *     so the user can review past actions and unbind / un-ignore.
 *   - Drop-on-Ignore: a dashed zone to the right of the tiles
 *     grid; dropping marks the tile ignored (with an optional
 *     reason prompt).
 *
 * The interaction model is intentionally simple: HTML5 native
 * drag-and-drop (no react-dnd dep). Drag image → drop on product
 * row OR ignore zone. Click image for a popup menu with the same
 * actions (mobile fallback + keyboard users).
 *
 * Why no scan button in this component: scanning is a runner job
 * triggered from the existing BatchWorkbench. Once a scan
 * completes, the parent page.tsx re-renders and the ingester
 * (lib/flow-items.ts) populates the FlowItem rows we render here.
 */

export type FlowItemBindState = "unbound" | "bound" | "ignored" | "auto";

export interface FlowItemRow {
  id: string;
  bindState: FlowItemBindState;
  mediaId: string | null;
  tileHref: string | null;
  kind: string;
  favorited: boolean;
  thumbnailUrl: string | null;
  productId: string | null;
  notes: string | null;
  firstSeenAt: string;
}

export interface FlowItemsTabProduct {
  id: string;
  productName: string;
  thumbnailUrl: string | null;
  reviewStatus: string;
}

export default function FlowItemsTab({
  batchId,
  items,
  products,
  lastScanAt,
}: {
  batchId: string;
  items: FlowItemRow[];
  products: FlowItemsTabProduct[];
  lastScanAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Drag-and-drop state. The actively-dragged tile's id is set on
  // dragstart and cleared on dragend; product-row drop targets
  // read it from React state instead of HTML5 dataTransfer
  // (works around browsers that don't expose dataTransfer.types
  // until the drop event fires).
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  // null  → no banner / picker
  // "ignore" → "enter ignore reason" inline picker
  const [ignoring, setIgnoring] = useState<string | null>(null);
  const [ignoreReason, setIgnoreReason] = useState("");

  const unmatched = useMemo(
    () => items.filter((i) => i.bindState === "unbound"),
    [items],
  );
  const bound = useMemo(
    () =>
      items.filter((i) => i.bindState === "bound" || i.bindState === "auto"),
    [items],
  );
  const ignored = useMemo(
    () => items.filter((i) => i.bindState === "ignored"),
    [items],
  );

  function bind(flowItemId: string, productId: string) {
    setError(null);
    const fd = new FormData();
    fd.set("flowItemId", flowItemId);
    fd.set("batchId", batchId);
    fd.set("productId", productId);
    startTransition(async () => {
      const r = await bindFlowItemToProduct(fd);
      if (!r.ok) setError(r.message);
    });
  }

  function unbind(flowItemId: string) {
    setError(null);
    const fd = new FormData();
    fd.set("flowItemId", flowItemId);
    fd.set("batchId", batchId);
    startTransition(async () => {
      const r = await unbindFlowItem(fd);
      if (!r.ok) setError(r.message);
    });
  }

  function ignore(flowItemId: string, reason: string) {
    setError(null);
    const fd = new FormData();
    fd.set("flowItemId", flowItemId);
    fd.set("batchId", batchId);
    fd.set("reason", reason);
    startTransition(async () => {
      const r = await ignoreFlowItem(fd);
      if (!r.ok) setError(r.message);
      else {
        setIgnoring(null);
        setIgnoreReason("");
      }
    });
  }

  function unignore(flowItemId: string) {
    setError(null);
    const fd = new FormData();
    fd.set("flowItemId", flowItemId);
    fd.set("batchId", batchId);
    startTransition(async () => {
      const r = await unignoreFlowItem(fd);
      if (!r.ok) setError(r.message);
    });
  }

  return (
    <section className="space-y-4">
      {/* Header / status row */}
      <div className="panel p-5 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <div className="section-title">Flow reconciliation</div>
            <p className="text-xs text-muted mt-1">
              Match Flow images / videos to products in this batch. Drag
              an unmatched tile onto a product on the right to bind it,
              or onto the Ignore zone to mark it as not relevant. Tiles
              that came from a SaaS-driven generation are pre-bound
              automatically.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1 text-[11px] text-muted shrink-0">
            <span>
              {lastScanAt ? (
                <>Last scan: {new Date(lastScanAt).toLocaleString()}</>
              ) : (
                <span className="text-warn">
                  No Flow scan recorded for this batch yet.
                </span>
              )}
            </span>
            <span className="text-muted2">
              Trigger a scan from the Workbench (Products tab → Generate /
              Scan section).
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          <StatusChip
            label={`${items.length} tiles tracked`}
            variant="muted"
          />
          {unmatched.length > 0 && (
            <StatusChip
              label={`${unmatched.length} unmatched`}
              variant="warn"
            />
          )}
          {bound.length > 0 && (
            <StatusChip
              label={`${bound.length} bound`}
              variant="ok"
            />
          )}
          {ignored.length > 0 && (
            <StatusChip
              label={`${ignored.length} ignored`}
              variant="muted"
            />
          )}
        </div>

        {error && <div className="text-xs text-bad">⚠ {error}</div>}
      </div>

      {items.length === 0 ? (
        <EmptyTab />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-4">
          {/* Left: unmatched tiles grid */}
          <div className="panel p-5 space-y-4">
            <div className="flex items-baseline justify-between">
              <div className="section-title">Unmatched ({unmatched.length})</div>
              {pending && (
                <span className="text-[11px] text-accent">Saving…</span>
              )}
            </div>
            {unmatched.length === 0 ? (
              <div className="text-xs text-muted">
                Nothing unmatched. All scanned tiles are either bound
                to a product or ignored.
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                {unmatched.map((it) => (
                  <TileCard
                    key={it.id}
                    item={it}
                    dragging={draggedId === it.id}
                    onDragStart={() => setDraggedId(it.id)}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setHoverTarget(null);
                    }}
                    onIgnoreClick={() => setIgnoring(it.id)}
                  />
                ))}
              </div>
            )}
            {/* Ignore drop zone — sticky to the bottom of the
                unmatched grid so it's reachable while dragging. */}
            <IgnoreDropZone
              active={draggedId !== null}
              hover={hoverTarget === "__ignore"}
              onDragOver={(e) => {
                e.preventDefault();
                setHoverTarget("__ignore");
              }}
              onDragLeave={() => setHoverTarget(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId) setIgnoring(draggedId);
                setDraggedId(null);
                setHoverTarget(null);
              }}
            />
            {/* Inline ignore-reason picker — slides in when the
                user dropped a tile on the Ignore zone or clicked
                the per-tile Ignore button. */}
            {ignoring && (
              <div className="rounded-xl border border-warn/40 bg-warn/[0.06] p-3 space-y-2">
                <div className="text-xs text-warn font-medium">
                  Ignore this tile?
                </div>
                <input
                  type="text"
                  className="field text-xs"
                  placeholder="Reason (optional, e.g. 'not from this batch')"
                  value={ignoreReason}
                  onChange={(e) => setIgnoreReason(e.target.value)}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-danger text-xs px-3 py-1"
                    onClick={() => ignore(ignoring, ignoreReason)}
                    disabled={pending}
                  >
                    {pending ? "Saving…" : "Confirm ignore"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost text-xs px-3 py-1"
                    onClick={() => {
                      setIgnoring(null);
                      setIgnoreReason("");
                    }}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right: products list (drop targets) */}
          <div className="panel p-5 space-y-2">
            <div className="section-title">
              Bind to product ({products.length})
            </div>
            <p className="text-[11px] text-muted leading-snug">
              Drop a tile onto a product to bind it. The bind is
              reversible — see the Bound section below.
            </p>
            <div className="space-y-1.5 max-h-[36rem] overflow-y-auto pr-1">
              {products.length === 0 ? (
                <div className="text-xs text-muted">No products in this batch yet.</div>
              ) : (
                products.map((p) => (
                  <ProductDropTarget
                    key={p.id}
                    product={p}
                    active={draggedId !== null}
                    hover={hoverTarget === p.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setHoverTarget(p.id);
                    }}
                    onDragLeave={() => {
                      if (hoverTarget === p.id) setHoverTarget(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggedId) bind(draggedId, p.id);
                      setDraggedId(null);
                      setHoverTarget(null);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom: collapsible bound + ignored sections */}
      {bound.length > 0 && (
        <details className="panel p-5">
          <summary className="cursor-pointer text-sm select-none">
            Bound ({bound.length}) — click to expand
          </summary>
          <div className="mt-3 space-y-1.5">
            {bound.map((it) => {
              const product = it.productId
                ? products.find((p) => p.id === it.productId)
                : null;
              return (
                <BoundRow
                  key={it.id}
                  item={it}
                  productName={product?.productName ?? "(unknown product)"}
                  isAuto={it.bindState === "auto"}
                  onUnbind={() => unbind(it.id)}
                  pending={pending}
                />
              );
            })}
          </div>
        </details>
      )}
      {ignored.length > 0 && (
        <details className="panel p-5">
          <summary className="cursor-pointer text-sm select-none">
            Ignored ({ignored.length}) — click to expand
          </summary>
          <div className="mt-3 space-y-1.5">
            {ignored.map((it) => (
              <IgnoredRow
                key={it.id}
                item={it}
                onUnignore={() => unignore(it.id)}
                pending={pending}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function TileCard({
  item,
  dragging,
  onDragStart,
  onDragEnd,
  onIgnoreClick,
}: {
  item: FlowItemRow;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onIgnoreClick: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Some browsers refuse to start a drag without dataTransfer
        // payload; set a no-op string so the drag is allowed.
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "link";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`relative rounded-xl border bg-bg overflow-hidden aspect-square cursor-grab active:cursor-grabbing transition-all ${
        dragging
          ? "border-accent ring-2 ring-accent/40 opacity-60 scale-[0.97]"
          : "border-border hover:border-accent/40"
      }`}
      title={
        item.mediaId
          ? `media_id: ${item.mediaId.slice(0, 12)}…`
          : "Flow tile"
      }
    >
      {item.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.thumbnailUrl}
          alt={item.mediaId ?? "Flow tile"}
          loading="lazy"
          className="w-full h-full object-cover pointer-events-none"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-muted2 text-[10px]">
          no thumbnail
        </div>
      )}
      {item.favorited && (
        <span className="absolute top-1 left-1 text-[10px] px-1.5 rounded-full bg-bg/80 backdrop-blur-sm text-warn font-medium">
          ♥
        </span>
      )}
      {item.kind === "video" && (
        <span className="absolute top-1 right-1 text-[10px] px-1.5 rounded-full bg-bg/80 backdrop-blur-sm text-accent">
          ▶
        </span>
      )}
      <button
        type="button"
        onClick={onIgnoreClick}
        className="absolute bottom-0 left-0 right-0 text-[10px] py-1 bg-bg/85 backdrop-blur-sm text-muted hover:text-bad opacity-0 hover:opacity-100 transition-opacity"
        title="Ignore — mark as not relevant to this batch"
      >
        ignore
      </button>
    </div>
  );
}

function ProductDropTarget({
  product,
  active,
  hover,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  product: FlowItemsTabProduct;
  active: boolean;
  hover: boolean;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`flex items-center gap-2 p-2 rounded-lg border transition-colors text-xs ${
        hover
          ? "border-accent bg-accent/10"
          : active
            ? "border-dashed border-border bg-bg/40 hover:border-accent/50"
            : "border-border"
      }`}
    >
      <div className="w-8 h-8 shrink-0 rounded bg-bg overflow-hidden border border-border">
        {product.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.thumbnailUrl}
            alt={product.productName}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full text-[8px] text-muted2 flex items-center justify-center">
            —
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-text">{product.productName}</div>
        <div className="text-[10px] text-muted">{product.reviewStatus}</div>
      </div>
      {hover && (
        <span className="text-[10px] text-accent shrink-0">drop to bind</span>
      )}
    </div>
  );
}

function IgnoreDropZone({
  active,
  hover,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  active: boolean;
  hover: boolean;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`mt-2 rounded-xl border-2 border-dashed py-3 text-center text-xs transition-colors ${
        hover
          ? "border-bad bg-bad/10 text-bad"
          : active
            ? "border-border bg-bg/40 text-muted"
            : "border-border/30 text-muted2"
      }`}
    >
      {hover
        ? "Drop to ignore"
        : active
          ? "Or drop here to ignore"
          : "Drag a tile here to ignore"}
    </div>
  );
}

function BoundRow({
  item,
  productName,
  isAuto,
  onUnbind,
  pending,
}: {
  item: FlowItemRow;
  productName: string;
  isAuto: boolean;
  onUnbind: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg border border-border bg-bg/30 text-xs">
      <div className="w-10 h-10 shrink-0 rounded bg-bg overflow-hidden border border-border">
        {item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailUrl}
            alt={item.mediaId ?? ""}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full text-[8px] text-muted2 flex items-center justify-center">
            —
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate">
          → <span className="text-text font-medium">{productName}</span>
        </div>
        <div className="text-[10px] text-muted">
          {isAuto ? "auto-bound (from SaaS job)" : "manually bound"} ·{" "}
          {item.mediaId?.slice(0, 12)}…
        </div>
      </div>
      {item.tileHref && (
        <a
          href={item.tileHref}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-accent hover:underline shrink-0"
        >
          open ↗
        </a>
      )}
      <button
        type="button"
        onClick={onUnbind}
        disabled={pending}
        className="text-[10px] text-muted hover:text-bad shrink-0"
        title={
          isAuto
            ? "Detach this auto-binding — useful if the auto-match was wrong"
            : "Unbind from the product"
        }
      >
        unbind
      </button>
    </div>
  );
}

function IgnoredRow({
  item,
  onUnignore,
  pending,
}: {
  item: FlowItemRow;
  onUnignore: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg border border-border bg-bg/30 text-xs opacity-80">
      <div className="w-10 h-10 shrink-0 rounded bg-bg overflow-hidden border border-border">
        {item.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.thumbnailUrl}
            alt={item.mediaId ?? ""}
            className="w-full h-full object-cover grayscale"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full text-[8px] text-muted2 flex items-center justify-center">
            —
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-text truncate">
          {item.mediaId?.slice(0, 24) ?? "—"}
        </div>
        {item.notes && (
          <div className="text-[10px] text-muted italic truncate">
            &ldquo;{item.notes}&rdquo;
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onUnignore}
        disabled={pending}
        className="text-[10px] text-accent hover:underline shrink-0"
      >
        un-ignore
      </button>
    </div>
  );
}

function EmptyTab() {
  return (
    <div className="panel p-8 text-center space-y-2">
      <div className="text-sm text-muted">
        No Flow tiles tracked for this batch yet.
      </div>
      <div className="text-xs text-muted2 leading-relaxed max-w-md mx-auto">
        Once you run a Flow scan (Products tab → Workbench → Scan
        favorited images), the scanned tiles show up here for
        reconciliation. Tiles from a SaaS-driven generation auto-bind
        to their originating product; everything else lands as
        unmatched for manual review.
      </div>
    </div>
  );
}
