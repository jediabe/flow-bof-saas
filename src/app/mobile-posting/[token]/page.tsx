/**
 * Phase-5 mobile posting-assist page — reshaped around the Style 1
 * (Store Discovery) video kit.
 *
 * Public route, token-authenticated via the [token] URL segment.
 * Phone-first interface. Products with a Style 1 kit render as a
 * top-to-bottom checklist (Flow agent script → voice → 3-part
 * copy → hashtags → posting reminders). Legacy pre-Style-1
 * products fall back to the old hook/caption/hashtags UI.
 *
 * No session cookie required — middleware.ts whitelists
 * /mobile-posting/* in isAlwaysOpen. Renders 404 for any unknown
 * token to avoid leaking token existence.
 *
 * Eligibility filter (which products show up):
 *   - reviewStatus = "approved"   (user already triaged)
 *   - deletedAt   = null          (not soft-deleted)
 * We do NOT gate on video-generated status — the operator might
 * want to start prepping their TikTok captions before Flow's
 * generation finishes. Skip any product without a usable video.
 */

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json-column";
import MobilePostingClient, {
  type MobilePostingProduct,
  type WorkspaceVoicesForPosting,
} from "./MobilePostingClient";

export const dynamic = "force-dynamic";

export default async function MobilePostingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token || token.length < 16) notFound();

  const batch = await db.batch.findUnique({
    where: { postingToken: token },
    select: {
      id: true,
      name: true,
      market: true,
      workspaceId: true,
      products: {
        where: {
          deletedAt:    null,
          reviewStatus: "approved",
        },
        select: {
          id: true,
          productName: true,
          tiktokUrl: true,
          referenceImageUrl: true,
          imageUrl: true,
          hook: true,
          hookVariants: true,
          caption: true,
          hashtags: true,
          productDescription: true,
          productLinkDescription: true,
          postingStatus: true,
          postingNotes: true,
          // Style 1 additions — full kit + per-part picks +
          // discount % so the checklist can show real numbers in
          // its section labels.
          discountPercent: true,
          style1Kit: true,
          chosenCopyPart1: true,
          chosenCopyPart2: true,
          chosenCopyPart3: true,
          // Commit 7 — videos the /generate agent saved for this
          // product. mediaGenerationId is stable; we mint a
          // fresh signed URL below via MCP get_asset (URLs expire
          // in ~6h).
          flowGeneratedVideos: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              sceneLabel: true,
              mediaGenerationId: true,
              prompt: true,
              notes: true,
              createdAt: true,
            },
          },
        },
        orderBy: [
          { postingStatus: "asc" },
          { createdAt: "asc" },
        ],
      },
    },
  });

  if (!batch) notFound();

  // Workspace external-tool references — reminder-only. The
  // Style 1 checklist renders these where relevant:
  //   voice IDs/labels    → "paste script into voice: <label>"
  //   CapCut template URL → "Open CapCut template" button
  // Never used to hit any external API; the operator generates
  // audio + edits video themselves.
  const ws = await db.workspaceSettings.findUnique({
    where: { workspaceId: batch.workspaceId },
    select: {
      elevenLabsVoiceIdUk: true,
      elevenLabsVoiceLabelUk: true,
      elevenLabsVoiceIdUs: true,
      elevenLabsVoiceLabelUs: true,
      capCutTemplateUrl: true,
    },
  });
  const voices: WorkspaceVoicesForPosting = {
    ukVoiceId:    ws?.elevenLabsVoiceIdUk    ?? null,
    ukVoiceLabel: ws?.elevenLabsVoiceLabelUk ?? null,
    usVoiceId:    ws?.elevenLabsVoiceIdUs    ?? null,
    usVoiceLabel: ws?.elevenLabsVoiceLabelUs ?? null,
    capCutTemplateUrl: ws?.capCutTemplateUrl ?? null,
  };

  // ── Fresh-URL fanout for /generate-produced videos ────────────
  // Flow signed URLs expire in ~6h; the mediaGenerationId is
  // stable. On every page load we re-mint fresh URLs via MCP so
  // the operator never sees a broken link.
  //
  // Runs only when the workspace has both a bound flowEmail AND
  // at least one product with saved videos — no wasted MCP calls
  // for workspaces that haven't started using /generate.
  const flowEmail = (
    await db.workspaceSettings.findUnique({
      where: { workspaceId: batch.workspaceId },
      select: { flowEmail: true },
    })
  )?.flowEmail ?? null;

  const allVideos = batch.products.flatMap((p) => p.flowGeneratedVideos);
  const urlByMediaId = new Map<string, string | null>();
  if (flowEmail && allVideos.length > 0) {
    const { mcpGetAssetUrl } = await import("@/lib/apex-mcp");
    // Parallel with a reasonable concurrency cap. 8 in flight
    // covers a typical 30-product batch with 2 videos/product
    // fast without hammering the MCP. Bumps to full parallel
    // for smaller batches.
    const uniqueIds = Array.from(
      new Set(allVideos.map((v) => v.mediaGenerationId)),
    );
    const CONCURRENCY = 8;
    let cursor = 0;
    async function worker() {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= uniqueIds.length) return;
        const id = uniqueIds[i];
        const url = await mcpGetAssetUrl({
          sub: batch!.workspaceId,
          flowEmail: flowEmail!,
          mediaGenerationId: id,
        });
        urlByMediaId.set(id, url);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, uniqueIds.length) }, () =>
        worker(),
      ),
    );
  }

  const products: MobilePostingProduct[] = batch.products.map((p) => ({
    id:                p.id,
    productName:       p.productName,
    tiktokUrl:         p.tiktokUrl,
    referenceImageUrl: p.referenceImageUrl,
    imageUrl:          p.imageUrl,
    hook:              p.hook,
    hookVariants:
      (parseJson(p.hookVariants) as Array<{
        label: string;
        text: string;
        leverName?: string;
      }> | null) ?? [],
    caption:           p.caption,
    hashtags:          (parseJson(p.hashtags) as string[] | null) ?? [],
    productDescription:     p.productDescription,
    productLinkDescription: p.productLinkDescription,
    postingStatus:     p.postingStatus as MobilePostingProduct["postingStatus"],
    postingNotes:      p.postingNotes,
    discountPercent:   p.discountPercent ?? null,
    // Raw JSON blob — client uses parseStyle1Kit to decode.
    style1Kit:         p.style1Kit ?? null,
    chosenCopyPart1:   p.chosenCopyPart1 ?? null,
    chosenCopyPart2:   p.chosenCopyPart2 ?? null,
    chosenCopyPart3:   p.chosenCopyPart3 ?? null,
    generatedVideos:   p.flowGeneratedVideos.map((v) => ({
      id:                v.id,
      sceneLabel:        v.sceneLabel,
      mediaGenerationId: v.mediaGenerationId,
      prompt:            v.prompt,
      notes:             v.notes,
      createdAt:         v.createdAt.toISOString(),
      // Fresh signed URL from the parallel fanout above; null
      // when MCP couldn't resolve it (asset deleted, MCP down,
      // 596 broken session). The UI renders an "URL unavailable
      // — retry" affordance for null entries.
      url:               urlByMediaId.get(v.mediaGenerationId) ?? null,
    })),
  }));

  return (
    <MobilePostingClient
      token={token}
      batchName={batch.name}
      batchMarket={batch.market}
      products={products}
      voices={voices}
    />
  );
}
