"use client";

import { useState, type ReactNode } from "react";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import ProductEditor, { type ProductRow } from "./ProductEditor";
import IpRiskBatchPanel, {
  type IpRiskFilter,
  type IpRiskBatchProduct,
} from "./IpRiskBatchPanel";

/**
 * Phase 9 — Products tab wrapper that ties the IpRiskBatchPanel's
 * filter dropdown to the products grid below it. Both the panel
 * (which owns the filter UI) and the grid (which renders the
 * filtered ProductEditor cards) need to react to the same filter
 * state, so we lift it into this client component.
 *
 * The "readyCount / missingPrompt / missingRef" header chips stay
 * with the parent server component (page.tsx) because those don't
 * depend on the filter — they describe the whole batch.
 */

interface ProductsWithIpRiskProps {
  batchId: string;
  products: ProductRow[];
  /** Rendered above the IpRiskBatchPanel — the Panel header with
   *  the "X ready / Y no prompt" summary chips lives in the parent
   *  page.tsx; we pass it through as a slot. */
  productsPanelAction: ReactNode;
}

function matchesFilter(product: ProductRow, filter: IpRiskFilter): boolean {
  if (filter === "all") return true;
  if (filter === "override_approved") return product.ipRiskOverride;
  return product.ipRiskStatus === filter;
}

export default function ProductsWithIpRisk({
  batchId,
  products,
  productsPanelAction,
}: ProductsWithIpRiskProps) {
  const [filter, setFilter] = useState<IpRiskFilter>("all");

  const filtered = products.filter((p) => matchesFilter(p, filter));

  // Reshape products for the IpRiskBatchPanel — it only needs the
  // status + override + name to drive its summary counts and the
  // batch check progress list.
  const panelProducts: IpRiskBatchProduct[] = products.map((p) => ({
    id:             p.id,
    productName:    p.productName,
    ipRiskStatus:   p.ipRiskStatus,
    ipRiskOverride: p.ipRiskOverride,
  }));

  return (
    <>
      <IpRiskBatchPanel
        batchId={batchId}
        products={panelProducts}
        activeFilter={filter}
        onFilterChange={setFilter}
      />
      <Panel
        title={
          filter === "all"
            ? `Products (${products.length})`
            : `Products (${filtered.length} of ${products.length}) — filtered`
        }
        action={productsPanelAction}
      >
        {filtered.length === 0 ? (
          products.length === 0 ? (
            <EmptyState
              icon="◇"
              title="No products yet"
              hint="Add a product below to give the runner something to work with."
            />
          ) : (
            <EmptyState
              icon="◇"
              title={`No products match filter "${filter}"`}
              hint="Switch the filter back to 'All' to see every product, or re-check IP risk to update statuses."
            />
          )
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {filtered.map((p) => (
              <ProductEditor key={p.id} batchId={batchId} product={p} />
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
