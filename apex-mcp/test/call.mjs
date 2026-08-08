#!/usr/bin/env node
/**
 * Call any tool from the command line, without shell quoting pain.
 *
 * curl with inline JSON is miserable on Windows cmd (no single quotes) and
 * merely annoying elsewhere. This takes key=value pairs instead:
 *
 *   npm run call -- google_flow_get_account
 *   npm run call -- google_flow_generate_image prompt="a red bicycle" count=1
 *   npm run call -- google_flow_generate_video prompt="a lighthouse" model=veo-3.1-lite
 *   npm run call -- google_flow_get_job job_id=j1731...
 *
 * Values are parsed as JSON when they look like JSON (numbers, true/false,
 * arrays, objects) and left as strings otherwise. So count=1 is a number,
 * async=false is a boolean, and reference_images=["a","b"] is an array.
 *
 * Add --json to print the raw structuredContent instead of the text.
 * Add --watch on a video call to poll the job to completion automatically.
 *
 * Reads APEX_JWT_SECRET, FLOW_EMAIL, and MCP_URL from the environment or .env.
 */

import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

function fromEnvFile(key) {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    return new RegExp(`^${key}\\s*=\\s*(.+)$`, "m")
      .exec(text)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const cfg = (key, fallback) => process.env[key] ?? fromEnvFile(key) ?? fallback;

const MCP_URL = cfg("MCP_URL", `http://localhost:${cfg("PORT", "3000")}/mcp`);
const SECRET = cfg("APEX_JWT_SECRET");
const FLOW_EMAIL = cfg("FLOW_EMAIL") ?? cfg("DEFAULT_FLOW_EMAIL");
const AUTH_MODE = cfg("AUTH_MODE", "jwt");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const rest = argv.filter((a) => !a.startsWith("--"));
const toolName = rest[0];

if (!toolName) {
  console.error(
    "Usage: npm run call -- <tool_name> [key=value ...] [--json] [--watch]\n\n" +
      "Examples:\n" +
      "  npm run call -- google_flow_get_account\n" +
      '  npm run call -- google_flow_generate_image prompt="a red bicycle" count=1\n' +
      '  npm run call -- google_flow_generate_video prompt="a lighthouse" model=veo-3.1-lite --watch\n\n' +
      "Run with no tool name after the server is up to list tools:\n" +
      "  npm run call -- --list",
  );
  if (!flags.has("--list")) process.exit(1);
}

/** key=value -> typed value. JSON-looking values are parsed as JSON. */
function parseArgs(pairs) {
  const out = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      console.error(`Ignoring '${pair}' — arguments must be key=value.`);
      continue;
    }
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/.test(raw)) {
      try {
        out[key] = JSON.parse(raw);
        continue;
      } catch {
        /* fall through to string */
      }
    }
    out[key] = raw;
  }
  return out;
}

function authHeader() {
  if (AUTH_MODE === "none") return {};
  if (!SECRET) {
    console.error("No APEX_JWT_SECRET found in the environment or .env.");
    process.exit(1);
  }
  if (!FLOW_EMAIL) {
    console.error(
      "No FLOW_EMAIL found. Set it in .env or the environment:\n" +
        "  FLOW_EMAIL=your-connected-account@gmail.com",
    );
    process.exit(1);
  }
  const token = jwt.sign({ sub: "cli", flow_email: FLOW_EMAIL }, SECRET, {
    algorithm: "HS256",
    expiresIn: "10m",
  });
  return { Authorization: `Bearer ${token}` };
}

let id = 0;
async function rpc(method, params) {
  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...authHeader(),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
  } catch (err) {
    console.error(
      `Could not reach ${MCP_URL} — is the server running?\n  ${err.message}`,
    );
    process.exit(1);
  }

  const body = await res.json().catch(() => null);
  if (!body) {
    console.error(`Non-JSON response (HTTP ${res.status}) from ${MCP_URL}.`);
    process.exit(1);
  }
  if (body.error) {
    console.error(`Error ${body.error.code}: ${body.error.message}`);
    if (body.error.data) console.error(JSON.stringify(body.error.data, null, 2));
    process.exit(1);
  }
  return body.result;
}

async function callTool(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  return {
    isError: Boolean(r?.isError),
    text: r?.content?.[0]?.text ?? "",
    structured: r?.structuredContent ?? null,
  };
}

/**
 * Ask the server which upstream it is actually using, and say so if it's fake.
 * A stale USEAPI_BASE_URL in a shell silently yields plausible-looking but
 * entirely invented data, which is otherwise very hard to spot.
 */
async function warnIfMock(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/health`);
    const h = await res.json();
    if (h?.usingMockUpstream) {
      console.error(
        `\n  !! This server is pointed at a MOCK upstream (${h.upstream}).\n` +
          `     Everything below is fake data. USEAPI_BASE_URL is set somewhere —\n` +
          `     most likely left over in the shell running the server. A shell\n` +
          `     variable overrides .env, so close that terminal and start fresh.\n`,
      );
      return true;
    }
  } catch {
    /* health is best-effort; the real call will report a connection failure */
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */

await warnIfMock(MCP_URL.replace(/\/mcp$/, ""));

if (flags.has("--list")) {
  const { tools } = await rpc("tools/list", {});
  for (const t of tools) console.log(`  ${t.name}`);
  console.log(`\n${tools.length} tools. Add key=value arguments to call one.`);
  process.exit(0);
}

const args = parseArgs(rest.slice(1));
const result = await callTool(toolName, args);

console.log(flags.has("--json") ? JSON.stringify(result.structured, null, 2) : result.text);

if (result.isError) process.exit(1);

if (flags.has("--watch") && result.structured?.jobId) {
  const jobId = result.structured.jobId;
  console.log(`\nPolling ${jobId} every 15s...`);

  for (let i = 0; i < 40; i++) {
    await sleep(15_000);
    const job = await callTool("google_flow_get_job", { job_id: jobId });
    const stamp = new Date().toISOString().slice(11, 19);

    // A failing poll used to print "?" and keep going, so a broken request
    // looked identical to a slow render for ten minutes. Stop and show why.
    if (job.isError) {
      console.error(`  [${stamp}] poll failed\n\n${job.text}\n`);
      process.exit(1);
    }

    const s = job.structured;
    if (!s) {
      console.error(
        `  [${stamp}] poll returned no structured data — this is a bug, not a slow job.\n\n` +
          `${job.text}\n`,
      );
      process.exit(1);
    }

    console.log(`  [${stamp}] ${s.status}`);
    if (s.isTerminal) {
      console.log(`\n${flags.has("--json") ? JSON.stringify(s, null, 2) : job.text}`);
      process.exit(s.status === "completed" ? 0 : 1);
    }
  }
  console.error(
    `Gave up after 10 minutes. The job never reached a terminal state.\n` +
      `Check it directly: npm run call -- google_flow_get_job job_id=${jobId}`,
  );
  process.exit(1);
}
