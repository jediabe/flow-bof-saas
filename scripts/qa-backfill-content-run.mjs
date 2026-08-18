#!/usr/bin/env node
/**
 * Milestone 1 Phase C — ONE-OFF ContentRun backfill for the
 * "we just generated a Style 1 batch and want to run QA against
 * those specific videos" scenario.
 *
 * NOT the permanent integration. Every new Style 1 generation
 * SHOULD create its ContentRun at the orchestration boundary
 * (chat-agent turn start) and propagate the id through
 * subsequent local_save_generated_video calls. That wiring is
 * still open — this script is a bridge to unblock Phase C
 * smoke testing against existing legacy rows.
 *
 * SAFETY:
 *   - Dry-run by DEFAULT. --commit required to mutate.
 *   - Refuses to attach a row that already has a contentRunId
 *     (idempotent — a second --commit against the same target
 *     is a no-op unless --force is passed).
 *   - Requires an explicit --product-id or --video-id target.
 *     No batch-wide, no workspace-wide, no "any legacy row"
 *     sweeps.
 *   - Filters candidates by a time window (--window-hours,
 *     default 6) so we don't accidentally sweep old rows for
 *     the same product.
 *
 * USAGE:
 *   node --env-file=.env scripts/qa-backfill-content-run.mjs \
 *     --product-id <id>
 *   # OR
 *   node --env-file=.env scripts/qa-backfill-content-run.mjs \
 *     --video-id <id>
 *
 *   Adds --commit to actually write. Add --label "..." to set
 *   the ContentRun.label (default "Phase C smoke backfill").
 *   Add --window-hours 6 to widen/narrow the "recent" filter.
 *
 * Exit codes:
 *   0 — success (dry-run or commit)
 *   1 — validation failure (missing arg, no candidates, already
 *       attached without --force, product not found, etc.)
 *   2 — bad CLI args
 */

import { PrismaClient } from "@prisma/client";

// -----------------------------------------------------------------
// Args
// -----------------------------------------------------------------
function parseArgs(argv) {
  const out = { commit: false, force: false, windowHours: 6, label: "Phase C smoke backfill" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--product-id") out.productId = argv[++i];
    else if (a === "--video-id") out.videoId = argv[++i];
    else if (a === "--commit") out.commit = true;
    else if (a === "--force") out.force = true;
    else if (a === "--window-hours") out.windowHours = Number.parseInt(argv[++i], 10);
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`
Backfill a ContentRun onto recently-generated Style 1 assets so
Phase C's QA orchestrator can evaluate them.

Usage:
  node --env-file=.env scripts/qa-backfill-content-run.mjs \\
    --product-id <id> [--commit] [--label <text>] [--window-hours <n>]

  # OR provide one video-id and we'll infer the product:
  node --env-file=.env scripts/qa-backfill-content-run.mjs \\
    --video-id <id> [--commit] [--label <text>] [--window-hours <n>]

Flags:
  --product-id <id>      Target Product. All its unattached recent
                         videos + images become the run.
  --video-id <id>        Alternative to --product-id — infers the
                         product from this video row.
  --commit               Actually mutate. Without this, prints
                         the plan and exits.
  --force                Attach even if some candidates already
                         have a contentRunId (usually a mistake).
  --label <text>         ContentRun.label. Default: "Phase C
                         smoke backfill".
  --window-hours <n>     Only videos/images created within the
                         last N hours become candidates. Default 6.
                         Set higher if the batch is older.
  --help, -h             This help.

The script prints the plan first, then either exits (dry-run)
or executes it (--commit).
`);
}

// -----------------------------------------------------------------
// Main
// -----------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  if (!args.productId && !args.videoId) {
    console.error("❌ One of --product-id or --video-id is required.\n");
    printHelp();
    process.exit(2);
  }
  if (!Number.isFinite(args.windowHours) || args.windowHours <= 0) {
    console.error("❌ --window-hours must be a positive number.");
    process.exit(2);
  }

  const db = new PrismaClient();
  try {
    // Resolve productId from --video-id if that's what we got.
    let productId = args.productId;
    if (!productId) {
      const v = await db.flowGeneratedVideo.findUnique({
        where: { id: args.videoId },
        select: { id: true, productId: true },
      });
      if (!v) {
        console.error(`❌ FlowGeneratedVideo not found: ${args.videoId}`);
        process.exit(1);
      }
      productId = v.productId;
      console.log(`▶ Inferred productId ${productId} from --video-id ${args.videoId}`);
    }

    // Load the product + batch + workspace for market/discount context.
    const product = await db.product.findUnique({
      where: { id: productId },
      include: {
        batch: { select: { id: true, name: true, market: true, workspaceId: true } },
      },
    });
    if (!product) {
      console.error(`❌ Product not found: ${productId}`);
      process.exit(1);
    }

    const cutoff = new Date(Date.now() - args.windowHours * 60 * 60 * 1000);
    const videos = await db.flowGeneratedVideo.findMany({
      where: {
        productId,
        deletedAt: null,
        createdAt: { gte: cutoff },
      },
      select: {
        id: true,
        sceneLabel: true,
        mediaGenerationId: true,
        imageMediaGenerationId: true,
        createdAt: true,
        contentRunId: true,
        attemptNumber: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const images = await db.flowGeneratedImage.findMany({
      where: {
        productId,
        deletedAt: null,
        createdAt: { gte: cutoff },
      },
      select: {
        id: true,
        sceneLabel: true,
        mediaGenerationId: true,
        createdAt: true,
        contentRunId: true,
        attemptNumber: true,
      },
      orderBy: { createdAt: "asc" },
    });

    console.log("");
    console.log(`Product:  ${product.productName}  [${productId}]`);
    console.log(`Batch:    ${product.batch?.name ?? "?"}  [${product.batch?.id ?? "?"}]`);
    console.log(`Market:   ${product.market ?? product.batch?.market ?? "?"}`);
    console.log(`Category: ${product.category ?? "(unset)"}`);
    console.log(`Window:   last ${args.windowHours}h  (createdAt >= ${cutoff.toISOString()})`);
    console.log("");
    console.log(`Videos in window: ${videos.length}`);
    for (const v of videos) {
      const flag = v.contentRunId ? `  ⚠ already attached to run ${v.contentRunId}` : "";
      console.log(
        `  • ${v.id}  scene=${v.sceneLabel}  mgen=${v.mediaGenerationId}  attempt=${v.attemptNumber}  createdAt=${v.createdAt.toISOString()}${flag}`,
      );
    }
    console.log("");
    console.log(`Images in window: ${images.length}`);
    for (const im of images) {
      const flag = im.contentRunId ? `  ⚠ already attached to run ${im.contentRunId}` : "";
      console.log(
        `  • ${im.id}  scene=${im.sceneLabel}  mgen=${im.mediaGenerationId}  attempt=${im.attemptNumber}  createdAt=${im.createdAt.toISOString()}${flag}`,
      );
    }

    if (videos.length === 0 && images.length === 0) {
      console.log("\nNothing to backfill. Widen --window-hours or double-check --product-id.");
      process.exit(1);
    }

    const alreadyAttached = [
      ...videos.filter((v) => v.contentRunId),
      ...images.filter((im) => im.contentRunId),
    ];
    if (alreadyAttached.length > 0 && !args.force) {
      console.log(
        `\n⚠ ${alreadyAttached.length} candidate(s) already have a contentRunId. ` +
          `Refusing to overwrite. Re-run with --force to include them anyway ` +
          `(they will be REASSIGNED to the new run), or narrow --product-id / --window-hours to exclude them.`,
      );
      process.exit(1);
    }

    // Effective attach set — everything we'd mutate on --commit.
    const attachVideos = args.force ? videos : videos.filter((v) => !v.contentRunId);
    const attachImages = args.force ? images : images.filter((im) => !im.contentRunId);

    // Discount snapshot from Product (frozen at run-creation time
    // per the ContentRun schema semantics).
    const discountPercent =
      typeof product.discountPercent === "number" ? product.discountPercent : null;
    const discountType = product.discountType ?? null;
    const market = product.market ?? product.batch?.market ?? null;

    console.log("");
    console.log("Plan:");
    console.log(`  create ContentRun {`);
    console.log(`    productId:       ${productId}`);
    console.log(`    style:           "style1"`);
    console.log(`    market:          ${JSON.stringify(market)}`);
    console.log(`    status:          "generating"  (will bump to "ready" / "human_review" post-QA)`);
    console.log(`    promptSnapshotJson: null   (chat agent didn't emit a persistent prompt kit; see report)`);
    console.log(`    discountPercent: ${discountPercent === null ? "null" : discountPercent}`);
    console.log(`    discountType:    ${JSON.stringify(discountType)}`);
    console.log(`    label:           ${JSON.stringify(args.label)}`);
    console.log(`  }`);
    console.log(`  attach ${attachVideos.length} video(s) + ${attachImages.length} image(s) to this run.`);

    if (!market) {
      console.log("\n⚠ Warning: market is null on both Product and Batch. Setting run.market to \"uk\" as fallback.");
    }

    if (!args.commit) {
      console.log("\n(dry-run — nothing written. Re-run with --commit to execute.)");
      process.exit(0);
    }

    // Actually mutate — one transaction.
    const runMarket = market ?? "uk";
    const result = await db.$transaction(async (tx) => {
      const run = await tx.contentRun.create({
        data: {
          productId,
          style: "style1",
          market: runMarket,
          status: "generating",
          promptSnapshotJson: null,
          discountPercent,
          discountType,
          label: args.label,
        },
        select: { id: true, createdAt: true },
      });
      if (attachVideos.length > 0) {
        await tx.flowGeneratedVideo.updateMany({
          where: { id: { in: attachVideos.map((v) => v.id) } },
          data: { contentRunId: run.id },
        });
      }
      if (attachImages.length > 0) {
        await tx.flowGeneratedImage.updateMany({
          where: { id: { in: attachImages.map((im) => im.id) } },
          data: { contentRunId: run.id },
        });
      }
      return run;
    });

    console.log("");
    console.log("✅ Committed.");
    console.log(`   ContentRun id: ${result.id}`);
    console.log(`   Created at:    ${result.createdAt.toISOString()}`);
    console.log(`   Attached:      ${attachVideos.length} video(s), ${attachImages.length} image(s)`);
    if (attachVideos.length > 0) {
      console.log("\nNext: run QA on one of these video IDs, e.g.");
      console.log(`  ./scripts/prod-qa-smoke.sh --asset-id ${attachVideos[0].id} --kind video`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});
