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

  const products: MobileProduct[] = batch.products.map((p) => ({
    id:                p.id,
    productName:       p.productName,
    tiktokUrl:         p.tiktokUrl,
    referenceImageUrl: p.referenceImageUrl,
    imageUrl:          p.imageUrl,
    category:          p.category,
    reviewStatus:      p.reviewStatus as MobileProduct["reviewStatus"],
  }));

  return (
    <MobileReviewClient
      token={token}
      batchName={batch.name}
      batchMarket={batch.market}
      products={products}
    />
  );
}
