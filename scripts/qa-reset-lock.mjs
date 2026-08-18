#!/usr/bin/env node
/**
 * QA-lock reset tool — the escape hatch called out in
 * src/lib/qa/orchestrator.ts as a known Milestone-1 limitation.
 *
 * PROBLEM: If a node process holding a QA lock crashes / is
 * killed / hits an unhandled path, the asset row stays at
 * qaStatus=QA_RUNNING forever. Every subsequent runQaForAsset
 * throws ConcurrencyError. The orchestrator's own catch block
 * releases the lock on any handled exception, but nothing
 * outside its process can undo the stuck state.
 *
 * WHAT THIS DOES: Move a specific asset out of QA_RUNNING back
 * to NOT_QA_CHECKED so the next Run-QA call can proceed. Only
 * touches assets ACTUALLY stuck at QA_RUNNING — refuses to
 * downgrade legitimate APPROVED / REGEN_NEEDED / HUMAN_REVIEW
 * / FAILED verdicts.
 *
 * SAFETY:
 *   - Dry-run by default. --commit required to mutate.
 *   - Refuses to reset unless current qaStatus === "QA_RUNNING".
 *     Pass --any-status to override (rare — usually a mistake).
 *   - Requires explicit --asset-id and --kind. No bulk sweeps.
 *   - Does NOT touch QaAttempt history — those rows are audit.
 *
 * USAGE:
 *   node --env-file=.env scripts/qa-reset-lock.mjs \
 *     --asset-id <id> --kind <video|image>
 *
 *   Add --commit to actually reset. Add --any-status to force
 *   a reset even if the current status isn't QA_RUNNING.
 *
 * Exit codes:
 *   0 — success (dry-run or commit)
 *   1 — asset not found, or current status isn't QA_RUNNING
 *       (and --any-status not passed)
 *   2 — bad CLI args
 */

import { PrismaClient } from "@prisma/client";

function parseArgs(argv) {
  const out = { commit: false, anyStatus: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--asset-id") out.assetId = argv[++i];
    else if (a === "--kind") out.kind = argv[++i];
    else if (a === "--commit") out.commit = true;
    else if (a === "--any-status") out.anyStatus = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`
Reset a stuck QA lock so runQaForAsset can proceed.

Usage:
  node --env-file=.env scripts/qa-reset-lock.mjs \\
    --asset-id <id> --kind <video|image>

Flags:
  --asset-id <id>    FlowGeneratedVideo or FlowGeneratedImage id (required).
  --kind <k>         "video" or "image" (required).
  --commit           Actually mutate. Without this, prints the
                     plan and exits.
  --any-status       Force reset even if current qaStatus isn't
                     QA_RUNNING. Rare — the guard exists to
                     protect legitimate verdicts.
  --help, -h         This help.

The script never touches QaAttempt rows — those are audit
history. It only rewinds qaStatus on the asset itself.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  if (!args.assetId || (args.kind !== "video" && args.kind !== "image")) {
    console.error("❌ --asset-id and --kind are required.\n");
    printHelp();
    process.exit(2);
  }

  const db = new PrismaClient();
  try {
    const table = args.kind === "video"
      ? db.flowGeneratedVideo
      : db.flowGeneratedImage;
    const row = await table.findUnique({
      where: { id: args.assetId },
      select: {
        id: true,
        qaStatus: true,
        qaScore: true,
        qaCompletedAt: true,
        attemptNumber: true,
        contentRunId: true,
        sceneLabel: true,
      },
    });
    if (!row) {
      console.error(`❌ ${args.kind} not found: ${args.assetId}`);
      process.exit(1);
    }

    console.log("");
    console.log(`Asset:         ${row.id}  (${args.kind})`);
    console.log(`sceneLabel:    ${row.sceneLabel}`);
    console.log(`contentRunId:  ${row.contentRunId ?? "(none)"}`);
    console.log(`Current qaStatus:  ${row.qaStatus}`);
    console.log(`Current qaScore:   ${row.qaScore ?? "(none)"}`);
    console.log(`qaCompletedAt:     ${row.qaCompletedAt?.toISOString() ?? "(none)"}`);
    console.log(`attemptNumber:     ${row.attemptNumber}`);
    console.log("");

    if (row.qaStatus !== "QA_RUNNING" && !args.anyStatus) {
      console.error(
        `❌ Refusing to reset: current qaStatus is "${row.qaStatus}", not "QA_RUNNING". ` +
          `This asset probably has a real verdict recorded — resetting would silently erase it. ` +
          `Pass --any-status to override (rare).`,
      );
      process.exit(1);
    }

    console.log("Plan:");
    console.log(`  UPDATE FlowGenerated${args.kind === "video" ? "Video" : "Image"}`);
    console.log(`     SET qaStatus = "NOT_QA_CHECKED"`);
    console.log(`   WHERE id = "${row.id}"`);
    console.log(`     AND qaStatus = "${row.qaStatus}"    (compare-and-swap guard)`);
    console.log("");
    console.log("Note: qaAttempts history is NOT touched — audit rows stay.");

    if (!args.commit) {
      console.log("\n(dry-run — nothing written. Re-run with --commit.)");
      process.exit(0);
    }

    // Compare-and-swap so we don't race with a genuine
    // orchestrator run that happens to fire between the dry-run
    // read and the commit write.
    const updated = await table.updateMany({
      where: { id: row.id, qaStatus: row.qaStatus },
      data: { qaStatus: "NOT_QA_CHECKED" },
    });
    if (updated.count !== 1) {
      console.error(
        `❌ Update lost the race — asset's qaStatus changed between the dry-run read and the commit write. Try again.`,
      );
      process.exit(1);
    }
    console.log(`\n✅ Reset. qaStatus is now "NOT_QA_CHECKED".`);
    console.log(`   Next: ./scripts/prod-qa-smoke.sh --asset-id ${row.id} --kind ${args.kind}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("❌ Reset failed:", err);
  process.exit(1);
});
