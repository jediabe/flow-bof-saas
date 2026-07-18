import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import KalodataImportPanel from "./KalodataImportPanel";
import PromptsClient, { type ProductSummary } from "./PromptsClient";

/**
 * Hooks & Prompts — APEX curriculum-aligned hook generator.
 *
 * Reads workspace products (same table image gen writes into),
 * hands the list to the client component. All state (picked
 * product, discount %, campaign hashtag, results) lives on the
 * client; server just prepares the list and provides the
 * generatePromptsPreview action.
 */

export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  const { workspace } = await getCurrentWorkspace();

  const products = await db.product.findMany({
    where: {
      deletedAt: null,
      batch: { workspaceId: workspace.id },
    },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      productName: true,
      originalTitle: true,
      category: true,
      retailerName: true,
      batch: { select: { name: true } },
    },
    // Cap at 200 — the picker is a dropdown; a workspace with more
    // than that many active products should use search-driven UX
    // (follow-up work when the number becomes real).
    take: 200,
  });

  const summaries: ProductSummary[] = products.map((p) => ({
    id: p.id,
    productName: p.productName,
    originalTitle: p.originalTitle ?? null,
    category: p.category ?? null,
    retailerName: p.retailerName ?? null,
    batchName: p.batch?.name ?? "—",
  }));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="h-page">
          Hooks <span className="text-accent">&amp; Prompts</span>
        </h1>
        <p className="text-sm text-muted mt-1">
          One-shot UK hook, caption, and hashtag generation. All seven APEX
          families per product; add today&apos;s discount % to unlock the
          percentage-based variants.
        </p>
      </header>

      <KalodataImportPanel />

      {summaries.length === 0 ? (
        <Panel title="Or pick from existing products" variant="ghost">
          <EmptyState
            icon="◇"
            title="No products yet"
            hint="Import a Kalodata workbook above, or add products through a batch. Hook generation and image gen both read from the same product library."
            action={
              <Link href="/batches" className="btn btn-primary text-xs">
                Go to Batches
              </Link>
            }
          />
        </Panel>
      ) : (
        <PromptsClient products={summaries} />
      )}
    </div>
  );
}
