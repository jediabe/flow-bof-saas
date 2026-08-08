#!/usr/bin/env node
/**
 * Account administration from the command line.
 *
 *   npm run connect -- cookies.txt        connect a Google Flow account
 *   npm run accounts                      list connected accounts and health
 *   npm run accounts -- someone@gmail.com detail for one account
 *   npm run disconnect -- someone@gmail.com
 *
 * The cookie blob is read from a FILE rather than an argument, because it is
 * large, contains characters every shell mangles, and should not end up in
 * your shell history. Delete the file afterwards.
 */

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

const BASE = cfg("MCP_URL", `http://localhost:${cfg("PORT", "3000")}/mcp`).replace(/\/mcp$/, "");
const KEY = cfg("APEX_SERVICE_KEY");

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

const [action, arg] = process.argv.slice(2);

if (!KEY && cfg("AUTH_MODE", "jwt") !== "none") {
  console.error("No APEX_SERVICE_KEY found in the environment or .env.");
  process.exit(1);
}

async function admin(path, init = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    console.error(`Could not reach ${BASE} — is the server running?\n  ${err.message}`);
    process.exit(1);
  }
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

await warnIfMock(BASE);

switch (action) {
  case "connect": {
    if (!arg) {
      console.error(
        "Usage: npm run connect -- <path-to-cookies-file>\n\n" +
          "Save the cookie table copied from DevTools into a text file first.",
      );
      process.exit(1);
    }

    let cookies;
    try {
      cookies = readFileSync(arg, "utf8").trim();
    } catch {
      console.error(`Could not read '${arg}'.`);
      process.exit(1);
    }
    if (cookies.length < 50) {
      console.error(`'${arg}' looks too short to be a cookie table (${cookies.length} chars).`);
      process.exit(1);
    }

    const { ok, body } = await admin("/admin/accounts", {
      method: "POST",
      body: JSON.stringify({ cookies }),
    });

    if (!ok) {
      console.error(`Failed: ${body?.error ?? "unknown error"}`);
      if (body?.code === "invalid_cookies") {
        console.error(
          "\nThe usual causes: the cookies came from the wrong domain (they must be\n" +
            "from accounts.google.com), they went stale, or you skipped\n" +
            "\"Don't ask again on this device\" at the 2FA prompt.",
        );
      }
      process.exit(1);
    }

    console.log(`Connected: ${body.email}`);
    console.log(`Health:    ${body.health}`);
    console.log(
      `\nStore that email against your user record — it goes in the 'flow_email'\n` +
        `JWT claim from now on. Then delete ${arg}, and do not sign into that\n` +
        `Google account in a browser again.`,
    );
    break;
  }

  case "accounts": {
    if (arg) {
      const { ok, body } = await admin(`/admin/accounts/${encodeURIComponent(arg)}`);
      if (!ok) {
        console.error(`Failed: ${body?.error ?? "unknown error"}`);
        process.exit(1);
      }
      console.log(JSON.stringify(body, null, 2));
      if (body.healthy === false) {
        console.error("\nThis session is broken. Disconnect and reconnect the account.");
        process.exit(1);
      }
      break;
    }

    const { ok, body } = await admin("/admin/accounts");
    if (!ok) {
      console.error(`Failed: ${body?.error ?? "unknown error"}`);
      process.exit(1);
    }
    if (!body.count) {
      console.log("No accounts connected. Use: npm run connect -- cookies.txt");
      break;
    }
    console.log(`${body.count} connected account(s):\n`);
    for (const a of body.accounts) {
      const flag = a.health === "OK" ? " " : "!";
      console.log(`  ${flag} ${a.email.padEnd(28)} ${a.health}`);
    }
    if (body.accounts.some((a) => a.health !== "OK")) {
      console.log("\n! marks a broken session — those accounts need reconnecting.");
    }
    break;
  }

  case "disconnect": {
    if (!arg) {
      console.error("Usage: npm run disconnect -- <email>");
      process.exit(1);
    }
    const { ok, body } = await admin(`/admin/accounts/${encodeURIComponent(arg)}`, {
      method: "DELETE",
    });
    if (!ok) {
      console.error(`Failed: ${body?.error ?? "unknown error"}`);
      process.exit(1);
    }
    console.log(`Disconnected ${arg}.`);
    break;
  }

  default:
    console.error(
      "Usage:\n" +
        "  npm run connect -- cookies.txt\n" +
        "  npm run accounts\n" +
        "  npm run accounts -- someone@gmail.com\n" +
        "  npm run disconnect -- someone@gmail.com",
    );
    process.exit(1);
}
