#!/usr/bin/env node
/**
 * One-shot backfill — Product.referenceImageUrl → ProductImage(primary).
 *
 * Phase 3 introduced the ProductImage table (one row per reference
 * image, up to three roles per product: primary / ref2 / ref3). The
 * existing Product.referenceImageUrl and Product.referenceImagePathLocal
 * fields are kept as a denormalised cache of the primary ProductImage
 * row, but EXISTING products in the DB pre-date Phase 3 — they have
 * the legacy fields set but no ProductImage row.
 *
 * This script walks every Product that has a referenceImageUrl (or a
 * referenceImagePathLocal) and ensures a ProductImage(role="primary")
 * row exists for it. Idempotent — safe to re-run; upsert handles the
 * "already backfilled" case.
 *
 * Run on:
 *   - local dev (sqlite):  npm run backfill:product-images
 *   - prod (postgres):     SSH to VPS, cd to project, then run
 *                          `./scripts/prod-db-push.sh` first, then
 *                          `docker compose ... exec app node
 *                          scripts/backfill-product-images.mjs`
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

let total = 0;
let created = 0;
let already = 0;
let skipped = 0;

try {
  const products = await db.product.findMany({
    where: {
      OR: [
        { referenceImageUrl: { not: null } },
        { referenceImagePathLocal: { not: null } },
      ],
    },
    select: {
      id: true,
      referenceImageUrl: true,
      referenceImagePathLocal: true,
      images: { where: { role: "primary" }, select: { id: true } },
    },
  });
  total = products.length;
  console.log(`Found ${total} products with legacy reference fields.`);

  for (const p of products) {
    if (p.images.length > 0) {
      already += 1;
      continue;
    }
    if (!p.referenceImageUrl && !p.referenceImagePathLocal) {
      skipped += 1;
      continue;
    }
    await db.productImage.create({
      data: {
        productId: p.id,
        role: "primary",
        url: p.referenceImageUrl,
        pathLocal: p.referenceImagePathLocal,
        // Best guess: anything with a /uploads/ URL came from Kalodata
        // (the only path that wrote referenceImageUrl in alpha-1).
        // Anything path-only is a manual override.
        source:
          p.referenceImageUrl?.startsWith("/uploads/")
            ? "kalodata"
            : "upload",
      },
    });
    created += 1;
  }

  console.log("---");
  console.log(`Created   : ${created} new ProductImage(primary) rows`);
  console.log(`Existed   : ${already} products already had one`);
  console.log(`Skipped   : ${skipped} products with no legacy fields`);
  console.log(`Total seen: ${total}`);
} catch (err) {
  console.error("Backfill failed:", err);
  process.exit(1);
} finally {
  await db.$disconnect();
}
