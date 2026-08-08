/**
 * One-shot runner: starts the mock upstream and the MCP server, runs the
 * driver, then tears everything down. `npm run test:e2e`.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const MOCK_PORT = 4010;
const MCP_PORT = 3200;
const SECRET = "testsecrettestsecrettestsecret1234";
const SERVICE_KEY = "test-admin-key-abcdefghij";

const children = [];
function start(label, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => {
    const line = String(d).trim();
    if (line) console.error(`[${label}] ${line}`);
  });
  children.push(child);
  return child;
}

function cleanup(code) {
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

start("mock", "node", ["test/mock-useapi.mjs", String(MOCK_PORT)]);
start("server", "node", ["dist/index.js"], {
  USEAPI_TOKEN: "user:12345-testtoken",
  USEAPI_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1/google-flow`,
  AUTH_MODE: "jwt",
  APEX_JWT_SECRET: SECRET,
  APEX_SERVICE_KEY: SERVICE_KEY,
  PORT: String(MCP_PORT),
});

// Wait for the server to accept connections rather than guessing at a delay.
const deadline = Date.now() + 15_000;
let up = false;
while (Date.now() < deadline && !up) {
  await sleep(250);
  up = await fetch(`http://127.0.0.1:${MCP_PORT}/health`).then((r) => r.ok).catch(() => false);
}
if (!up) {
  console.error("Server did not come up within 15s.");
  cleanup(1);
}

const driver = start("drive", "node", ["test/drive.mjs", `http://127.0.0.1:${MCP_PORT}/mcp`], {
  APEX_JWT_SECRET: SECRET,
  APEX_SERVICE_KEY: SERVICE_KEY,
});
driver.stdout.pipe(process.stdout);
driver.on("exit", (code) => cleanup(code ?? 1));
