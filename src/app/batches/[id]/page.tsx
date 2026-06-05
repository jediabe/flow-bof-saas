import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { parseJson } from "@/lib/json-column";
// (json-column already imported; AI types use it for hashtags JSON.)
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import MetricCard from "@/components/ui/MetricCard";
import StatusChip from "@/components/StatusChip";
import { friendlyJobType } from "@/lib/job-types";
import {
  loadOrCreateSettings,
  toMaskedSettings,
} from "@/lib/workspace-settings";
import { DEFAULT_MODELS } from "@/lib/ai/types";
import { addProduct, deleteBatch, setBatchMarket } from "../actions";
import BatchWorkbench from "./BatchWorkbench";
import GenerateImagesPanel from "./GenerateImagesPanel";
import MobileReviewQRCard from "./MobileReviewQRCard";
import { headers } from "next/headers";
import KalodataImportPanel from "./KalodataImportPanel";
import AiPromptsPanel from "./AiPromptsPanel";
import LatestTaskResult from "./LatestTaskResult";
import ProductEditor, {
  type ProductRow,
  type SubmittedStatus,
} from "./ProductEditor";

export const dynamic = "force-dynamic";

/**
 * Resolve the public origin for building a full mobile-review
 * URL. Prefers NEXT_PUBLIC_APP_URL when set; falls back to the
 * incoming request's host header so dev / preview deploys work
 * without env config. Strips trailing slash so the QR card can
 * safely concatenate with a relative path.
 */
async function _reviewBaseUrl(): Promise<string> {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  // Fall back to the request host. Next 15 — headers() is async.
  const h = await headers();
  const host = h.get("host") || "localhost:3000";
  // Default to https unless we're clearly on a local dev port.
  const isLocal = /^(localhost|127\.|0\.0\.0\.0)/.test(host) ||
                  /:\d+$/.test(host) && host.startsWith("localhost");
  const proto = isLocal ? "http" : "https";
  return `${proto}://${host}`;
}

const JOB_STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  queued:    "muted",
  running:   "warn",
  succeeded: "ok",
  failed:    "bad",
  cancelled: "muted",
};

function timeAgo(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * The local runner's generate_flow_images result puts a status on each
 * item. We map runner-status strings to the SubmittedStatus union the
 * ProductEditor renders. Anything we don't recognise becomes "unknown"
 * so the chip stays muted instead of mis-coloured.
 */
function mapStatus(s: string | undefined): SubmittedStatus {
  if (!s) return "unknown";
  if (s === "submitted" || s === "captured") return "submitted";
  if (s === "failed")                         return "failed";
  if (s.startsWith("skipped"))                return "skipped";
  if (s === "pending" || s === "queued")      return "pending";
  return "unknown";
}

export default async function BatchDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `?job=<id>` is set when a workflow action redirects back to the
   * batch page. Drives the LatestTaskResult inline summary so users
   * stay on /batches/[id] across the full image → favorite → video
   * loop.
   */
  searchParams?: Promise<{ job?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const latestJobId = Array.isArray(sp.job) ? sp.job[0] : sp.job;
  const { workspace } = await getCurrentWorkspace();
  const batch = await db.batch.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      // Hide soft-deleted products from every default view. The
      // batch detail page, generation eligibility, and product
      // counts all consume this list, so filtering here is the
      // single chokepoint. A future "Show deleted (N)" toggle
      // could broaden the where clause — Phase 7 follow-up.
      products: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
      },
      jobs: { orderBy: { createdAt: "desc" }, take: 12 },
    },
  });
  if (!batch) notFound();

  const agents = await db.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, baseUrl: true, status: true },
  });

  // Latest-task result for the optional `?job=<id>` panel. Scoped to
  // this workspace + batch so a stale URL from a different batch
  // can't leak job state across tenants.
  const latestJob = latestJobId
    ? await db.job.findFirst({
        where: {
          id: latestJobId,
          workspaceId: workspace.id,
          batchId: batch.id,
        },
        select: {
          id: true,
          jobType: true,
          status: true,
          result: true,
          error: true,
          createdAt: true,
          updatedAt: true,
        },
      })
    : null;

  // Pull the latest scan + video results so the workbench can show
  // counts above the action buttons (the user wants to see what state
  // they're in before pressing buttons).
  const [lastScan, lastVideoRun, lastImageRun] = await Promise.all([
    db.job.findFirst({
      where: {
        workspaceId: workspace.id,
        batchId: batch.id,
        jobType: "scan_favorited_images",
        status: "succeeded",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, result: true, createdAt: true },
    }),
    db.job.findFirst({
      where: {
        workspaceId: workspace.id,
        batchId: batch.id,
        jobType: "generate_flow_videos_from_favorites",
        status: "succeeded",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, result: true, createdAt: true },
    }),
    db.job.findFirst({
      where: {
        workspaceId: workspace.id,
        batchId: batch.id,
        jobType: "generate_flow_images",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, result: true, createdAt: true, status: true },
    }),
  ]);

  const scanSummary = lastScan?.result
    ? (parseJson(lastScan.result) as {
        tiles_scanned?: number;
        favorited_images_count?: number;
      } | null)
    : null;
  const videoSummary = lastVideoRun?.result
    ? (parseJson(lastVideoRun.result) as {
        submitted?: number;
        skipped_already_submitted?: number;
        failed?: number;
        // Generate Videos scans Flow's grid itself before animating
        // — the runner returns the live count here so the page can
        // show fresh "favorited" numbers without requiring a
        // separate scan_favorited_images run.
        favorited_images_found?: number;
      } | null)
    : null;
  const imageSummary = lastImageRun?.result
    ? (parseJson(lastImageRun.result) as {
        submitted?: number;
        failed?: number;
        skipped?: number;
        items?: { item_id?: string; status?: string }[];
      } | null)
    : null;

  // Live "favorited images" count for the metric card + workbench.
  // The runner's generate_flow_videos_from_favorites job ALSO scans
  // the Flow grid before animating, and returns favorited_images_found
  // in its result envelope. Whichever job ran most recently has the
  // freshest number — typically that's the video job right after the
  // user favorites a new image. Falls back through (newer source →
  // scan → video → null) so a user who has only ever clicked
  // "Generate Videos" still sees a meaningful count.
  const videoNewerThanScan =
    !!lastVideoRun &&
    (!lastScan || lastVideoRun.createdAt > lastScan.createdAt);
  const favoritedImagesLive: number | null =
    videoNewerThanScan
      ? (videoSummary?.favorited_images_found ?? scanSummary?.favorited_images_count ?? null)
      : (scanSummary?.favorited_images_count ?? videoSummary?.favorited_images_found ?? null);
  const favoritedImagesAsOf: Date | null =
    videoNewerThanScan
      ? (lastVideoRun?.createdAt ?? lastScan?.createdAt ?? null)
      : (lastScan?.createdAt ?? lastVideoRun?.createdAt ?? null);

  // Build a Map<productId → SubmittedStatus> from the latest image
  // job's items so the product cards can show their per-row status.
  const submittedStatusByProduct = new Map<string, SubmittedStatus>();
  for (const it of imageSummary?.items ?? []) {
    if (it.item_id) {
      submittedStatusByProduct.set(it.item_id, mapStatus(it.status));
    }
  }

  // Reshape products into the ProductEditor's row shape (handles
  // null/undefined explicitly so the client component doesn't need to).
  const productRows: ProductRow[] = batch.products.map((p) => ({
    id: p.id,
    productName:             p.productName,
    originalTitle:           p.originalTitle,
    tiktokUrl:               p.tiktokUrl,
    category:                p.category,
    retailerName:            p.retailerName,
    imageUrl:                p.imageUrl,
    referenceImageUrl:       p.referenceImageUrl,
    referenceImagePathLocal: p.referenceImagePathLocal,
    imagePrompt:             p.imagePrompt,
    hook:                    p.hook,
    caption:                 p.caption,
    hashtags:                (parseJson(p.hashtags) as string[] | null) ?? [],
    aiPromptError:           p.aiPromptError,
    aiPromptGeneratedAt:     p.aiPromptGeneratedAt?.toISOString() ?? null,
    submittedStatus:         submittedStatusByProduct.get(p.id) ?? null,
    // Phase-1 review workflow. The string is one of the four
    // ReviewStatus values; ProductEditor casts to its union type.
    reviewStatus:            (p.reviewStatus as "needs_review" | "approved" | "rejected" | "maybe"),
    deletedAt:               p.deletedAt?.toISOString() ?? null,
  }));

  // "Ready" = has both a reference (URL or local override) AND a prompt.
  // Two refs are equivalent on the runner side — it tries the path
  // first and falls back to the URL.
  const readyCount = productRows.filter(
    (p) =>
      !!p.imagePrompt &&
      (!!p.referenceImageUrl || !!p.referenceImagePathLocal),
  ).length;
  const missingPromptCount = productRows.filter((p) => !p.imagePrompt).length;
  const missingRefCount = productRows.filter(
    (p) => !p.referenceImageUrl && !p.referenceImagePathLocal,
  ).length;

  // Fallback chain for the URL the runner uses to fetch reference
  // images: explicit override wins, then the SaaS's public URL
  // (right answer for hosted prod), then host.docker.internal for
  // local dev where the runner and SaaS share a Docker Desktop host.
  const agentAssetBaseUrl =
    process.env.AGENT_ASSET_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://host.docker.internal:3000";

  // AI provider status for the AiPromptsPanel — only the *masked*
  // projection lands on the client (provider key + model only; no
  // raw API keys).
  const settingsRow = await loadOrCreateSettings(workspace.id);
  const masked = toMaskedSettings(settingsRow);
  const aiProvider = masked.provider;
  const aiProviderLabel =
    aiProvider === "openai"
      ? `OpenAI · ${masked.openai.model || DEFAULT_MODELS.openai}`
      : aiProvider === "anthropic"
        ? `Anthropic · ${masked.anthropic.model || DEFAULT_MODELS.anthropic}`
        : aiProvider === "openrouter"
          ? `OpenRouter · ${masked.openrouter.model || DEFAULT_MODELS.openrouter}`
          : "Manual (deterministic UK prompt)";
  const aiProviderHasKey =
    aiProvider === "openai"
      ? masked.openai.keySet
      : aiProvider === "anthropic"
        ? masked.anthropic.keySet
        : aiProvider === "openrouter"
          ? masked.openrouter.keySet
          : true;

  return (
    <div className="space-y-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <Link href="/batches" className="text-xs text-muted hover:text-text">
            ← Batches
          </Link>
          <h1 className="h-page mt-1">{batch.name}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <StatusChip
              label={batch.market === "us" ? "US TikTok Shop" : "UK TikTok Shop"}
              variant={batch.market === "us" ? "accent" : "ok"}
            />
            <StatusChip label={batch.status} variant="muted" />
            <span className="text-xs text-muted">
              {batch.products.length} products · created{" "}
              {new Date(batch.createdAt).toLocaleDateString()}
            </span>
            {/* Phase-1 market switcher. Lives inline next to the
                batch metadata so it's available without scrolling.
                Submits via the server action; page revalidates after. */}
            <form
              action={setBatchMarket}
              className="inline-flex items-center gap-1.5"
            >
              <input type="hidden" name="batchId" value={batch.id} />
              <span className="text-[11px] text-muted">switch:</span>
              <select
                name="market"
                defaultValue={batch.market}
                className="field-inline text-xs px-2 py-0.5"
              >
                <option value="uk">UK</option>
                <option value="us">US</option>
              </select>
              <button
                type="submit"
                className="text-[11px] text-accent hover:underline"
              >
                Apply
              </button>
            </form>
          </div>
        </div>
        <form action={deleteBatch}>
          <input type="hidden" name="id" value={batch.id} />
          <button className="btn btn-danger" type="submit">
            Delete batch
          </button>
        </form>
      </header>

      {/* ----- Latest task result (inline, when ?job=<id>) ------------ */}
      {latestJob && <LatestTaskResult job={latestJob} />}

      {/* ----- Overview metrics --------------------------------------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="Products"
          value={batch.products.length}
          hint={`${readyCount} ready`}
          tone={readyCount > 0 ? "ok" : "default"}
        />
        <MetricCard
          label="Images submitted"
          value={imageSummary?.submitted ?? scanSummary?.tiles_scanned ?? "—"}
          tone={
            (imageSummary?.submitted ?? scanSummary?.tiles_scanned) ? "accent" : "muted"
          }
          hint={
            imageSummary?.failed
              ? `${imageSummary.failed} failed`
              : undefined
          }
        />
        <MetricCard
          label="Favorited images"
          value={favoritedImagesLive ?? "—"}
          tone={favoritedImagesLive ? "ok" : "muted"}
        />
        <MetricCard
          label="Videos submitted"
          value={videoSummary?.submitted ?? "—"}
          tone={videoSummary?.submitted ? "accent" : "muted"}
          hint={
            videoSummary?.skipped_already_submitted
              ? `${videoSummary.skipped_already_submitted} skipped`
              : undefined
          }
        />
      </div>

      {/* ----- Kalodata import --------------------------------------- */}
      <KalodataImportPanel batchId={batch.id} />

      {/* ----- AI prompt generation ---------------------------------- */}
      <AiPromptsPanel
        batchId={batch.id}
        provider={aiProvider}
        providerLabel={aiProviderLabel}
        providerHasKey={aiProviderHasKey}
      />

      {/* ----- Mobile Product Review (Phase 4) -------------------- */}
      <MobileReviewQRCard
        batchId={batch.id}
        reviewToken={batch.reviewToken}
        reviewBaseUrl={await _reviewBaseUrl()}
        needsReviewCount={
          batch.products.filter((p) => p.reviewStatus === "needs_review").length
        }
      />

      {/* ----- Products section -------------------------------------- */}
      <Panel
        title={`Products (${productRows.length})`}
        action={
          <div className="flex items-baseline gap-3 text-[11px] text-muted">
            <span className="text-ok">{readyCount} ready</span>
            {missingPromptCount > 0 && (
              <span className="text-warn">{missingPromptCount} no prompt</span>
            )}
            {missingRefCount > 0 && (
              <span className="text-warn">{missingRefCount} no reference</span>
            )}
            <a
              href="#add-product"
              className="text-accent hover:underline ml-1"
            >
              Add manually ↓
            </a>
          </div>
        }
      >
        {productRows.length === 0 ? (
          <EmptyState
            icon="◇"
            title="No products yet"
            hint="Add a product below to give the runner something to work with."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {productRows.map((p) => (
              <ProductEditor key={p.id} batchId={batch.id} product={p} />
            ))}
          </div>
        )}
      </Panel>

      {/* ----- Generate Product Images ------------------------------ */}
      {agents.length === 0 ? (
        <Panel title="Generate Product Images">
          <EmptyState
            icon="◆"
            title="No runner registered"
            hint="Register a local runner before you can drive Flow from this batch."
            action={
              <Link href="/agents" className="btn btn-primary">
                Open Runner
              </Link>
            }
          />
        </Panel>
      ) : (
        <GenerateImagesPanel
          batchId={batch.id}
          agents={agents.map((a) => ({
            id:     a.id,
            name:   a.name,
            status: a.status,
          }))}
          products={batch.products.map((p) => ({
            id:                      p.id,
            productName:             p.productName,
            referenceImageUrl:       p.referenceImageUrl,
            referenceImagePathLocal: p.referenceImagePathLocal,
            imagePrompt:             p.imagePrompt,
            // Phase 1: eligibility filter now defaults to
            // reviewStatus=="approved". Carry the field through so
            // the panel can apply the filter (and show an override
            // checkbox for "include not-approved").
            reviewStatus:            p.reviewStatus,
          }))}
          agentAssetBaseUrl={agentAssetBaseUrl}
          lastJob={
            lastImageRun && imageSummary
              ? {
                  jobId:     lastImageRun.id,
                  createdAt: lastImageRun.createdAt.toISOString(),
                  submitted: imageSummary.submitted ?? 0,
                  failed:    imageSummary.failed ?? 0,
                  total:     imageSummary.items?.length ?? 0,
                }
              : null
          }
        />
      )}

      {/* ----- Favorites + Videos workbench -------------------------- */}
      {agents.length > 0 && (
        <BatchWorkbench
          batchId={batch.id}
          agents={agents}
          scanSummary={{
            favoritedImages: favoritedImagesLive,
            tilesScanned: scanSummary?.tiles_scanned ?? null,
            lastScanJobId: lastScan?.id ?? null,
            lastScanAt: favoritedImagesAsOf?.toISOString() ?? null,
          }}
          videoSummary={{
            submitted: videoSummary?.submitted ?? null,
            skipped: videoSummary?.skipped_already_submitted ?? null,
            failed: videoSummary?.failed ?? null,
            lastVideoJobId: lastVideoRun?.id ?? null,
            lastVideoAt: lastVideoRun?.createdAt?.toISOString() ?? null,
          }}
        />
      )}

      {/* ----- Manual product form (rare path) ------------------------ */}
      <Panel title="Add product manually" action={<span id="add-product" />}>
        <form
          action={addProduct}
          className="grid grid-cols-1 md:grid-cols-2 gap-3"
        >
          <input type="hidden" name="batchId" value={batch.id} />
          <div>
            <label className="label">Product name</label>
            <input className="field" name="productName" required />
          </div>
          <div>
            <label className="label">Category</label>
            <input className="field" name="category" />
          </div>
          <div>
            <label className="label">TikTok URL</label>
            <input className="field" name="tiktokUrl" />
          </div>
          <div>
            <label className="label">Retailer / store</label>
            <input
              className="field"
              name="retailerName"
              placeholder="e.g. boots, sephora_uk (or leave blank)"
            />
          </div>
          <div>
            <label className="label">Local reference image path</label>
            <input
              className="field"
              name="referenceImagePathLocal"
              placeholder="inputs/reference_images/01_primary.jpg"
            />
          </div>
          <div>
            <label className="label">Reference image URL (cloud, optional)</label>
            <input className="field" name="referenceImageUrl" />
          </div>
          <div className="md:col-span-2">
            <label className="label">Image prompt</label>
            <textarea className="field" name="imagePrompt" rows={4} />
          </div>
          <div className="md:col-span-2">
            <button className="btn btn-primary" type="submit">
              Add product
            </button>
          </div>
        </form>
      </Panel>

      {/* ----- Recent activity --------------------------------------- */}
      <Panel
        title={`Activity (${batch.jobs.length})`}
        action={
          <Link href="/jobs" className="text-xs text-accent hover:underline">
            All jobs →
          </Link>
        }
      >
        {batch.jobs.length === 0 ? (
          <EmptyState
            icon="≡"
            title="No jobs run for this batch yet"
            hint="Trigger one of the actions above."
          />
        ) : (
          <ul className="divide-y divide-border">
            {batch.jobs.map((j) => (
              <li
                key={j.id}
                className="py-3 flex items-center gap-3 text-sm"
              >
                <StatusChip
                  label={j.status}
                  variant={JOB_STATUS_VARIANT[j.status] ?? "muted"}
                />
                <Link
                  href={`/jobs/${j.id}`}
                  className="text-text hover:text-accent transition-colors"
                >
                  {friendlyJobType(j.jobType)}
                </Link>
                <span className="text-xs text-muted ml-auto">
                  {timeAgo(j.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
