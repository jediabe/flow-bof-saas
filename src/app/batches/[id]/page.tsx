import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { parseJson } from "@/lib/json-column";
import StatusChip from "@/components/StatusChip";
import {
  loadOrCreateSettings,
  toMaskedSettings,
} from "@/lib/workspace-settings";
import { DEFAULT_MODELS } from "@/lib/ai/types";
import { addProduct, deleteBatch, setBatchMarket } from "../actions";
import MobileReviewQRCard from "./MobileReviewQRCard";
import MobilePostingQRCard from "./MobilePostingQRCard";
import KalodataImportPanel from "./KalodataImportPanel";
import AiPromptsPanel from "./AiPromptsPanel";
import GenerateImagesPanel from "./GenerateImagesPanel";
import BatchWorkbench from "./BatchWorkbench";
import LatestTaskResult from "./LatestTaskResult";
import StopGenerationButton from "./StopGenerationButton";
import FlowItemsTab, {
  type FlowItemRow,
  type FlowItemsTabProduct,
  type FlowItemBindState,
} from "./FlowItemsTab";
import {
  ingestFlowItemsForBatch,
  countFlowItemsByState,
} from "@/lib/flow-items";
import BatchPageClient from "./BatchPageClient";
import type {
  PipelineProduct,
} from "./pipeline/BatchPipeline";
import type {
  ExpandedCardProduct,
} from "./pipeline/ExpandedPipelineCard";

export const dynamic = "force-dynamic";

/**
 * Resolve the public origin for building a full mobile QR URL.
 * Prefers NEXT_PUBLIC_APP_URL when set; falls back to the
 * incoming request's host header.
 */
async function _reviewBaseUrl(): Promise<string> {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("host") || "localhost:3000";
  const isLocal =
    /^(localhost|127\.|0\.0\.0\.0)/.test(host) ||
    (/:\d+$/.test(host) && host.startsWith("localhost"));
  const proto = isLocal ? "http" : "https";
  return `${proto}://${host}`;
}

/**
 * Phase 10 batch detail page (full redesign).
 *
 * Server component. Loads everything the new pipeline-based UI
 * needs, hands off to BatchPageClient for the interactive
 * surface. The legacy tab-based layout (BatchTabs +
 * ProductsWithIpRisk + FlowItemsTab tab) is replaced by:
 *
 *   - <BatchPipeline>: 5 vertical swim lanes, compact cards
 *   - <BatchDrawer>:    right-side overlay with Mobile / Flow /
 *                       Activity / Settings panels
 *   - <EmptyBatchHero>: full-bleed CTA on a fresh empty batch
 *
 * Kalodata import + Add-manually still live as sections below
 * the pipeline (low-frequency but reachable).
 */
export default async function BatchDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ job?: string | string[] }>;
}) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const latestJobId = Array.isArray(sp.job) ? sp.job[0] : sp.job;
  const { workspace } = await getCurrentWorkspace();

  const batch = await db.batch.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      products: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
          images: { orderBy: { role: "asc" } },
        },
      },
      jobs: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!batch) notFound();

  const agents = await db.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, baseUrl: true, status: true },
  });

  const latestJob = latestJobId
    ? await db.job.findFirst({
        where: {
          id: latestJobId,
          workspaceId: workspace.id,
          batchId: batch.id,
        },
        select: {
          id: true, jobType: true, status: true, result: true,
          error: true, createdAt: true, updatedAt: true,
        },
      })
    : null;

  // Active-job map: which product IDs have an in-flight generation?
  // Used to flip a card into the "generating" stage.
  const runningJobs = await db.job.findMany({
    where: {
      workspaceId: workspace.id,
      batchId: batch.id,
      jobType: "generate_flow_images",
      status: { in: ["queued", "running"] },
    },
    select: { id: true, payload: true },
  });
  const inFlightProductIds = new Set<string>();
  for (const j of runningJobs) {
    try {
      const p = j.payload ? JSON.parse(j.payload) : null;
      const items = Array.isArray(p?.items) ? p.items : [];
      for (const it of items) {
        const pid = (it?.item_id as string | undefined)?.trim();
        if (pid) inFlightProductIds.add(pid);
      }
    } catch {
      // ignore malformed payloads
    }
  }

  const activeJobsCount = await db.job.count({
    where: {
      workspaceId: workspace.id,
      batchId: batch.id,
      status: { in: ["queued", "running"] },
    },
  });

  // Phase 6 — ingest FlowItem rows so the drawer's Flow panel
  // shows fresh data.
  try {
    await ingestFlowItemsForBatch({
      workspaceId: workspace.id,
      batchId: batch.id,
    });
  } catch (err) {
    console.warn("[flow-items] ingest failed:", err);
  }
  const flowItemRows = await db.flowItem.findMany({
    where: { workspaceId: workspace.id, batchId: batch.id },
    orderBy: [{ bindState: "asc" }, { firstSeenAt: "desc" }],
  });
  const flowItemRowsForTab: FlowItemRow[] = flowItemRows.map((it) => ({
    id:           it.id,
    bindState:    it.bindState as FlowItemBindState,
    mediaId:      it.mediaId,
    tileHref:     it.tileHref,
    kind:         it.kind,
    favorited:    it.favorited,
    thumbnailUrl: it.thumbnailUrl,
    productId:    it.productId,
    notes:        it.notes,
    firstSeenAt:  it.firstSeenAt.toISOString(),
  }));
  const flowProductsForTab: FlowItemsTabProduct[] = batch.products.map((p) => ({
    id:           p.id,
    productName:  p.productName,
    thumbnailUrl: p.referenceImageUrl,
    reviewStatus: p.reviewStatus,
  }));
  const flowItemCounts = await countFlowItemsByState({
    workspaceId: workspace.id,
    batchId: batch.id,
  });

  // Track which products have a bound FlowItem — drives stage
  // promotion to "generated."
  const boundProductIds = new Set<string>();
  for (const it of flowItemRows) {
    if (
      (it.bindState === "bound" || it.bindState === "auto") &&
      it.productId
    ) {
      boundProductIds.add(it.productId);
    }
  }

  // AI provider status for the AiPromptsPanel + drawer Settings.
  const settingsRow = await loadOrCreateSettings(workspace.id);
  const masked = toMaskedSettings(settingsRow);
  const aiProvider = masked.provider;

  // IP risk gating toggle. When disabled (the default after end-user
  // feedback that the heuristic was too aggressive), we project
  // every product's IP risk status down to "low" before passing it
  // through to the client. That neutralises the gating logic in
  // computeStage + GenerateImagesPanel without touching either; the
  // raw ipRiskStatus on Product rows is preserved for the day the
  // user flips it back on.
  const ipRiskChecksEnabled = settingsRow.ipRiskChecksEnabled;
  const projectIpStatus = (
    raw: string,
  ): "unchecked" | "low" | "medium" | "high" | "needs_manual_review" => {
    if (!ipRiskChecksEnabled) return "low";
    const valid: Array<
      "unchecked" | "low" | "medium" | "high" | "needs_manual_review"
    > = ["unchecked", "low", "medium", "high", "needs_manual_review"];
    return (valid.includes(raw as (typeof valid)[number])
      ? (raw as (typeof valid)[number])
      : "unchecked");
  };
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

  const baseUrl = await _reviewBaseUrl();
  const agentAssetBaseUrl =
    process.env.AGENT_ASSET_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://host.docker.internal:3000";

  // Shape products for the compact pipeline cards.
  const productsCompact: PipelineProduct[] = batch.products.map((p) => {
    const hookVariantsArr =
      (parseJson(p.hookVariants) as
        | Array<{ label: string; text: string; leverName?: string }>
        | null) ?? [];
    return {
      id: p.id,
      productName: p.productName,
      category: p.category,
      referenceImageUrl: p.referenceImageUrl,
      imagePrompt: p.imagePrompt,
      hookVariantsCount: hookVariantsArr.length,
      reviewStatus: p.reviewStatus as PipelineProduct["reviewStatus"],
      postingStatus: p.postingStatus as PipelineProduct["postingStatus"],
      ipRiskStatus: projectIpStatus(p.ipRiskStatus) as PipelineProduct["ipRiskStatus"],
      ipRiskOverride: p.ipRiskOverride,
      referenceImagesCount: p.images.length,
      hasBoundFlowItem: boundProductIds.has(p.id),
      isInActiveGenerationJob: inFlightProductIds.has(p.id),
      gates: [],
      stage: "needs_review", // overridden by client; kept for type
    };
  });

  // Shape full product data for expanded cards. Keyed by id so
  // the client can look up on demand without re-fetching.
  const productsExpandedById: Record<string, ExpandedCardProduct> = {};
  for (const p of batch.products) {
    productsExpandedById[p.id] = {
      id:                     p.id,
      productName:            p.productName,
      originalTitle:          p.originalTitle,
      tiktokUrl:              p.tiktokUrl,
      category:               p.category,
      retailerName:           p.retailerName,
      referenceImagePathLocal: p.referenceImagePathLocal,
      imagePrompt:            p.imagePrompt,
      hook:                   p.hook,
      hookVariants:
        (parseJson(p.hookVariants) as
          | Array<{ label: string; text: string; leverName?: string }>
          | null) ?? [],
      caption:                p.caption,
      hashtags:               (parseJson(p.hashtags) as string[] | null) ?? [],
      productDescription:     p.productDescription,
      aiPromptError:          p.aiPromptError,
      aiPromptGeneratedAt:    p.aiPromptGeneratedAt?.toISOString() ?? null,
      reviewStatus:           p.reviewStatus as ExpandedCardProduct["reviewStatus"],
      postingStatus:          p.postingStatus as ExpandedCardProduct["postingStatus"],
      images: p.images
        .filter(
          (i): i is typeof i & { role: "primary" | "ref2" | "ref3" } =>
            i.role === "primary" || i.role === "ref2" || i.role === "ref3",
        )
        .map((i) => ({
          id: i.id,
          role: i.role,
          url: i.url,
          source: i.source,
        })),
      ipRiskStatus: projectIpStatus(p.ipRiskStatus) as ExpandedCardProduct["ipRiskStatus"],
      ipRiskReasons:
        (parseJson(p.ipRiskReasons) as string[] | null) ?? [],
      ipRiskCheckedAt:        p.ipRiskCheckedAt?.toISOString() ?? null,
      ipRiskOverride:         p.ipRiskOverride,
      ipRiskOverrideReason:   p.ipRiskOverrideReason,
      ipRiskOverrideAt:       p.ipRiskOverrideAt?.toISOString() ?? null,
    };
  }

  // External-link buttons for lanes that have a "share via QR"
  // surface. Built here because they need batch tokens from the
  // server. BatchPageClient mixes these into the lane action row
  // alongside its sheet-opener buttons.
  //
  // Plain <a> on purpose — these open in a new tab and the URL is
  // an absolute baseUrl, so next/link's prefetcher adds no value
  // and triggered 404s in prod when the token was missing
  // (postingToken / reviewToken null → href ended with "/").
  const externalLinks = {
    reviewOnPhone: batch.reviewToken ? (
      <a
        href={`${baseUrl.replace(/\/+$/, "")}/mobile-review/${batch.reviewToken}`}
        target="_blank"
        rel="noreferrer"
        className="btn btn-sm"
      >
        Review on phone ↗
      </a>
    ) : undefined,
    postingQR: batch.postingToken ? (
      <a
        href={`${baseUrl.replace(/\/+$/, "")}/mobile-posting/${batch.postingToken}`}
        target="_blank"
        rel="noreferrer"
        className="btn btn-sm"
      >
        Posting QR ↗
      </a>
    ) : undefined,
  };

  // Drawer content: Mobile / Flow / Activity / Settings.
  const needsReviewCount = batch.products.filter(
    (p) => p.reviewStatus === "needs_review",
  ).length;
  const approvedCount = batch.products.filter(
    (p) => p.reviewStatus === "approved",
  ).length;
  const needsPostingCount = batch.products.filter(
    (p) => p.reviewStatus === "approved" && p.postingStatus === "needs_posting",
  ).length;

  const mobilePanel = (
    <div className="space-y-4">
      <MobileReviewQRCard
        batchId={batch.id}
        reviewToken={batch.reviewToken}
        reviewBaseUrl={baseUrl}
        needsReviewCount={needsReviewCount}
      />
      <MobilePostingQRCard
        batchId={batch.id}
        postingToken={batch.postingToken}
        postingBaseUrl={baseUrl}
        approvedCount={approvedCount}
        needsPostingCount={needsPostingCount}
      />
    </div>
  );

  const flowPanel = (
    <FlowItemsTab
      batchId={batch.id}
      items={flowItemRowsForTab}
      products={flowProductsForTab}
      lastScanAt={null}
    />
  );

  // Action-sheet content. Each block is the exact panel that used
  // to sit stacked below the pipeline; now it gets rendered inside
  // a BatchActionSheet modal launched from a lane header button.
  // Building them here (not in BatchPageClient) so server-loaded
  // data (agents, products, AI provider status) stays in the
  // server tree.
  const addProductsPanel = (
    <div className="space-y-5">
      <KalodataImportPanel batchId={batch.id} />
      <details className="panel p-5" id="add-product" open>
        <summary className="cursor-pointer text-sm font-medium text-muted hover:text-text">
          Add a product manually
        </summary>
        <form
          action={addProduct}
          className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4"
        >
          <input type="hidden" name="batchId" value={batch.id} />
          <div>
            <label className="label">Product name</label>
            <input className="field mt-1" name="productName" required />
          </div>
          <div>
            <label className="label">Category</label>
            <input className="field mt-1" name="category" />
          </div>
          <div>
            <label className="label">TikTok URL</label>
            <input className="field mt-1" name="tiktokUrl" />
          </div>
          <div>
            <label className="label">Retailer / store</label>
            <input
              className="field mt-1"
              name="retailerName"
              placeholder="e.g. boots, sephora_uk (or blank)"
            />
          </div>
          <div className="md:col-span-2">
            <label className="label">Image prompt</label>
            <textarea className="field mt-1" name="imagePrompt" rows={3} />
          </div>
          <div className="md:col-span-2">
            <button className="btn btn-primary" type="submit">
              Add product
            </button>
          </div>
        </form>
      </details>
    </div>
  );

  const aiPromptsActionPanel = (
    <AiPromptsPanel
      batchId={batch.id}
      provider={aiProvider}
      providerLabel={aiProviderLabel}
      providerHasKey={aiProviderHasKey}
      products={batch.products.map((p) => ({
        id: p.id,
        productName: p.productName,
        hasPrompt: !!p.imagePrompt,
      }))}
    />
  );

  const imageGenActionPanel =
    agents.length === 0 ? (
      <div className="text-sm text-muted">
        No runner registered.{" "}
        <Link href="/agents" className="text-accent hover:underline">
          Set one up
        </Link>{" "}
        before generating images.
      </div>
    ) : (
      <GenerateImagesPanel
        batchId={batch.id}
        agents={agents.map((a) => ({
          id: a.id, name: a.name, status: a.status,
        }))}
        products={batch.products.map((p) => ({
          id:                      p.id,
          productName:             p.productName,
          referenceImageUrl:       p.referenceImageUrl,
          referenceImagePathLocal: p.referenceImagePathLocal,
          imagePrompt:             p.imagePrompt,
          reviewStatus:            p.reviewStatus,
          images: p.images
            .filter(
              (i): i is typeof i & { role: "primary" | "ref2" | "ref3" } =>
                i.role === "primary" || i.role === "ref2" || i.role === "ref3",
            )
            .map((i) => ({
              role: i.role,
              url: i.url,
              pathLocal: i.pathLocal,
            })),
          ipRiskStatus: projectIpStatus(p.ipRiskStatus),
          ipRiskOverride: p.ipRiskOverride,
        }))}
        agentAssetBaseUrl={agentAssetBaseUrl}
        lastJob={null}
      />
    );

  const workbenchActionPanel =
    agents.length === 0 ? (
      <div className="text-sm text-muted">
        No runner registered.{" "}
        <Link href="/agents" className="text-accent hover:underline">
          Set one up
        </Link>{" "}
        before scanning Flow or generating videos.
      </div>
    ) : (
      <BatchWorkbench
        batchId={batch.id}
        agents={agents}
        scanSummary={{
          favoritedImages: null,
          tilesScanned: null,
          lastScanJobId: null,
          lastScanAt: null,
        }}
        videoSummary={{
          submitted: null,
          skipped: null,
          failed: null,
          lastVideoJobId: null,
          lastVideoAt: null,
        }}
      />
    );

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <Link
            href="/batches"
            className="text-xs text-muted hover:text-text"
          >
            ← Batches
          </Link>
          <h1 className="h-page mt-1">{batch.name}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <StatusChip
              label={
                batch.market === "us" ? "US TikTok Shop" : "UK TikTok Shop"
              }
              variant={batch.market === "us" ? "accent" : "ok"}
            />
            <StatusChip label={batch.status} variant="muted" />
            <span className="text-xs text-muted">
              {batch.products.length} products · created{" "}
              {new Date(batch.createdAt).toLocaleDateString()}
            </span>
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
        <div className="flex flex-col items-end gap-2 shrink-0">
          <StopGenerationButton
            batchId={batch.id}
            activeJobs={activeJobsCount}
          />
          <form action={deleteBatch}>
            <input type="hidden" name="id" value={batch.id} />
            <button className="btn btn-danger" type="submit">
              Delete batch
            </button>
          </form>
        </div>
      </header>

      {latestJob && <LatestTaskResult job={latestJob} />}

      {/* Pipeline + drawer + action sheets (client-rendered) */}
      <BatchPageClient
        batchId={batch.id}
        batchName={batch.name}
        productsCompact={productsCompact}
        productsExpandedById={productsExpandedById}
        externalLinks={externalLinks}
        actionPanels={{
          addProducts: addProductsPanel,
          aiPrompts:   aiPromptsActionPanel,
          imageGen:    imageGenActionPanel,
          workbench:   workbenchActionPanel,
        }}
        ipRiskChecksEnabled={ipRiskChecksEnabled}
        drawer={{
          mobilePanel,
          flowPanel,
          activityJobs: batch.jobs.map((j) => ({
            id: j.id,
            jobType: j.jobType,
            status: j.status,
            createdAt: j.createdAt.toISOString(),
          })),
          settingsInfo: {
            aiProviderLabel,
            aiProviderHasKey,
            runnerVersion:
              agents.find((a) => a.status === "connected")?.name ?? null,
            runnerConnected: agents.some((a) => a.status === "connected"),
            batchMarket:
              batch.market === "us" ? "us" : "uk",
          },
          badges: {
            mobile:
              needsReviewCount > 0
                ? { text: String(needsReviewCount), tone: "warn" }
                : undefined,
            flow:
              flowItemCounts.unbound > 0
                ? { text: String(flowItemCounts.unbound), tone: "warn" }
                : undefined,
            activity:
              activeJobsCount > 0
                ? { text: String(activeJobsCount), tone: "accent" }
                : undefined,
          },
        }}
      />

    </div>
  );
}
