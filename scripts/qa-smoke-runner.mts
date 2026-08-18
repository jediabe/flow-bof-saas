/**
 * qa-smoke-runner.mts — the TypeScript inner half of qa-smoke.mjs.
 *
 * Split out so the outer .mjs script stays plain JS (no tsx
 * bootstrap needed) while this file can `import` from
 * @/lib/qa/orchestrator via tsx's TS resolution + the project's
 * path alias.
 *
 * Not user-facing. Only invoked by qa-smoke.mjs.
 */

import { runQaForAsset } from "@/lib/qa/orchestrator";
import { QaError } from "@/lib/qa/errors";

function parseArgs(argv: string[]): { assetId?: string; kind?: string } {
  const out: { assetId?: string; kind?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--asset-id") out.assetId = argv[++i];
    else if (argv[i] === "--kind") out.kind = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.assetId || (args.kind !== "video" && args.kind !== "image")) {
    console.error(
      "Usage: qa-smoke-runner --asset-id <id> --kind <video|image>",
    );
    process.exit(2);
  }

  console.log(
    `[qa-smoke] Running QA for asset ${args.assetId} (kind=${args.kind})…`,
  );
  const started = Date.now();
  try {
    const out = await runQaForAsset({
      assetId: args.assetId,
      assetKind: args.kind as "video" | "image",
      triggeredBy: "manual",
      triggeredByUserId: null,
    });
    console.log(`[qa-smoke] ✓ completed in ${Date.now() - started} ms`);
    console.log(
      JSON.stringify(
        {
          attemptId: out.attemptId,
          assetId: out.assetId,
          assetKind: out.assetKind,
          decision: out.decision,
          qaStatus: out.qaStatus,
          overallScore: out.overallScore,
          attemptNumber: out.attemptNumber,
          reason: out.reason,
          providerModel: out.providerModel,
          orchestratorElapsedMs: out.elapsedMs,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  } catch (err) {
    console.error(`[qa-smoke] ✗ failed after ${Date.now() - started} ms`);
    if (err instanceof QaError) {
      console.error(
        JSON.stringify(
          {
            class: err.constructor.name,
            code: err.code,
            stage: err.stage,
            message: err.message,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  }
}

main();
