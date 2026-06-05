import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import StatusChip from "@/components/StatusChip";
import { createBatch } from "./actions";

export const dynamic = "force-dynamic";

export default async function BatchesPage() {
  const { workspace } = await getCurrentWorkspace();
  const batches = await db.batch.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { products: true, jobs: true } } },
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h-page">Batches</h1>
        <p className="text-sm text-muted mt-1">
          Group products through the image → favorite → video pipeline.
        </p>
      </header>

      <Panel title="Create batch">
        <form action={createBatch} className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[16rem]">
            <label className="label" htmlFor="name">Name</label>
            <input
              className="field"
              id="name"
              name="name"
              placeholder="e.g. June UK skincare"
              required
            />
          </div>
          <div className="min-w-[12rem]">
            {/* Phase-1 TikTok Shop market selector. Drives the
                prompt template (UK retail vs US retail) and the
                posting-assist copy on later pages. Defaults to UK.
                Editable per-batch later via the batch detail page. */}
            <label className="label" htmlFor="market">Market</label>
            <select
              className="field"
              id="market"
              name="market"
              defaultValue="uk"
            >
              <option value="uk">UK TikTok Shop</option>
              <option value="us">US TikTok Shop</option>
            </select>
          </div>
          <button className="btn btn-primary" type="submit">
            Create
          </button>
        </form>
      </Panel>

      {batches.length === 0 ? (
        <EmptyState
          icon="▤"
          title="No batches yet"
          hint="Batches collect products so the runner can drive them through Flow."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {batches.map((b) => (
            <Link
              key={b.id}
              href={`/batches/${b.id}`}
              className="panel p-5 hover:border-accent transition-colors group block"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-medium text-text group-hover:text-accent transition-colors">
                  {b.name}
                </div>
                <div className="flex items-baseline gap-1.5">
                  <StatusChip
                    label={b.market === "us" ? "US" : "UK"}
                    variant={b.market === "us" ? "accent" : "ok"}
                  />
                  <StatusChip label={b.status} variant="muted" />
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>{b._count.products} products</span>
                <span>·</span>
                <span>{b._count.jobs} jobs</span>
                <span>·</span>
                <span>{new Date(b.createdAt).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
