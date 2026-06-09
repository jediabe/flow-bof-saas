/**
 * Phase 10 — empty-batch hero state.
 *
 * Shown by BatchPipeline when the batch has zero non-deleted
 * products. The full-bleed call-to-action ("Import products")
 * deliberately hides all the lane chrome — a fresh batch
 * shouldn't show empty lanes with placeholder text. The user
 * gets one clear path: import or add manually.
 *
 * As soon as the first product exists, this component is no
 * longer rendered and the regular lane view takes over.
 */

// Plain <a> on purpose — these are in-page hash anchors. Using
// next/link for a "#kalodata-importer" target made Next.js try to
// prefetch the RSC at /batches/[id]/kalodata-importer (relative
// path resolution against the current URL), 403ing in prod and
// throwing "unexpected response" in the client router.

export default function EmptyBatchHero({
  batchName,
  importTargetId = "kalodata-importer",
  addTargetId = "add-product",
}: {
  batchName: string;
  importTargetId?: string;
  addTargetId?: string;
}) {
  return (
    <div className="empty-hero">
      <div className="empty-hero-icon" aria-hidden="true">
        ⤵
      </div>
      <h1 className="empty-hero-title">
        {batchName} is empty
      </h1>
      <p className="empty-hero-body">
        Start by importing products from a Kalodata XLSX export.
        Each row becomes a card you can review, generate, and post.
      </p>
      <div className="empty-hero-actions">
        <a
          href={`#${importTargetId}`}
          className="btn btn-primary"
        >
          Import Kalodata .xlsx
        </a>
        <a href={`#${addTargetId}`} className="btn">
          Add a product manually
        </a>
      </div>
    </div>
  );
}
