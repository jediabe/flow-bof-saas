"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import StatusChip from "@/components/StatusChip";
import ProductImageStack, {
  type ProductImageRow,
} from "../ProductImageStack";
import IpRiskRow, {
  type IpRiskRowProduct,
} from "../IpRiskRow";
import {
  updateProduct,
  deleteProduct,
  setProductReviewStatus,
  generateAiPromptForProduct,
  attachProductImageFromBlob,
  generateImagesForOneProduct,
} from "../../actions";
import type { Stage } from "@/lib/batch-stages";

/**
 * Phase 10 — expanded pipeline card.
 *
 * Inline expansion below the compact PipelineCard. Renders the
 * full product edit surface: reference images, AI-generated
 * copy preview, IP risk, action buttons to advance / regenerate /
 * send back. Doesn't try to be visually identical to the old
 * ProductEditor — the new layout is tighter and more
 * pipeline-aware.
 *
 * The expanded card stays focused: low-frequency edits (product
 * name, TikTok URL, original title) live behind an "Edit details"
 * disclosure so the primary surface is "look at the AI output,
 * pick / regenerate / advance."
 *
 * Server actions called here are workspace-scoped via batchId
 * exactly like in the legacy ProductEditor — same auth model.
 */

export interface ExpandedCardProduct {
  id: string;
  productName: string;
  originalTitle: string | null;
  tiktokUrl: string | null;
  category: string | null;
  retailerName: string | null;
  referenceImagePathLocal: string | null;
  imagePrompt: string | null;
  hook: string | null;
  hookVariants: Array<{
    label: string;
    text: string;
    leverName?: string;
  }>;
  caption: string | null;
  hashtags: string[];
  productDescription: string | null;
  aiPromptError: string | null;
  aiPromptGeneratedAt: string | null;
  reviewStatus: "needs_review" | "approved" | "rejected" | "maybe";
  postingStatus: "needs_posting" | "posted" | "skipped";
  images: ProductImageRow[];
  // IP risk fields
  ipRiskStatus:
    | "unchecked"
    | "low"
    | "medium"
    | "high"
    | "needs_manual_review";
  ipRiskReasons: string[];
  ipRiskCheckedAt: string | null;
  ipRiskOverride: boolean;
  ipRiskOverrideReason: string | null;
  ipRiskOverrideAt: string | null;
}

export default function ExpandedPipelineCard({
  product,
  batchId,
  stage,
  onClose,
  ipRiskChecksEnabled = true,
}: {
  product: ExpandedCardProduct;
  batchId: string;
  stage: Stage;
  onClose: () => void;
  /** Workspace-level IP risk toggle. When false, the IP risk row
   *  is hidden entirely so the user isn't reminded of a feature
   *  they've opted out of. Defaults to true for back-compat. */
  ipRiskChecksEnabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [aiVision, setAiVision] = useState(false);
  const [hookIndex, setHookIndex] = useState(0);
  const [draft, setDraft] = useState({
    productName:   product.productName,
    tiktokUrl:     product.tiktokUrl ?? "",
    category:      product.category ?? "",
    originalTitle: product.originalTitle ?? "",
    imagePrompt:   product.imagePrompt ?? "",
  });

  // Keep draft in sync when the parent passes a fresher product
  // (e.g. after an AI regenerate populates the prompt field).
  useEffect(() => {
    setDraft((d) => ({
      ...d,
      productName:   product.productName,
      tiktokUrl:     product.tiktokUrl ?? "",
      category:      product.category ?? "",
      originalTitle: product.originalTitle ?? "",
      imagePrompt:   product.imagePrompt ?? "",
    }));
  }, [
    product.productName,
    product.tiktokUrl,
    product.category,
    product.originalTitle,
    product.imagePrompt,
  ]);

  // Card-level paste/drop for adding reference images — same UX
  // as the legacy ProductEditor.
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
  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!e.clipboardData) return;
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
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      attachBlob(file, "upload");
    }
  }
  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  function regenerateAi() {
    setError(null);
    startTransition(async () => {
      const r = await generateAiPromptForProduct({
        batchId,
        productId: product.id,
        force: true,
        useVision: aiVision,
      });
      if (!r.ok) setError(r.message);
      router.refresh();
    });
  }

  function generateImage() {
    // Single-product image-gen dispatch. Goes through the same
    // createSampleJob path as the bulk panel, so the workspace's
    // cooldown + daily-cap gates apply identically — no back door
    // around the anti-block protections.
    setError(null);
    startTransition(async () => {
      const r = await generateImagesForOneProduct({
        batchId,
        productId: product.id,
      });
      if (!r.ok) setError(r.message);
      router.refresh();
    });
  }

  function saveDetails() {
    setError(null);
    const fd = new FormData();
    fd.set("id", product.id);
    fd.set("batchId", batchId);
    fd.set("productName", draft.productName);
    fd.set("originalTitle", draft.originalTitle);
    fd.set("tiktokUrl", draft.tiktokUrl);
    fd.set("category", draft.category);
    fd.set("imagePrompt", draft.imagePrompt);
    startTransition(async () => {
      await updateProduct(fd);
      setShowDetails(false);
      router.refresh();
    });
  }

  function setReview(status: "needs_review" | "approved" | "rejected" | "maybe") {
    const fd = new FormData();
    fd.set("id", product.id);
    fd.set("batchId", batchId);
    fd.set("status", status);
    startTransition(async () => {
      await setProductReviewStatus(fd);
      router.refresh();
    });
  }

  function softDelete() {
    if (
      !window.confirm(
        `Delete "${product.productName}"? You can restore it from the deleted-products view.`,
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.set("id", product.id);
    fd.set("batchId", batchId);
    startTransition(async () => {
      await deleteProduct(fd);
      onClose();
      router.refresh();
    });
  }

  const ipRiskRowProduct: IpRiskRowProduct = {
    id:                    product.id,
    batchId,
    ipRiskStatus:          product.ipRiskStatus,
    ipRiskReasons:         product.ipRiskReasons,
    ipRiskCheckedAt:       product.ipRiskCheckedAt,
    ipRiskOverride:        product.ipRiskOverride,
    ipRiskOverrideReason:  product.ipRiskOverrideReason,
    ipRiskOverrideAt:      product.ipRiskOverrideAt,
  };

  const currentVariant =
    product.hookVariants.length > 0
      ? product.hookVariants[hookIndex % product.hookVariants.length]
      : null;

  return (
    <div
      tabIndex={0}
      onPaste={onPaste}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      className={`outline-none space-y-4 ${
        dragOver ? "ring-2 ring-accent rounded-xl" : ""
      } ${pasteBusy ? "opacity-70" : ""}`}
    >
      {/* Header row — collapse button on the right */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-base font-medium text-text leading-tight break-words [overflow-wrap:anywhere]">
            {product.productName}
          </div>
          <div className="text-[11px] text-muted mt-0.5 truncate">
            {[product.category, product.retailerName].filter(Boolean).join(" · ")}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn btn-ghost text-xs px-2 py-1 shrink-0"
          title="Collapse this card"
        >
          ▲ Collapse
        </button>
      </div>

      {/* Reference images */}
      <section>
        <div className="label mb-1.5">Reference images</div>
        <ProductImageStack
          productId={product.id}
          batchId={batchId}
          images={product.images}
        />
        <div className="text-[11px] text-muted2 mt-1.5">
          Paste an image (Ctrl/Cmd-V) anywhere on this card, drop a file,
          or click an empty slot.
        </div>
        {pasteError && (
          <div className="text-[11px] text-bad mt-1">⚠ {pasteError}</div>
        )}
      </section>

      {/* Hook variants — read-only carousel */}
      {(product.hookVariants.length > 0 || product.hook) && (
        <section>
          <div className="label mb-1.5">
            Hooks
            {product.hookVariants.length > 0 && (
              <span className="text-muted2 ml-1.5">
                ({hookIndex + 1} of {product.hookVariants.length})
              </span>
            )}
          </div>
          {currentVariant ? (
            <>
              <div className="rounded-lg border border-border bg-bg/40 p-3 text-sm whitespace-pre-line leading-snug">
                {currentVariant.text}
              </div>
              <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted">
                <span className="font-mono uppercase tracking-wider">
                  {currentVariant.label}
                </span>
                {currentVariant.leverName && <span>· {currentVariant.leverName}</span>}
                {product.hookVariants.length > 1 && (
                  <button
                    type="button"
                    className="ml-auto text-accent hover:underline"
                    onClick={() =>
                      setHookIndex(
                        (hookIndex + 1) % product.hookVariants.length,
                      )
                    }
                  >
                    Next variant →
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-border bg-bg/40 p-3 text-sm whitespace-pre-line leading-snug">
              {product.hook}
            </div>
          )}
        </section>
      )}

      {/* Caption + hashtags */}
      {(product.caption || product.hashtags.length > 0) && (
        <section className="flex flex-wrap items-baseline gap-2">
          {product.caption && (
            <span className="text-sm text-text">{product.caption}</span>
          )}
          {product.hashtags.map((h, i) => (
            <span key={i} className="chip">
              {h}
            </span>
          ))}
        </section>
      )}

      {/* IP risk row — same component used by the legacy editor.
          Hidden when the workspace has IP risk screening off. */}
      {ipRiskChecksEnabled && <IpRiskRow product={ipRiskRowProduct} />}

      {/* AI prompt / regenerate */}
      <section className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <div className="label">Image prompt</div>
          <div className="flex items-center gap-2">
            <label
              className="inline-flex items-center gap-1 text-[10px] text-muted select-none"
              title="Send the reference image to the AI when regenerating — much more detail-faithful prompts. Costs more per call."
            >
              <input
                type="checkbox"
                checked={aiVision}
                onChange={(e) => setAiVision(e.target.checked)}
                disabled={pending}
                className="accent-accent"
              />
              vision
            </label>
            <button
              type="button"
              className="btn btn-ghost text-[11px] px-2 py-1"
              onClick={regenerateAi}
              disabled={pending}
              title={
                aiVision
                  ? "Re-run AI with the reference image attached"
                  : "Re-run the AI provider on this product (overwrites prompt + hooks + caption + hashtags)"
              }
            >
              {pending ? "Working…" : "↻ Regenerate"}
            </button>
          </div>
        </div>
        {product.imagePrompt ? (
          <div className="rounded-lg border border-border bg-bg/40 p-2.5 text-[12px] text-muted whitespace-pre-wrap leading-snug max-h-32 overflow-y-auto">
            {product.imagePrompt}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-bg/40 p-2.5 text-[12px] text-muted2 italic">
            No prompt generated yet. Click Regenerate to create one.
          </div>
        )}
        {product.aiPromptError && (
          <div className="text-[11px] text-bad">⚠ {product.aiPromptError}</div>
        )}
      </section>

      {/* Action row */}
      <section className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
        {stage === "needs_review" && (
          <>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={() => setReview("approved")}
              disabled={pending}
            >
              ✓ Approve
            </button>
            <button
              type="button"
              className="btn text-xs"
              onClick={() => setReview("maybe")}
              disabled={pending}
            >
              Maybe
            </button>
            <button
              type="button"
              className="btn btn-danger text-xs"
              onClick={() => setReview("rejected")}
              disabled={pending}
            >
              ✗ Reject
            </button>
          </>
        )}
        {stage === "ready" && (
          <>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={generateImage}
              disabled={pending}
              title="Dispatch image generation for THIS product only. Same cooldown / daily-cap rules apply as the bulk panel."
            >
              ⚡ Generate image
            </button>
            <button
              type="button"
              className="btn text-xs"
              onClick={() => setReview("needs_review")}
              disabled={pending}
              title="Send this product back to Needs review"
            >
              ← Back to review
            </button>
          </>
        )}
        {stage === "generated" && (
          <button
            type="button"
            className="btn text-xs"
            onClick={generateImage}
            disabled={pending}
            title="Re-run image generation for this product. Useful when the previous result wasn't what you wanted."
          >
            ⟲ Re-generate image
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost text-xs ml-auto"
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "Hide details ▲" : "Edit details ▼"}
        </button>
        <button
          type="button"
          className="btn btn-danger text-xs"
          onClick={softDelete}
          disabled={pending}
          title="Soft-delete (reversible)"
        >
          Delete
        </button>
      </section>

      {/* Details disclosure — low-frequency edit fields */}
      {showDetails && (
        <section className="space-y-2 pt-2 border-t border-border/50">
          <DetailField
            label="Product name"
            value={draft.productName}
            onChange={(v) => setDraft((d) => ({ ...d, productName: v }))}
          />
          <DetailField
            label="Original title"
            value={draft.originalTitle}
            onChange={(v) => setDraft((d) => ({ ...d, originalTitle: v }))}
          />
          <DetailField
            label="Category"
            value={draft.category}
            onChange={(v) => setDraft((d) => ({ ...d, category: v }))}
          />
          <DetailField
            label="TikTok URL"
            value={draft.tiktokUrl}
            onChange={(v) => setDraft((d) => ({ ...d, tiktokUrl: v }))}
          />
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={saveDetails}
              disabled={pending}
            >
              {pending ? "Saving…" : "Save details"}
            </button>
            <button
              type="button"
              className="btn btn-ghost text-xs"
              onClick={() => setShowDetails(false)}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {error && (
        <div className="text-xs text-bad">⚠ {error}</div>
      )}
    </div>
  );
}

function DetailField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="field mt-1 text-[13px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
