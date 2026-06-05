"use client";

import { useRef, useState, useTransition } from "react";
import {
  attachProductImageFromBlob,
  removeProductImageByRole,
  promoteProductImageRole,
} from "../actions";

/**
 * Phase 3 — multi-reference image stack on the product card.
 *
 * Renders up to 3 reference image slots (primary / ref2 / ref3).
 * Paste-anywhere + drag/drop are handled by the PARENT product card
 * wrapper (ProductEditor) so the user can paste regardless of which
 * child of the card has focus. This component only owns:
 *   - the slot visuals (thumbnail + ★/role badge)
 *   - per-slot click-to-pick (file browser fallback)
 *   - per-slot hover controls (remove / promote)
 *
 * Server interaction is via Server Actions (remove / promote +
 * attach via the file picker) — no fetch, no API route. Path
 * revalidation on the server keeps the parent page's product list in
 * sync.
 */
export interface ProductImageRow {
  id: string;
  /** "primary" | "ref2" | "ref3" */
  role: "primary" | "ref2" | "ref3";
  url: string | null;
  source: string;
}

const ROLES: Array<"primary" | "ref2" | "ref3"> = ["primary", "ref2", "ref3"];

export default function ProductImageStack({
  productId,
  batchId,
  images,
  /** Visual size of each slot. The card uses 56px to match the existing
   *  thumbnail; the mobile review page can pass a smaller value. */
  slotSize = 56,
}: {
  productId: string;
  batchId: string;
  images: ProductImageRow[];
  slotSize?: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);

  // Build a Map<role, ProductImageRow> for fast lookup. Roles that
  // aren't populated render as empty slots.
  const byRole = new Map(images.map((i) => [i.role, i]));

  function attach(blob: Blob, source: "paste" | "upload") {
    setError(null);
    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("batchId", batchId);
    fd.set("role", "auto");
    fd.set("source", source);
    fd.set("image", blob);
    startTransition(async () => {
      const r = await attachProductImageFromBlob(fd);
      if (!r.ok) setError(r.message);
    });
  }

  function remove(role: "primary" | "ref2" | "ref3") {
    setError(null);
    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("batchId", batchId);
    fd.set("role", role);
    startTransition(async () => {
      const r = await removeProductImageByRole(fd);
      if (!r.ok) setError(r.message);
    });
  }

  function promote(role: "primary" | "ref2" | "ref3") {
    setError(null);
    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("batchId", batchId);
    fd.set("role", role);
    startTransition(async () => {
      const r = await promoteProductImageRole(fd);
      if (!r.ok) setError(r.message);
    });
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) attach(file, "upload");
    // Reset the input so the same file can be picked again later.
    e.target.value = "";
  }

  return (
    <div
      className={`flex flex-col gap-1.5 ${pending ? "opacity-60" : ""}`}
    >
      {ROLES.map((role) => {
        const img = byRole.get(role);
        return (
          <Slot
            key={role}
            role={role}
            image={img}
            size={slotSize}
            pending={pending}
            onPickClick={() => pickerRef.current?.click()}
            onRemove={() => remove(role)}
            onPromote={() => promote(role)}
          />
        );
      })}
      <input
        ref={pickerRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
      />
      {error && (
        <div className="text-[10px] text-bad leading-tight px-1">⚠ {error}</div>
      )}
    </div>
  );
}

/**
 * Single image slot — either populated (shows the thumbnail + hover
 * controls) or empty (shows a faint "+" the user can click to open
 * the file picker). The primary slot has a small "★" indicator in
 * the top-left corner so the user can tell at a glance which image
 * is the hero.
 */
function Slot({
  role,
  image,
  size,
  pending,
  onPickClick,
  onRemove,
  onPromote,
}: {
  role: "primary" | "ref2" | "ref3";
  image: ProductImageRow | undefined;
  size: number;
  pending: boolean;
  onPickClick: () => void;
  onRemove: () => void;
  onPromote: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const [hovering, setHovering] = useState(false);

  if (!image) {
    // Empty slot — placeholder + click-to-pick. Only the primary
    // slot is "demanding"; ref2/ref3 are subtler so they don't
    // visually clutter a card the user hasn't decided to enrich yet.
    const isPrimary = role === "primary";
    return (
      <button
        type="button"
        onClick={onPickClick}
        disabled={pending}
        style={{ width: size, height: size }}
        className={`shrink-0 rounded-xl border ${
          isPrimary
            ? "border-dashed border-border bg-bg/40 text-muted hover:border-accent/50 hover:text-accent"
            : "border-border/40 bg-bg/20 text-muted2 hover:border-border hover:text-muted"
        } flex flex-col items-center justify-center text-[9px] leading-tight transition-colors disabled:opacity-40`}
        title={`Add ${role} reference image`}
      >
        <span className="text-base">+</span>
        <span className="uppercase tracking-wider">{role}</span>
      </button>
    );
  }

  const url = image.url;
  const showImg = !!url && !broken;
  return (
    <div
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{ width: size, height: size }}
      className="relative shrink-0 rounded-xl border border-border bg-bg overflow-hidden group"
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url!}
          alt={`${role} reference`}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center text-muted2 text-[10px] text-center px-1"
          title={broken ? "Image failed to load" : "No image"}
        >
          {broken ? "load\nfailed" : "no\nimage"}
        </div>
      )}
      {/* Top-left badge: ★ for primary, role label for refs. */}
      <div className="absolute top-0.5 left-0.5 px-1 rounded-md bg-bg/80 backdrop-blur-sm text-[8px] text-text font-medium uppercase tracking-wider pointer-events-none">
        {role === "primary" ? "★" : role}
      </div>
      {/* Hover controls. Show only when hovering OR when the slot
          is in a focused card (parent supplies focus state via CSS
          via group-focus-within, but we keep hover-only here to
          avoid noise on cards with no interaction). */}
      {hovering && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg/85 backdrop-blur-sm text-[9px]">
          {role !== "primary" && (
            <button
              type="button"
              onClick={onPromote}
              disabled={pending}
              className="px-1.5 py-0.5 rounded-md bg-accent/15 text-accent border border-accent/40 hover:bg-accent/25 disabled:opacity-40"
              title="Make this the primary reference image"
            >
              ★ primary
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            disabled={pending}
            className="px-1.5 py-0.5 rounded-md bg-bad/15 text-bad border border-bad/40 hover:bg-bad/25 disabled:opacity-40"
            title="Remove this reference image"
          >
            remove
          </button>
        </div>
      )}
    </div>
  );
}
