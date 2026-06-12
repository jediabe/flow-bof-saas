"use client";

/**
 * Phase 10/11 — empty-batch hero state.
 *
 * Shown by BatchPageClient when the batch has zero non-deleted
 * products. The full-bleed call-to-action ("Import products")
 * deliberately hides all the lane chrome — a fresh batch
 * shouldn't show empty lanes with placeholder text. The user
 * gets one clear path: open the add-products sheet.
 *
 * As soon as the first product exists, this component is no
 * longer rendered and the regular lane view takes over.
 */

export default function EmptyBatchHero({
  batchName,
  onAddProducts,
}: {
  batchName: string;
  /** Open the "Add products" action sheet (Kalodata import +
   *  manual-add form). Wired by BatchPageClient. */
  onAddProducts?: () => void;
}) {
  return (
    <div className="empty-hero">
      <div className="empty-hero-icon" aria-hidden="true">
        ⤵
      </div>
      <h1 className="empty-hero-title">{batchName} is empty</h1>
      <p className="empty-hero-body">
        Start by importing products from a Kalodata XLSX export.
        Each row becomes a card you can review, generate, and post.
      </p>
      <div className="empty-hero-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onAddProducts}
          disabled={!onAddProducts}
        >
          + Add products
        </button>
      </div>
    </div>
  );
}
