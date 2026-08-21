import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

function outputDirectory(argv: string[]): string {
  const index = argv.indexOf("--output-dir");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error("Usage: npm run smoke:ready-to-post -- --output-dir <persistent-directory>");
  }
  return resolve(value);
}

const outputDir = outputDirectory(process.argv.slice(2));
const localRequire = createRequire(resolve("package.json"));
const vitest = resolve(dirname(localRequire.resolve("vitest/package.json")), "vitest.mjs");
execFileSync(process.execPath, [
  vitest,
  "run",
  "src/lib/content-runs/__tests__/managed-ready-to-post.e2e.test.ts",
  "-t",
  "persists a playable offline smoke",
  "--reporter=verbose",
], {
  cwd: process.cwd(),
  env: { ...process.env, READY_TO_POST_SMOKE_OUTPUT_DIR: outputDir },
  stdio: "inherit",
});

const videoPath = resolve(outputDir, "ready-to-post-style1.mp4");
const evidencePath = resolve(outputDir, "ready-to-post-evidence.json");
if (!existsSync(videoPath) || !existsSync(evidencePath)) {
  throw new Error("Smoke test passed without preserving both required output artifacts");
}
const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
if (evidence.status !== "ready" || evidence.finalQaStatus !== "APPROVED" || evidence.networkProviderSpend !== false) {
  throw new Error("Smoke evidence does not prove an offline QA-approved READY output");
}
console.log(JSON.stringify({ outputDir, videoPath, evidencePath, sha256: evidence.sha256 }, null, 2));
