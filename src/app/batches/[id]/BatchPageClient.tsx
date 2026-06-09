"use client";

import { useState, useTransition } from "react";
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
 * Phase 10 — top-level client component that stitches the pipeline
 * + drawer together. Lives next to page.tsx so the server
 * component can do all the data loading and just pass the
 * pre-shaped props down.
 *
 * Drawer state (open/closed + which tab) lives here as React
 * state, not URL state. Reason: the user opens/closes the
 * drawer frequently as part of a single session; pushing those
 * transitions through the router would be noisy in the back
 * button. URL syncing would belong in a v2.
 */

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
  laneActions?: LaneActionConfig;
}

export default function BatchPageClient({
  batchId,
  batchName,
  productsCompact,
  productsExpandedById,
  drawer,
  laneActions,
}: BatchPageClientProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerPanel, setDrawerPanel] = useState<DrawerPanel>("mobile");
  const [, startTransition] = useTransition();
  const [moveToast, setMoveToast] = useState<string | null>(null);

  function openPanel(panel: DrawerPanel) {
    setDrawerPanel(panel);
    setDrawerOpen(true);
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
      // Always surface the message — server returns clarifying
      // text for valid moves too ("approved but missing prompt").
      setMoveToast(r.message);
      // Auto-clear after 4s.
      setTimeout(() => setMoveToast(null), 4000);
    });
  }

  if (productsCompact.length === 0) {
    return (
      <>
        <div className="flex justify-end mb-2">
          <PanelLauncher badges={drawer.badges} onOpen={openPanel} />
        </div>
        <EmptyBatchHero batchName={batchName} />
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
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="text-xs text-muted">
          Drag any card between lanes to move it forward or back. Click a
          card to expand.
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
    </>
  );
}
