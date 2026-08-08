#!/usr/bin/env node
/**
 * Runs before `npm run build`. Turns "'tsc' is not recognized" — which sounds
 * like a broken machine — into a sentence that says what to do.
 *
 * Two ways to arrive here with no compiler: never running `npm install`, or
 * running it with NODE_ENV=production, which silently skips devDependencies
 * and leaves you with a node_modules that looks complete but has no TypeScript.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasModules = existsSync(join(root, "node_modules"));
const hasTypeScript = existsSync(join(root, "node_modules", "typescript"));

if (hasTypeScript) process.exit(0);

const bar = "-".repeat(70);

if (!hasModules) {
  console.error(
    `\n${bar}\n` +
      `  Dependencies are not installed yet.\n\n` +
      `  Run this first:\n` +
      `      npm install\n\n` +
      `  Then:\n` +
      `      npm run build\n` +
      `${bar}\n`,
  );
} else {
  console.error(
    `\n${bar}\n` +
      `  node_modules exists, but TypeScript is missing from it.\n\n` +
      `  That happens when npm install runs with NODE_ENV=production, which\n` +
      `  skips devDependencies. Check with:\n` +
      `      echo %NODE_ENV%        (cmd)\n` +
      `      echo $env:NODE_ENV     (PowerShell)\n\n` +
      `  Then reinstall including dev dependencies:\n` +
      `      npm install --include=dev\n` +
      `${bar}\n`,
  );
}

process.exit(1);
