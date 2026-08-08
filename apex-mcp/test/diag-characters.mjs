#!/usr/bin/env node
/**
 * Work out why a freshly created character does not appear in the list.
 *
 *   npm run diag:characters -- --yes
 *
 * Three candidate explanations, and this distinguishes them:
 *   a) the list is eventually consistent and just hadn't caught up
 *   b) the ref string in the list differs from the one create returned
 *      (the '-imgs:N' suffix is the prime suspect)
 *   c) the character genuinely is not being listed
 *
 * Costs one cheap image. Character create, list, and delete are free.
 * Cleans up after itself.
 */

import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

function fromEnvFile(key) {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    return new RegExp(`^${key}\\s*=\\s*(.+)$`, "m")
      .exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}
const cfg = (k, d) => process.env[k] ?? fromEnvFile(k) ?? d;

const MCP_URL = cfg("MCP_URL", `http://localhost:${cfg("PORT", "3000")}/mcp`);
const SECRET = cfg("APEX_JWT_SECRET");
const FLOW_EMAIL = cfg("FLOW_EMAIL") ?? cfg("DEFAULT_FLOW_EMAIL");
const AUTH_MODE = cfg("AUTH_MODE", "jwt");

if (!process.argv.includes("--yes")) {
  console.log(
    "\nCreates one cheap image and one character, dumps the raw list so we can\n" +
      "compare field by field, then deletes the character.\n\n" +
      "  npm run diag:characters -- --yes\n",
  );
  process.exit(0);
}

function authHeader() {
  if (AUTH_MODE === "none") return {};
  return {
    Authorization: `Bearer ${jwt.sign({ sub: "diag", flow_email: FLOW_EMAIL }, SECRET, {
      algorithm: "HS256",
      expiresIn: "15m",
    })}`,
  };
}

let id = 0;
async function callTool(name, args = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeader(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++id, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.json().catch(() => null);
  if (body?.error) return { isError: true, text: `${body.error.code}: ${body.error.message}` };
  return {
    isError: Boolean(body?.result?.isError),
    text: body?.result?.content?.[0]?.text ?? "",
    structured: body?.result?.structuredContent ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuidOf = (s) => /character:([0-9a-f-]{36})/i.exec(String(s ?? ""))?.[1] ?? null;

/* ------------------------------------------------------------------ */

console.log("1. Generating one cheap image for the character to use...");
const img = await callTool("google_flow_generate_image", {
  prompt: "a plain blue ceramic mug on a white table",
  model: "nano-banana-2-lite",
  count: 1,
});
const imageId = img.structured?.media?.[0]?.mediaGenerationId;
if (!imageId) {
  console.error("   Failed:\n" + img.text);
  process.exit(1);
}
console.log(`   ok\n`);

console.log("2. Creating a character...");
const created = await callTool("google_flow_create_character", {
  display_name: "APEX Diagnostic",
  image_references: [imageId],
  personality_notes: "temporary, safe to delete",
});
if (created.isError || !created.structured?.character) {
  console.error("   Failed:\n" + created.text);
  process.exit(1);
}
const ref = created.structured.character;
const entityId = created.structured.entityId ?? null;
console.log(`   created ref : ${ref}`);
console.log(`   entityId    : ${entityId}`);
console.log(`   uuid        : ${uuidOf(ref)}\n`);

async function inspect(label) {
  const list = await callTool("google_flow_list_characters", { response_format: "json" });
  if (list.isError) {
    console.log(`${label}: list failed — ${list.text.split("\n")[0]}`);
    return null;
  }
  const chars = list.structured?.characters ?? [];
  console.log(`${label}: ${chars.length} character(s) returned`);

  for (const c of chars) {
    console.log(`   entry: ${JSON.stringify(c).slice(0, 400)}`);
  }

  const exact = chars.some((c) => c.character === ref);
  const byUuid = chars.some((c) => uuidOf(c.character) && uuidOf(c.character) === uuidOf(ref));
  const byEntity = entityId ? chars.some((c) => c.entityId === entityId) : false;
  const byName = chars.some((c) => c.displayName === "APEX Diagnostic");

  console.log(
    `   exact ref match : ${exact}\n` +
      `   uuid match      : ${byUuid}\n` +
      `   entityId match  : ${byEntity}\n` +
      `   displayName hit : ${byName}`,
  );
  return { chars, exact, byUuid, byEntity, byName };
}

console.log("3. Listing immediately...");
const first = await inspect("   result");

console.log("\n4. Waiting 8 seconds, listing again...");
await sleep(8000);
const second = await inspect("   result");

/* ------------------------------------------------------------------ */

console.log("\n--- conclusion ---");
if (!first && !second) {
  console.log("The list endpoint itself is failing. That is the bug, not the matching.");
} else if (second?.exact) {
  console.log(
    first?.exact
      ? "Exact ref matches. The original failure was something else — rerun the feature check."
      : "EVENTUAL CONSISTENCY. Absent immediately, present after 8s. The list lags creation.",
  );
} else if (second?.byUuid || second?.byEntity || second?.byName) {
  console.log(
    "REF FORMAT MISMATCH. The character is listed, but the list's ref string differs\n" +
      "from the one create returned. Compare the two above — the '-imgs:N' suffix is\n" +
      "the likely difference. Match on the character UUID, not the whole string.",
  );
} else {
  console.log(
    "NOT LISTED AT ALL, even after 8s. The character exists (create and delete both\n" +
      "work by ref), so GET /characters is filtering it out somehow. Worth asking\n" +
      "useapi.net support about.",
  );
}

console.log("\n5. Cleaning up...");
const del = await callTool("google_flow_delete_character", { character_ref: ref });
console.log(del.isError ? `   delete failed: ${del.text.split("\n")[0]}` : "   deleted");
