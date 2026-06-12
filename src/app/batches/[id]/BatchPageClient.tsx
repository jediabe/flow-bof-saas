"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import BatchPageRefresher from "./BatchPageRefresher";
import BatchActionSheet from "./BatchActionSheet";
import BatchPipeline, {
  type PipelineProduct,
  type LaneActionConfig,
} from "./pipeline/BatchPipeline";
import ExpandedPipelineCard, {
  type ExpandedCardProduct,
} from "./pipeline/ExpandedPipelineCard";
import EmptyBatchHero from "./pipeline/EmptyBatchHero";
import BatchDrawer, {
  type DrawerTabConfig,
  type DrawerPanel,
} from "./pipeline/BatchDrawer";
import DrawerActivityPanel, {
  type ActivityJob,
} from "./pipeline/DrawerActivityPanel";
import DrawerSettingsPanel, {
  type DrawerSettingsInfo,
} from "./pipeline/DrawerSettingsPanel";
import PanelLauncher from "./pipeline/PanelLauncher";
import { moveProductToStage } from "../actions";
import { type Stage } from "@/lib/batch-stages";

/**
 * Phase 11 — top-level client component. Owns the pipeline +
 * drawer + action sheets.
 *
 * Action sheets vs. drawer:
 *   - Drawer  (right overlay): ambient / informational panels
 *     the user dips into — Mobile QR, Flow items, Activity log,
 *     Settings.
 *   - Sheets (center modal):   "do something" panels launched
 *     from a lane header button — Add products, Generate AI
 *     prompts, Generate images, Workbench (Flow scan + video
 *     gen). One sheet open at a time.
 *
 * The legacy panels (AiPromptsPanel, GenerateImagesPanel,
 * BatchWorkbench, KalodataImportPanel, manual-add form) come in
 * as ReactNode props from page.tsx and get rendered INSIDE the
 * sheets. The panels themselves are unchanged — only how they
 * get launched is new.
 */

/** Discrete identifiers for each action sheet so the state
 *  stays a single string + null rather than four booleans. */
type SheetKey =
  | "add-products"   // Kalodata import + manual add
  | "ai-prompts"     // bulk AI prompt generation
  | "image-gen"      // dispatch image generation
  | "workbench"      // Flow scan + video gen
  | null;

export interface BatchPageClientProps {
  batchId: string;
  batchName: string;
  productsCompact: PipelineProduct[];
  productsExpandedById: Record<string, ExpandedCardProduct>;
  drawer: {
    mobilePanel: React.ReactNode;
    flowPanel: React.ReactNode;
    activityJobs: ActivityJob[];
    settingsInfo: DrawerSettingsInfo;
    badges?: Partial<Record<DrawerPanel, { text: string; tone?: DrawerTabConfig["badgeTone"] }>>;
  };
  /** Pre-rendered panel content for the action sheets. page.tsx
   *  knows how to build each panel (server data wiring); we just
   *  decide WHEN to show it. */
  actionPanels: {
    addProducts: ReactNode;
    aiPrompts: ReactNode;
    imageGen: ReactNode;
    workbench: ReactNode;
  };
  /** External-link buttons for lanes that have a "share via QR"
   *  surface (Needs Review → Review on phone, Posted → Posting
   *  QR). Built upstream because they need the batch tokens. */
  externalLinks?: {
    reviewOnPhone?: ReactNode;
    postingQR?: ReactNode;
  };
  /** Workspace-level IP risk toggle. Forwarded to ExpandedPipelineCard
   *  so the IP risk surface stays hidden when the user has opted out. */
  ipRiskChecksEnabled?: boolean;
}

export default function BatchPageClient({
  batchId,
  batchName,
  productsCompact,
  productsExpandedById,
  drawer,
  actionPanels,
  externalLinks,
  ipRiskChecksEnabled = false,
}: BatchPageClientProps) {
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPanel, setDrawerPanel] = useState<DrawerPanel>("mobile");
  const [activeSheet, setActiveSheet] = useState<SheetKey>(null);
  const [, startTransition] = useTransition();
  const [moveToast, setMoveToast] = useState<string | null>(null);

  function openPanel(panel: DrawerPanel) {
    setDrawerPanel(panel);
    setDrawerOpen(true);
  }

  function openSheet(key: Exclude<SheetKey, null>) {
    setActiveSheet(key);
  }

  function closeSheet() {
    setActiveSheet(null);
  }

  const tabs: DrawerTabConfig[] = [
    {
      key: "mobile",
      label: "Mobile share",
      ...(drawer.badges?.mobile && {
        badge: drawer.badges.mobile.text,
        badgeTone: drawer.badges.mobile.tone,
      }),
    },
    {
      key: "flow",
      label: "Flow items",
      ...(drawer.badges?.flow && {
        badge: drawer.badges.flow.text,
        badgeTone: drawer.badges.flow.tone,
      }),
    },
    {
      key: "activity",
      label: "Activity",
      ...(drawer.badges?.activity && {
        badge: drawer.badges.activity.text,
        badgeTone: drawer.badges.activity.tone,
      }),
    },
    { key: "settings", label: "Settings" },
  ];

  function onDropToStage(productId: string, targetStage: Stage) {
    setMoveToast(null);
    const fd = new FormData();
    fd.set("batchId", batchId);
    fd.set("productId", productId);
    fd.set("targetStage", targetStage);
    startTransition(async () => {
      const r = await moveProductToStage(fd);
      setMoveToast(r.message);
      // router.refresh() so the new stage shows immediately —
      // revalidatePath in the action only invalidates the cache
      // and won't re-render an already-painted tree on its own.
      router.refresh();
      setTimeout(() => setMoveToast(null), 4000);
    });
  }

  // Build the lane action buttons here (instead of upstream in
  // page.tsx) because each button needs to call openSheet, which
  // is local state. External-link buttons (Review on phone /
  // Posting QR) still come in from page.tsx since they need batch
  // tokens that live on the server.
  const laneActions: LaneActionConfig = {
    needs_review: (
      <>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => openSheet("add-products")}
        >
          + Add products
        </button>
        {externalLinks?.reviewOnPhone}
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => openSheet("ai-prompts")}
          title="Bulk-generate AI image prompts for products that don't have one yet."
        >
          Generate AI prompts
        </button>
      </>
    ),
    ready: (
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={() => openSheet("image-gen")}
        title="Dispatch a Flow image-generation job for approved products."
      >
        Generate images →
      </button>
    ),
    generating: null,
    generated: (
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => openSheet("workbench")}
        title="Scan Flow for new tiles, generate videos for generated images."
      >
        Scan Flow / videos
      </button>
    ),
    posted: externalLinks?.postingQR ?? null,
  };

  // Sheet rendering — single component instance per key, conditionally
  // visible. Keeping them all mounted (just hidden) would preserve any
  // panel-internal state across opens, but the panels are mostly
  // form-driven so re-mounting on open is fine and saves DOM weight.
  const sheets = (
    <>
      <BatchActionSheet
        open={activeSheet === "add-products"}
        onClose={closeSheet}
        title="Add products to this batch"
        subtitle="Import a Kalodata XLSX export or add a single product manually."
      >
        {actionPanels.addProducts}
      </BatchActionSheet>

      <BatchActionSheet
        open={activeSheet === "ai-prompts"}
        onClose={closeSheet}
        title="Generate AI image prompts"
        subtitle="Author per-product image prompts, retailer placement, hooks, and hashtags."
      >
        {actionPanels.aiPrompts}
      </BatchActionSheet>

      <BatchActionSheet
        open={activeSheet === "image-gen"}
        onClose={closeSheet}
        title="Generate images"
        subtitle="Dispatch a Flow image-generation job for approved, prompt-ready products."
      >
        {actionPanels.imageGen}
      </BatchActionSheet>

      <BatchActionSheet
        open={activeSheet === "workbench"}
        onClose={closeSheet}
        title="Workbench — Flow scan & video generation"
        subtitle="Scan Flow for new tiles and dispatch the video generation jobs."
      >
        {actionPanels.workbench}
      </BatchActionSheet>
    </>
  );

  if (productsCompact.length === 0) {
    return (
      <>
        <BatchPageRefresher />
        <div className="flex justify-end mb-2">
          <PanelLauncher badges={drawer.badges} onOpen={openPanel} />
        </div>
        <EmptyBatchHero
          batchName={batchName}
          onAddProducts={() => openSheet("add-products")}
        />
        <BatchDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          activePanel={drawerPanel}
          onPanelChange={setDrawerPanel}
          tabs={tabs}
          panels={{
            mobile:   drawer.mobilePanel,
            flow:     drawer.flowPanel,
            activity: <DrawerActivityPanel jobs={drawer.activityJobs} />,
            settings: <DrawerSettingsPanel info={drawer.settingsInfo} />,
          }}
        />
        {sheets}
      </>
    );
  }

  return (
    <>
      <BatchPageRefresher />
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="text-xs text-muted">
          Drag any card between lanes to move it forward or back. Click a
          card to expand. Lane buttons open the relevant action.
        </div>
        <PanelLauncher badges={drawer.badges} onOpen={openPanel} />
      </div>

      {moveToast && (
        <div className="mb-3 rounded-2xl border border-accent/40 bg-accent/[0.06] text-accent text-xs px-3 py-2">
          {moveToast}
        </div>
      )}

      <BatchPipeline
        products={productsCompact}
        laneActions={laneActions}
        onDropToStage={onDropToStage}
        renderExpanded={(p, onClose) => {
          const full = productsExpandedById[p.id];
          if (!full) {
            return (
              <div className="text-xs text-muted italic">
                Loading product details…
              </div>
            );
          }
          return (
            <ExpandedPipelineCard
              product={full}
              batchId={batchId}
              stage={p.stage}
              onClose={onClose}
              ipRiskChecksEnabled={ipRiskChecksEnabled}
            />
          );
        }}
      />

      <BatchDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        activePanel={drawerPanel}
        onPanelChange={setDrawerPanel}
        tabs={tabs}
        panels={{
          mobile:   drawer.mobilePanel,
          flow:     drawer.flowPanel,
          activity: <DrawerActivityPanel jobs={drawer.activityJobs} />,
          settings: <DrawerSettingsPanel info={drawer.settingsInfo} />,
        }}
      />
      {sheets}
    </>
  );
}
