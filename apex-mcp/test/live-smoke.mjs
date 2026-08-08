/**
 * Read-only smoke test against the REAL api.useapi.net.
 *
 * Costs zero credits: it only calls get_account, list_voices, and
 * list_characters, and never generates anything. Run this first with a real
 * token to confirm the token, the connected account, and the whole request
 * path work before you spend anything.
 *
 * Start the server pointed at the real API (no USEAPI_BASE_URL), then:
 *   FLOW_EMAIL=your-account@gmail.com node test/live-smoke.mjs
 */

import jwt from "jsonwebtoken";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3000/mcp";
const SECRET = process.env.APEX_JWT_SECRET;
const FLOW_EMAIL = process.env.FLOW_EMAIL;

const health = await fetch(MCP_URL.replace(/\/mcp$/, "") + "/health")
  .then((r) => r.json())
  .catch(() => null);

if (!health) {
  console.error(`Could not reach ${MCP_URL} — is the server running?`);
  process.exit(1);
}
if (health.usingMockUpstream) {
  console.error(
    `This server is pointed at a MOCK upstream (${health.upstream}), so a "live"\n` +
      `check would prove nothing. USEAPI_BASE_URL is set — most likely left over\n` +
      `in the shell running the server. Close that terminal, open a new one, and\n` +
      `start the server again.`,
  );
  process.exit(1);
}

// Name the variable that's actually missing. "Set A and B" when only B is
// missing sends people to re-check A, which was fine all along.
const missing = [
  !SECRET && {
    name: "APEX_JWT_SECRET",
    hint: "The same value the server is running with. Generate one with 'npm run secrets' if you have none.",
  },
  !FLOW_EMAIL && {
    name: "FLOW_EMAIL",
    hint:
      "The full, unmasked email of the Google Flow account you connected — the one " +
      "'npm run connect' printed. Note that 'npm run accounts' shows it masked " +
      "(ab***@gmail.com); you need the whole address here.",
  },
].filter(Boolean);

if (missing.length) {
  console.error(
    `Missing ${missing.length === 1 ? "one setting" : "settings"} in .env:\n\n` +
      missing.map((m) => `  ${m.name}\n    ${m.hint}`).join("\n\n") +
      `\n\nAdd ${missing.length === 1 ? "that line" : "those lines"} to the .env file ` +
      `next to package.json, then run this again.\n\n` +
      `To see what is currently loaded:\n` +
      `  node --env-file-if-exists=.env -e "console.log(process.env.FLOW_EMAIL)"`,
  );
  process.exit(1);
}

const auth = jwt.sign({ sub: "smoke", flow_email: FLOW_EMAIL }, SECRET, {
  algorithm: "HS256",
  expiresIn: "5m",
});

let id = 0;
async function callTool(name, args = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${auth}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.json();
  if (body.error) return { isError: true, text: JSON.stringify(body.error) };
  return {
    isError: Boolean(body.result?.isError),
    text: body.result?.content?.[0]?.text ?? "",
    structured: body.result?.structuredContent ?? null,
  };
}

console.log(`Checking ${FLOW_EMAIL} against the live API — read-only, no credits spent.\n`);

const account = await callTool("google_flow_get_account");
if (account.isError) {
  console.error("✗ get_account failed:\n" + account.text);
  process.exit(1);
}

const s = account.structured;
console.log(`  health          ${s.health}${s.healthy ? "" : "   <-- session is broken, reconnect needed"}`);
console.log(`  credits         ${s.credits?.credits ?? "unavailable"}`);
console.log(`  tier            ${s.credits?.userPaygateTier ?? "unavailable"}`);
console.log(`  video models    ${s.videoModels.map((m) => m.key).join(", ") || "none"}`);

if (!s.healthy) {
  console.error("\nStop here. Reconnect the account before testing anything else.");
  process.exit(1);
}

const voices = await callTool("google_flow_list_voices", { source: "user" });
console.log(`  custom voices   ${voices.structured?.count ?? (voices.isError ? "error" : 0)}`);

const characters = await callTool("google_flow_list_characters");
console.log(`  characters      ${characters.structured?.count ?? (characters.isError ? "error" : 0)}`);

const affordable = s.videoModels
  .filter((m) => (m.creditCost ?? Infinity) <= (s.credits?.credits ?? 0))
  .map((m) => `${m.key} (${m.creditCost})`);

console.log(`\n✓ Live path works.`);
console.log(`  Models you can afford right now: ${affordable.join(", ") || "none"}`);
console.log(
  `\nNext, the cheapest real generation is an image on nano-banana-2-lite.\n` +
    `Then a video on veo-3.1-lite (10 credits) before anything expensive.`,
);
