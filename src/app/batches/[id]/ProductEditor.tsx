"use client";

import { useEffect, useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import {
  UK_RETAILER_FALLBACK,
  UK_RETAILERS,
  buildUkStorePrompt,
  findRetailer,
} from "@/lib/uk-retailers";
import {
  updateProduct,
  deleteProduct,
  restoreProduct,
  setProductReviewStatus,
  attachProductImageFromBlob,
  generateAiPromptForProduct,
} from "../actions";
import ProductImageStack, {
  type ProductImageRow,
} from "./ProductImageStack";

export interface ProductRow {
  id: string;
  productName: string;
  originalTitle: string | null;
  tiktokUrl: string | null;
  category: string | null;
  retailerName: string | null;
  imageUrl: string | null;
  referenceImageUrl: string | null;
  referenceImagePathLocal: string | null;
  imagePrompt: string | null;
  hook: string | null;
  caption: string | null;
  hashtags: string[];
  aiPromptError: string | null;
  aiPromptGeneratedAt: string | null;
  submittedStatus: SubmittedStatus | null;
  /** Phase-1 review-status workflow. Drives the badge on the product
   *  card and the eligibility filter in GenerateImagesPanel.
   *  Values: "needs_review" | "approved" | "rejected" | "maybe". */
  reviewStatus: ReviewStatus;
  /** ISO timestamp when the product was soft-deleted, or null when
   *  active. Soft-deleted products are filtered out of the default
   *  product list (see batches/[id]/page.tsx) — this field only
   *  reaches the editor when the page explicitly fetches deleted
   *  rows (Phase-7 follow-up). */
  deletedAt: string | null;
  /** Phase-3 multi-reference images. Up to 3 rows (primary / ref2 /
   *  ref3). Empty list when the product has no images yet. */
  images: ProductImageRow[];
}

export type ReviewStatus =
  | "needs_review"
  | "approved"
  | "rejected"
  | "maybe";

const REVIEW_STATUS_VARIANT: Record<
  ReviewStatus,
  "ok" | "warn" | "bad" | "muted"
> = {
  needs_review: "warn",
  approved:     "ok",
  rejected:     "bad",
  maybe:        "muted",
};

const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  needs_review: "needs review",
  approved:     "approved",
  rejected:     "rejected",
  maybe:        "maybe",
};

/** Per-product status derived from the latest generate_flow_images job. */
export type SubmittedStatus =
  | "submitted"
  | "failed"
  | "skipped"
  | "pending"
  | "unknown";

const STATUS_VARIANT: Record<SubmittedStatus, "ok" | "warn" | "bad" | "muted"> = {
  submitted: "ok",
  failed:    "bad",
  skipped:   "warn",
  pending:   "muted",
  unknown:   "muted",
};

/**
 * Inline product card with edit-in-place. Shows a thumbnail preview
 * (from referenceImageUrl after Kalodata import), retailer chip,
 * prompt readiness, and submitted status at a glance — the user can
 * scan a batch and immediately see which rows are blocking image
 * generation.
 *
 * The local reference image path field is intentionally pushed under
 * an "Advanced override" disclosure: the Kalodata import flow handles
 * the reference URL automatically, and surfacing the path field at the
 * top tempts users to hand-edit it for the wrong reason.
 */
export default function ProductEditor({
  batchId,
  product,
}: {
  batchId: string;
  product: ProductRow;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  // Card-level paste/drop state. Lives at the card level (not on the
  // ProductImageStack) so a paste fires regardless of which child has
  // focus — clicking the text area or chevron also unlocks pasting.
  // Without this, the user had to specifically click the image stack
  // first, which wasn't discoverable.
  const [pasteBusy, startPasteTransition] = useTransition();
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function attachBlob(blob: Blob, source: "paste" | "upload") {
    setPasteError(null);
    const fd = new FormData();
    fd.set("productId", product.id);
    fd.set("batchId", batchId);
    fd.set("role", "auto");
    fd.set("source", source);
    fd.set("image", blob);
    startPasteTransition(async () => {
      const r = await attachProductImageFromBlob(fd);
      if (!r.ok) setPasteError(r.message);
    });
  }

  function onCardPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!e.clipboardData) return;
    // Walk the clipboard items; first image-typed file wins. Text
    // pastes (URL, filename, etc.) are intentionally ignored — they
    // pass through to whichever input the user has focused. That
    // means pasting text INTO the prompt textarea still works.
    for (const item of e.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          attachBlob(file, "paste");
          return;
        }
      }
    }
  }

  function onCardDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      attachBlob(file, "upload");
    } else if (file) {
      setPasteError(`Not an image: ${file.type || "unknown type"}`);
    }
  }

  function onCardDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  const [draft, setDraft] = useState({
    productName:             product.productName,
    originalTitle:           product.originalTitle ?? "",
    tiktokUrl:               product.tiktokUrl ?? "",
    category:                product.category ?? "",
    retailerName:            product.retailerName ?? UK_RETAILER_FALLBACK,
    referenceImagePathLocal: product.referenceImagePathLocal ?? "",
    imagePrompt:             product.imagePrompt ?? "",
  });

  // Sync the local draft when the underlying product changes
  // externally (a server action ran — e.g. the bulk
  // 'Generate AI prompts' button populated imagePrompt /
  // retailerName from the AI provider). Without this, the local
  // useState initialiser only fires on first mount, so an editor
  // that was opened before the action ran would still show the
  // pre-action draft state — looks like the AI did nothing even
  // though the DB has the new prompt.
  //
  // Effect runs whenever any of the AI-populated fields change.
  // Doesn't touch fields the user might be mid-editing (product
  // name, category, etc.) unless those changed server-side too.
  useEffect(() => {
    setDraft((d) => ({
      ...d,
      productName:    product.productName,
      originalTitle:  product.originalTitle ?? "",
      tiktokUrl:      product.tiktokUrl ?? "",
      category:       product.category ?? "",
      retailerName:   product.retailerName ?? UK_RETAILER_FALLBACK,
      imagePrompt:    product.imagePrompt ?? "",
    }));
    // Intentionally NOT including the setter — React state setters
    // are stable. The eslint exhaustive-deps lint won't fire on
    // these.
  }, [
    product.productName,
    product.originalTitle,
    product.tiktokUrl,
    product.category,
    product.retailerName,
    product.imagePrompt,
  ]);

  // "Ready" = the runner has *something* to send: either a SaaS-hosted
  // reference URL or a local override path, plus a prompt. The video
  // / dispatch layers do the final check.
  const hasReference =
    !!product.referenceImageUrl || !!product.referenceImagePathLocal;
  const ready = hasReference && !!product.imagePrompt;
  const missingPrompt = !product.imagePrompt;
  const missingRef = !hasReference;

  const retailerLabel = findRetailer(product.retailerName).label;

  function fillUkPrompt() {
    setDraft((d) => ({ ...d, imagePrompt: buildUkStorePrompt(d.retailerName) }));
  }

  function save() {
    const fd = new FormData();
    fd.set("id", product.id);
    fd.set("batchId", batchId);
    fd.set("productName", draft.productName);
    fd.set("originalTitle", draft.originalTitle);
    fd.set("tiktokUrl", draft.tiktokUrl);
    fd.set("category", draft.category);
    fd.set(
      "retailerName",
      draft.retailerName === UK_RETAILER_FALLBACK ? "" : draft.retailerName,
    );
    fd.set("referenceImagePathLocal", draft.referenceImagePathLocal);
    fd.set("imagePrompt", draft.imagePrompt);
    startTransition(async () => {
      await updateProduct(fd);
      setExpanded(false);
    });
  }

  function remove() {
    const fd = new FormData();
    fd.set("id", product.id);
    fd.set("batchId", batchId);
    startTransition(async () => {
      await deleteProduct(fd);
    });
  }

  function restore() {
    const fd = new FormData();
    fd.set("id", product.id);
    fd.set("batchId", batchId);
    startTransition(async () => {
      await restoreProduct(fd);
    });
  }

  function setStatus(status: ReviewStatus) {
    const fd = new FormData();
    fd.set("id", product.id);
    fd.set("batchId", batchId);
    fd.set("status", status);
    startTransition(async () => {
      await setProductReviewStatus(fd);
    });
  }

  // Phase-3: per-product AI regenerate. Independent transition from
  // the rest so the rest of the editor stays interactive while this
  // call is in flight (AI calls can take 5-20s).
  const [aiBusy, startAiTransition] = useTransition();
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiOk, setAiOk] = useState<string | null>(null);

  function regenerateAi() {
    setAiError(null);
    setAiOk(null);
    startAiTransition(async () => {
      const r = await generateAiPromptForProduct({
        batchId,
        productId: product.id,
        force: true,
      });
      if (r.ok) {
        setAiOk(r.message);
        // Briefly show "generated" then clear so the chip on the
        // header (which now reflects the fresh aiPromptGeneratedAt)
        // becomes the durable indicator.
        setTimeout(() => setAiOk(null), 2500);
      } else {
        setAiError(r.message);
      }
    });
  }

  return (
    <div
      tabIndex={0}
      onPaste={onCardPaste}
      onDrop={onCardDrop}
      onDragOver={onCardDragOver}
      onDragLeave={() => setDragOver(false)}
      className={`rounded-2xl border bg-panel2 overflow-hidden transition-colors outline-none ${
        dragOver
          ? "border-accent ring-2 ring-accent/40"
          : expanded
            ? "border-accent/50"
            : "border-border focus-within:border-accent/30"
      } ${pasteBusy ? "opacity-70" : ""}`}
      // The whole card is focusable so a click anywhere unlocks
      // Ctrl-V. Without tabIndex the paste event has nothing to fire
      // on for clicks outside child buttons. Visual feedback comes
      // from focus-within on the border.
    >
      {/* Image stack + summary header. NOT wrapped in a <button>
          because the stack has its own interactive controls (remove /
          promote / paste). Instead, the text area is the toggle and
          the chevron button on the right is a secondary affordance. */}
      <div className="flex gap-3 p-3 group">
        <ProductImageStack
          productId={product.id}
          batchId={batchId}
          images={product.images}
        />
        <button
          type="button"
          className="flex-1 min-w-0 text-left"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <div className="font-medium text-text truncate group-hover:text-accent transition-colors">
            {product.productName}
          </div>
          {product.category && (
            <div className="text-[11px] text-muted mt-0.5 truncate">
              {product.category}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusChip
              label={REVIEW_STATUS_LABEL[product.reviewStatus]}
              variant={REVIEW_STATUS_VARIANT[product.reviewStatus]}
            />
            {product.submittedStatus &&
              product.submittedStatus !== "unknown" && (
                <StatusChip
                  label={product.submittedStatus}
                  variant={STATUS_VARIANT[product.submittedStatus]}
                />
              )}
            {ready ? (
              <StatusChip label="ready" variant="ok" />
            ) : (
              <>
                {missingPrompt && (
                  <StatusChip label="no prompt" variant="warn" />
                )}
                {missingRef && (
                  <StatusChip label="no reference" variant="warn" />
                )}
              </>
            )}
            <StatusChip label={retailerLabel} variant="muted" />
            {product.aiPromptGeneratedAt && (
              <StatusChip label="AI prompt" variant="accent" />
            )}
            {product.aiPromptError && (
              <StatusChip label="AI error" variant="bad" />
            )}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-muted2 self-start mt-1 select-none hover:text-text transition-colors"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▲" : "▼"}
        </button>
      </div>

      {/* Card-level paste feedback. Only renders when there's an
          error or active upload so it doesn't add noise to idle
          cards. The image-stack itself shows pending opacity for
          slot-level actions; this row is for the paste/drop path. */}
      {(pasteBusy || pasteError) && (
        <div className="px-3 pb-2 -mt-1 text-[10px] leading-tight">
          {pasteBusy && (
            <span className="text-accent">Uploading pasted image…</span>
          )}
          {pasteError && (
            <span className="text-bad">⚠ {pasteError}</span>
          )}
        </div>
      )}

      {/* Expanded editor --------------------------------------------- */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-border pt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Product name">
              <input
                className="field"
                value={draft.productName}
                onChange={(e) =>
                  setDraft({ ...draft, productName: e.target.value })
                }
              />
            </Field>
            <Field label="Original title">
              <input
                className="field"
                value={draft.originalTitle}
                onChange={(e) =>
                  setDraft({ ...draft, originalTitle: e.target.value })
                }
              />
            </Field>
            <Field label="Category">
              <input
                className="field"
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value })
                }
              />
            </Field>
            <Field label="TikTok URL">
              <input
                className="field"
                value={draft.tiktokUrl}
                onChange={(e) =>
                  setDraft({ ...draft, tiktokUrl: e.target.value })
                }
              />
            </Field>
            <Field label="Retailer / store">
              <select
                className="field"
                value={draft.retailerName}
                onChange={(e) =>
                  setDraft({ ...draft, retailerName: e.target.value })
                }
              >
                {UK_RETAILERS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reference images">
              <div className="text-[12px] text-muted leading-snug px-1 py-2">
                Managed via the image stack on the left. Paste an image
                directly onto this card (Ctrl-V), drop a file, or click
                an empty slot to add up to 3 references.
                {product.images.length > 0 && (
                  <span className="text-text">
                    {" "}{product.images.length} attached.
                  </span>
                )}
              </div>
            </Field>
          </div>

          <Field
            label="Image prompt"
            action={
              <div className="flex items-center gap-2">
                {aiOk && (
                  <span className="text-[10px] text-ok">✓ {aiOk}</span>
                )}
                {aiError && (
                  <span className="text-[10px] text-bad max-w-[14rem] truncate" title={aiError}>
                    ⚠ {aiError}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-ghost text-[11px] px-2 py-1"
                  onClick={regenerateAi}
                  disabled={aiBusy || pending}
                  title="Re-run the AI provider on just this product. Overwrites the existing prompt + hook + caption + hashtags."
                >
                  {aiBusy ? "Regenerating…" : "↻ Regenerate AI"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost text-[11px] px-2 py-1"
                  onClick={fillUkPrompt}
                >
                  Build UK store prompt
                </button>
              </div>
            }
          >
            <textarea
              className="field"
              rows={6}
              value={draft.imagePrompt}
              onChange={(e) =>
                setDraft({ ...draft, imagePrompt: e.target.value })
              }
            />
          </Field>

          {/* AI-generated supporting copy — read-only here; the bulk
              AiPromptsPanel above is the one place that writes these
              fields, by design. */}
          {(product.hook ||
            product.caption ||
            product.hashtags.length > 0 ||
            product.aiPromptError) && (
            <section className="rounded-xl border border-border bg-bg/40 p-3 space-y-2 text-xs">
              <div className="flex items-baseline justify-between">
                <span className="label">AI generated</span>
                {product.aiPromptGeneratedAt && (
                  <span className="text-[10px] text-muted">
                    {new Date(product.aiPromptGeneratedAt).toLocaleString()}
                  </span>
                )}
              </div>
              {product.aiPromptError && (
                <div className="text-bad">{product.aiPromptError}</div>
              )}
              {product.hook && (
                <div>
                  <span className="text-muted">hook:</span>{" "}
                  <span className="text-text">{product.hook}</span>
                </div>
              )}
              {product.caption && (
                <div>
                  <span className="text-muted">caption:</span>{" "}
                  <span className="text-text">{product.caption}</span>
                </div>
              )}
              {product.hashtags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {product.hashtags.map((h, i) => (
                    <span key={i} className="chip">
                      {h}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted hover:text-text transition-colors select-none">
              Advanced override
            </summary>
            <div className="mt-2 space-y-1">
              <label className="block">
                <span className="label">Local reference image path</span>
                <input
                  className="field mt-1"
                  placeholder="inputs/reference_images/01_primary.jpg"
                  value={draft.referenceImagePathLocal}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      referenceImagePathLocal: e.target.value,
                    })
                  }
                />
                <div className="text-[11px] text-muted mt-1">
                  Debug/fallback only. Used when the runner is on the
                  same machine as a reference image you'd rather pass
                  by path. Normal workflow goes through the
                  Kalodata-imported reference URL.
                </div>
              </label>
            </div>
          </details>

          {/* Review-status row — quick triage without opening every
              product. Active status renders highlighted; the rest
              click to transition. The Reset link returns the row to
              "needs_review" so it shows up again in the next pass. */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/40">
            <span className="text-[11px] text-muted mr-1">Review:</span>
            <ReviewBtn
              label="Approve"
              variant="ok"
              active={product.reviewStatus === "approved"}
              disabled={pending}
              onClick={() => setStatus("approved")}
            />
            <ReviewBtn
              label="Maybe"
              variant="muted"
              active={product.reviewStatus === "maybe"}
              disabled={pending}
              onClick={() => setStatus("maybe")}
            />
            <ReviewBtn
              label="Reject"
              variant="bad"
              active={product.reviewStatus === "rejected"}
              disabled={pending}
              onClick={() => setStatus("rejected")}
            />
            {product.reviewStatus !== "needs_review" && (
              <button
                type="button"
                className="text-[11px] text-muted hover:text-text underline-offset-2 hover:underline"
                onClick={() => setStatus("needs_review")}
                disabled={pending}
              >
                Reset to needs_review
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={pending}
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setExpanded(false)}
              disabled={pending}
            >
              Cancel
            </button>
            {product.deletedAt ? (
              <button
                type="button"
                className="btn btn-ghost ml-auto"
                onClick={restore}
                disabled={pending}
                title="Undo the soft-delete; product becomes visible again."
              >
                Restore
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-danger ml-auto"
                onClick={remove}
                disabled={pending}
                title="Soft-delete — hides the product from default views and from generation eligibility. Reversible from the Phase-7 deleted-products view."
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        {action}
      </div>
      <div className="mt-1">{children}</div>
    </label>
  );
}

/**
 * Compact review-status button. Renders pill-shaped, highlights when
 * the underlying product is already in that status (so clicking it
 * again is a no-op — visual feedback only). Hand-rolled instead of
 * using the existing btn-* classes because the row has three of
 * these next to each other and the standard sizing is too chunky.
 */
function ReviewBtn({
  label,
  variant,
  active,
  disabled,
  onClick,
}: {
  label: string;
  variant: "ok" | "warn" | "bad" | "muted";
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  // Map our 4 variant tokens to concrete tailwind colours. Matching
  // the existing StatusChip variants keeps the palette consistent.
  const palette: Record<typeof variant, { bg: string; text: string; border: string }> = {
    ok:    { bg: "bg-ok/15",    text: "text-ok",    border: "border-ok/40" },
    warn:  { bg: "bg-warn/15",  text: "text-warn",  border: "border-warn/40" },
    bad:   { bg: "bg-bad/15",   text: "text-bad",   border: "border-bad/40" },
    muted: { bg: "bg-bg/40",    text: "text-muted", border: "border-border" },
  };
  const p = palette[variant];
  const activeClasses = active
    ? `${p.bg} ${p.text} ${p.border} border-2 font-medium`
    : `${p.text} border-border hover:${p.bg}`;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-xs px-3 py-1 rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${activeClasses}`}
    >
      {label}
    </button>
  );
}
