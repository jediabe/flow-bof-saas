#!/usr/bin/env node
/**
 * Start the mock upstream and a server wired to it, in one command.
 *
 *   npm run dev:mock
 *
 * Every setting is passed to the child processes directly, so nothing leaks
 * into your shell. This exists because the previous approach — telling people
 * to `set USEAPI_BASE_URL=...` before starting the server — left that variable
 * alive in the terminal, and a shell variable silently overrides .env. The
 * result was a server that looked configured for production but was quietly
 * serving fake accounts.
 *
 * Ctrl-C stops both.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const MOCK_PORT = 4010;
const MCP_PORT = Number(process.env.PORT ?? 3000);

const children = [];
function start(label, args, env = {}) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (d) => {
      for (const line of String(d).split("\n")) {
        if (line.trim()) console.log(`[${label}] ${line}`);
      }
    });
  }
  children.push(child);
  return child;
}

function stopAll(code) {
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => {
  console.log("\nStopping.");
  stopAll(0);
});

start("mock", ["test/mock-useapi.mjs", String(MOCK_PORT)]);
start("server", ["dist/index.js"], {
  USEAPI_TOKEN: "user:0000-mock",
  USEAPI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1/google-flow`,
  AUTH_MODE: "none",
  DEFAULT_FLOW_EMAIL: "flowtester@gmail.com",
  PORT: String(MCP_PORT),
});

const deadline = Date.now() + 15_000;
let up = false;
while (Date.now() < deadline && !up) {
  await sleep(250);
  up = await fetch(`http://127.0.0.1:${MCP_PORT}/health`).then((r) => r.ok).catch(() => false);
}

if (!up) {
  console.error(
    `\nServer did not come up on port ${MCP_PORT}. Is something already using it,\n` +
      `or did you forget to run 'npm run build'?`,
  );
  stopAll(1);
}

console.log(
  `\n  Sandbox ready on http://localhost:${MCP_PORT}/mcp — all data is FAKE.\n\n` +
    `  Try, in another terminal:\n` +
    `    npm run call -- --list\n` +
    `    npm run call -- google_flow_get_account\n` +
    `    npm run call -- google_flow_generate_video prompt="a lighthouse" --watch\n\n` +
    `  Auth is disabled here, so no JWT is needed. Ctrl-C to stop.\n`,
);
