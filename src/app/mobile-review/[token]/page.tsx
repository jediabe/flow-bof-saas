/**
 * Phase-4 mobile product-review page.
 *
 * Public route, token-authenticated via the [token] URL segment.
 * Anyone with the link can review every product in the matching
 * batch. Used by the batch owner to triage products on their
 * phone (e.g. confirm TikTok Shop links still resolve / products
 * are still in stock) before burning AI / Flow credits on duds.
 *
 * No session cookie required — middleware.ts whitelists
 * /mobile-review/* in isAlwaysOpen. The page renders 404 on
 * any unknown token so a stolen-token holder can't probe.
 */

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import MobileReviewClient, {
  type MobileProduct,
} from "./MobileReviewClient";

export const dynamic = "force-dynamic";

export default async function MobileReviewPage({
  params,
}: {
  // Next.js 15 — params is async.
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token || token.length < 16) {
    // Refuse short / obviously-wrong tokens up front so we don't
    // even hit the DB. 16 chars is well below our 43-char minted
    // length but a useful no-op floor.
    notFound();
  }

  const batch = await db.batch.findUnique({
    where: { reviewToken: token },
    select: {
      id: true,
      name: true,
      market: true,
      workspaceId: true,
      products: {
        where: { deletedAt: null },
        select: {
          id: true,
          productName: true,
          tiktokUrl: true,
          referenceImageUrl: true,
          imageUrl: true,
          category: true,
          reviewStatus: true,
          // Phase 9 — surface IP risk on the mobile review page so
          // reviewers can see the verdict and react appropriately.
          // High-risk products default to Reject in the client UI.
          ipRiskStatus: true,
          ipRiskReasons: true,
          ipRiskOverride: true,
          // TikTok Shop discount % captured on a prior visit. The
          // input on the mobile card seeds from this so a reviewer
          // returning to an already-approved product sees what
          // they typed last time.
          discountPercent: true,
        },
        orderBy: [
          // Push needs_review to the top so the user lands on
          // unresolved products first; resolved ones (approved /
          // rejected / maybe) are reachable via the back button.
          { reviewStatus: "asc" },
          { createdAt: "asc" },
        ],
      },
    },
  });

  if (!batch) {
    // Same notFound response for unknown-token + expired-token
    // (we don't have expiry yet, but design space is consistent).
    // Avoids leaking which tokens have ever existed.
    notFound();
  }

  // Honour the workspace's IP-risk-checks toggle. When disabled,
  // project every product's ipRiskStatus down to "low" so the
  // mobile reviewer doesn't see warning chips for a feature the
  // owner has opted out of.
  const wsSettings = await db.workspaceSettings.findUnique({
    where: { workspaceId: batch.workspaceId },
    select: { ipRiskChecksEnabled: true },
  });
  const ipRiskChecksEnabled = wsSettings?.ipRiskChecksEnabled ?? false;

  // Decode Phase 9 IP risk reasons (JSON-encoded string[] in SQLite)
  // so the client component sees a clean array. Defensive parse
  // handles malformed JSON without breaking the page.
  const products: MobileProduct[] = batch.products.map((p) => {
    let reasons: string[] = [];
    if (p.ipRiskReasons) {
      try {
        const decoded = JSON.parse(p.ipRiskReasons);
        if (Array.isArray(decoded)) {
          reasons = decoded.filter((r) => typeof r === "string");
        }
      } catch {
        // Stale or malformed JSON — surface no reasons rather than crash
      }
    }
    return {
      id:                p.id,
      productName:       p.productName,
      tiktokUrl:         p.tiktokUrl,
      referenceImageUrl: p.referenceImageUrl,
      imageUrl:          p.imageUrl,
      category:          p.category,
      reviewStatus:      p.reviewStatus as MobileProduct["reviewStatus"],
      ipRiskStatus:      (ipRiskChecksEnabled
        ? p.ipRiskStatus
        : "low") as MobileProduct["ipRiskStatus"],
      ipRiskReasons:     ipRiskChecksEnabled ? reasons : [],
      ipRiskOverride:    p.ipRiskOverride,
      discountPercent:   p.discountPercent ?? null,
    };
  });

  return (
    <MobileReviewClient
      token={token}
      batchName={batch.name}
      batchMarket={batch.market}
      products={products}
    />
  );
}
