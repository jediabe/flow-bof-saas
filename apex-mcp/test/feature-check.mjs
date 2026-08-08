#!/usr/bin/env node
/**
 * Exercise the parts of the API that have never run against the real service.
 *
 *   npm run check:features           show the plan and the credit cost, run nothing
 *   npm run check:features -- --yes  actually run it
 *
 * Each step depends on the one before it, so the run stops at the first real
 * failure rather than cascading confusing errors. Anything it creates
 * (a character) is cleaned up at the end.
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

const cfg = (k, d) => process.env[k] ?? fromEnvFile(k) ?? d;

const MCP_URL = cfg("MCP_URL", `http://localhost:${cfg("PORT", "3000")}/mcp`);
const SECRET = cfg("APEX_JWT_SECRET");
const FLOW_EMAIL = cfg("FLOW_EMAIL") ?? cfg("DEFAULT_FLOW_EMAIL");
const AUTH_MODE = cfg("AUTH_MODE", "jwt");
const GO = process.argv.includes("--yes");

const PLAN = `
What this checks, in order. Each step feeds the next.

  1. Generate one image            (cheapest model)
  2. Re-resolve its download URL   (free)
  3. Re-upload it as an asset      (free)
  4. Image-to-video from it        (10 credits, veo-3.1-lite, ~2 min)
  5. List voices                   (free)
  6. Create a character from it    (free)
  7. List characters               (free)
  8. Delete that character         (free, cleanup)

Total cost: about 10 credits plus one cheap image.
Total time: about 3 minutes, most of it waiting on step 4.
`;

if (!GO) {
  console.log(PLAN);
  console.log("Nothing has run. To actually do it:\n\n  npm run check:features -- --yes\n");
  process.exit(0);
}

/* ------------------------------------------------------------------ */

function authHeader() {
  if (AUTH_MODE === "none") return {};
  if (!SECRET || !FLOW_EMAIL) {
    console.error("Set APEX_JWT_SECRET and FLOW_EMAIL in .env first.");
    process.exit(1);
  }
  return {
    Authorization: `Bearer ${jwt.sign({ sub: "featurecheck", flow_email: FLOW_EMAIL }, SECRET, {
      algorithm: "HS256",
      expiresIn: "30m",
    })}`,
  };
}

let id = 0;
async function callTool(name, args = {}) {
  let res;
  try {
    res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...authHeader(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  } catch (err) {
    return { isError: true, text: `Could not reach ${MCP_URL}: ${err.message}` };
  }
  const body = await res.json().catch(() => null);
  if (!body) return { isError: true, text: `Non-JSON response (HTTP ${res.status})` };
  if (body.error) return { isError: true, text: `${body.error.code}: ${body.error.message}` };
  return {
    isError: Boolean(body.result?.isError),
    text: body.result?.content?.[0]?.text ?? "",
    structured: body.result?.structuredContent ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let stepNo = 0;

function pass(label, detail = "") {
  results.push({ label, ok: true });
  console.log(`  [${++stepNo}] OK    ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label, detail) {
  results.push({ label, ok: false, detail });
  console.log(`  [${++stepNo}] FAIL  ${label}`);
  if (detail) console.log(`            ${String(detail).split("\n")[0].slice(0, 200)}`);
}
function skip(label, why) {
  results.push({ label, ok: null });
  console.log(`  [${++stepNo}] SKIP  ${label} — ${why}`);
}

/* ------------------------------------------------------------------ */

const health = await fetch(MCP_URL.replace(/\/mcp$/, "") + "/health")
  .then((r) => r.json())
  .catch(() => null);

if (!health) {
  console.error(`Could not reach ${MCP_URL} — is the server running?`);
  process.exit(1);
}
if (health.usingMockUpstream) {
  console.error("This server is pointed at the MOCK. Nothing here would mean anything.");
  process.exit(1);
}

console.log(`Running feature check against the live API as ${FLOW_EMAIL ?? "(account from server default)"}.\n`);

// 1 — image
let imageId = null;
let imageUrl = null;
{
  const r = await callTool("google_flow_generate_image", {
    prompt: "a plain red ceramic mug on a white table, studio lighting",
    model: "nano-banana-2-lite",
    count: 1,
  });
  const m = r.structured?.media?.[0];
  if (r.isError || !m?.mediaGenerationId) {
    fail("generate image", r.text);
  } else {
    imageId = m.mediaGenerationId;
    imageUrl = m.url ?? null;
    pass("generate image", imageId.slice(0, 46) + "...");
  }
}

// 2 — re-resolve its URL
if (!imageId) skip("re-resolve asset URL", "no image to resolve");
else {
  const r = await callTool("google_flow_get_asset", { media_generation_id: imageId });
  if (r.isError || !r.structured?.url) fail("re-resolve asset URL", r.text);
  else pass("re-resolve asset URL");
}

// 3 — upload
if (!imageUrl) skip("upload asset", "image returned no URL to re-upload");
else {
  const r = await callTool("google_flow_upload_asset", { source_url: imageUrl });
  if (r.isError || !r.structured?.mediaGenerationId) fail("upload asset", r.text);
  else pass("upload asset", `${r.structured.width}x${r.structured.height}`);
}

// 4 — image-to-video, the main event
if (!imageId) skip("image-to-video", "no start frame available");
else {
  const sub = await callTool("google_flow_generate_video", {
    prompt: "slow push in toward the mug, steam begins to rise",
    model: "veo-3.1-lite",
    duration: 8,
    start_image: imageId,
  });

  const jobId = sub.structured?.jobId;
  if (sub.isError || !jobId) {
    fail("image-to-video submit", sub.text);
  } else {
    pass("image-to-video submit", jobId.slice(0, 30) + "...");
    process.stdout.write("            polling");

    let done = null;
    for (let i = 0; i < 24; i++) {
      await sleep(15_000);
      const job = await callTool("google_flow_get_job", { job_id: jobId });
      if (job.isError) {
        console.log("");
        fail("image-to-video poll", job.text);
        done = "error";
        break;
      }
      process.stdout.write(".");
      if (job.structured?.isTerminal) {
        console.log("");
        if (job.structured.status === "completed" && job.structured.media?.[0]?.url) {
          pass("image-to-video complete", job.structured.media[0].url.slice(0, 60) + "...");
        } else {
          fail("image-to-video complete", job.structured.error ?? job.structured.status);
        }
        done = "terminal";
        break;
      }
    }
    if (!done) {
      console.log("");
      fail("image-to-video complete", "still running after 6 minutes");
    }
  }
}

// 5 — voices
{
  const r = await callTool("google_flow_list_voices");
  if (r.isError) fail("list voices", r.text);
  else pass("list voices", `${r.structured?.count ?? 0} available`);
}

// 6/7/8 — characters
let charRef = null;
if (!imageId) skip("create character", "no image available");
else {
  const r = await callTool("google_flow_create_character", {
    display_name: "APEX Feature Check",
    image_references: [imageId],
    personality_notes: "temporary, created by the feature check script",
  });
  if (r.isError || !r.structured?.character) fail("create character", r.text);
  else {
    charRef = r.structured.character;
    pass("create character", charRef);
  }
}

if (!charRef) skip("list characters", "nothing created");
else {
  const r = await callTool("google_flow_list_characters");
  // Refs carry a trailing '-imgs:N' that the list may omit, so compare the
  // stable UUID rather than the whole string.
  const uuid = (s) => /character:([0-9a-f-]{36})/i.exec(String(s ?? ""))?.[1] ?? null;
  const want = uuid(charRef);
  const found = r.structured?.characters?.some(
    (c) => c.character === charRef || (want && uuid(c.character) === want),
  );
  if (r.isError) fail("list characters", r.text);
  else if (!found) fail("list characters", "the character just created is not in the list");
  else pass("list characters", `${r.structured.count} total`);
}

if (!charRef) skip("delete character", "nothing to clean up");
else {
  const r = await callTool("google_flow_delete_character", { character_ref: charRef });
  if (r.isError) fail("delete character", r.text);
  else pass("delete character", "cleaned up");
}

/* ------------------------------------------------------------------ */

const ok = results.filter((r) => r.ok === true).length;
const bad = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === null).length;

console.log(
  `\n${ok} passed, ${bad.length} failed${skipped ? `, ${skipped} skipped` : ""}.`,
);

if (bad.length) {
  console.log("\nFailed:");
  for (const b of bad) console.log(`  - ${b.label}`);
  console.log("\nPaste this output back and I can tell you what each one means.");
}
process.exit(bad.length ? 1 : 0);
