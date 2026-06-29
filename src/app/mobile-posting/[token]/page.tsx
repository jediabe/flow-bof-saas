/**
 * Phase-5 mobile posting-assist page.
 *
 * Public route, token-authenticated via the [token] URL segment.
 * Phone-first interface that surfaces each product's hook /
 * caption / hashtags / productDescription with one-tap copy
 * buttons + a status toggle (needs_posting / posted / skipped) so
 * the user can power through manual TikTok uploads from their
 * phone without re-typing the AI-generated copy.
 *
 * Like /mobile-review/[token], no session cookie required —
 * middleware.ts whitelists /mobile-posting/* in isAlwaysOpen. The
 * page renders 404 for any unknown token to avoid leaking token
 * existence.
 *
 * Eligibility filter (which products show up):
 *   - reviewStatus = "approved"   (user already triaged the product)
 *   - deletedAt   = null          (not soft-deleted)
 * That's it — we don't gate on video-generated status because the
 * user might want to start prepping their TikTok captions before
 * Flow's generation finishes. The user can also "skip" any product
 * that doesn't have a usable video yet.
 */

import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/json-column";
import MobilePostingClient, {
  type MobilePostingProduct,
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
          // New — full hook variant list so the mobile page can
          // surface every option with its own copy button. Older
          // products without variants fall back to the single
          // `hook` field below.
          hookVariants: true,
          caption: true,
          hashtags: true,
          productDescription: true,
          productLinkDescription: true,
          postingStatus: true,
          postingNotes: true,
        },
        // Land the user on the first needs_posting product so they
        // power through unposted ones first.
        orderBy: [
          { postingStatus: "asc" },
          { createdAt: "asc" },
        ],
      },
    },
  });

  if (!batch) notFound();

  const products: MobilePostingProduct[] = batch.products.map((p) => ({
    id:                p.id,
    productName:       p.productName,
    tiktokUrl:         p.tiktokUrl,
    referenceImageUrl: p.referenceImageUrl,
    imageUrl:          p.imageUrl,
    hook:              p.hook,
    // Defensive JSON parse — older rows have null hookVariants;
    // newer rows store an array of {label, text, leverName?}.
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
  }));

  return (
    <MobilePostingClient
      token={token}
      batchName={batch.name}
      batchMarket={batch.market}
      products={products}
    />
  );
}
