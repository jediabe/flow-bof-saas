#!/usr/bin/env node
/**
 * Manual QA smoke test — NOT run by `npm test`, NOT invoked by
 * any user-facing flow. This exists so a developer can exercise
 * the FULL Phase C pipeline (MCP get_asset → ffmpeg → real
 * Anthropic call → decision engine → DB write) end-to-end
 * against one real asset without wiring up the Phase E UI.
 *
 * USAGE (from repo root, with .env populated):
 *
 *   node --env-file=.env scripts/qa-smoke.mjs --asset-id <id> --kind <video|image>
 *
 * Preconditions:
 *   - The asset row must exist AND have a contentRunId set
 *     (M1 requires ContentRun membership).
 *   - Its workspace must have a valid Anthropic API key in
 *     WorkspaceSettings.
 *   - Its workspace's flowEmail must be set so mcpGetAssetUrl
 *     can resolve the media.
 *   - ffmpeg + ffprobe must be on PATH (or FFMPEG_PATH /
 *     FFPROBE_PATH env vars set to their absolute locations).
 *
 * What it does:
 *   - Loads the asset (fails cleanly if legacy).
 *   - Runs runQaForAsset() once.
 *   - Prints the outcome — decision, score, reason, timings,
 *     provider used, attempt row id.
 *   - EXITS with code 0 on success, 1 on any thrown QaError.
 *
 * What it does NOT do:
 *   - Repair anything.
 *   - Regenerate anything.
 *   - Loop / retry.
 *   - Print the frames (they're base64 blobs; add a --dump-frames
 *     flag later if you want them saved to disk for eyeballing).
 *
 * The script uses tsx so it can import TypeScript modules
 * directly:
 *   npx tsx scripts/qa-smoke.mjs --asset-id ... --kind ...
 *
 * (Yes it's a .mjs — tsx respects the module system regardless
 *  and this file is deliberately outside the Next.js build.)
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--asset-id") out.assetId = argv[++i];
    else if (arg === "--kind") out.kind = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`
Manual QA smoke test.

Usage:
  node --env-file=.env scripts/qa-smoke.mjs --asset-id <id> --kind <video|image>

Flags:
  --asset-id   FlowGeneratedVideo/Image row id (required)
  --kind       "video" or "image" (required)
  --help, -h   Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.assetId || !args.kind) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }
  if (args.kind !== "video" && args.kind !== "image") {
    console.error(`--kind must be "video" or "image" (got: ${args.kind})`);
    process.exit(2);
  }

  // Delegate to tsx so we can import the TypeScript orchestrator.
  const here = dirname(fileURLToPath(import.meta.url));
  const runnerPath = resolve(here, "qa-smoke-runner.mts");
  const result = spawnSync(
    "npx",
    ["tsx", runnerPath, "--asset-id", args.assetId, "--kind", args.kind],
    {
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
