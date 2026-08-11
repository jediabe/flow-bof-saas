#!/usr/bin/env node
/**
 * import-openai-oauth.mjs — one-shot ingestion of an existing
 * ChatGPT-subscription OAuth grant into the LlmCredential table.
 *
 * Why this exists: the full "connect your ChatGPT sub via a
 * browser popup" UX (device-flow-style with a local callback
 * server) is deferred to a later commit. In the meantime, if you
 * already have a working OAuth grant from another tool
 * (opencode, codex CLI) sitting at ~/.local/share/opencode/auth.json,
 * this script encrypts the tokens and upserts them into your
 * user's LlmCredential row so resolveLlmCredential can start
 * using them immediately.
 *
 * Usage:
 *
 *   node scripts/import-openai-oauth.mjs \
 *     --user-email you@example.com \
 *     --file ~/.local/share/opencode/auth.json
 *
 * Optional: --auth-file defaults to ~/.local/share/opencode/auth.json
 *
 * Prerequisites:
 *   - LLM_CRED_ENC_KEY must be set in the environment (same
 *     32-byte base64 key the running server uses).
 *   - DATABASE_URL must point at the same DB the server uses.
 *
 * The script:
 *   1. Reads the auth.json blob.
 *   2. Extracts { openai.refresh, openai.access, openai.expires,
 *      openai.accountId }.
 *   3. Encrypts access + refresh with encryptLlmSecret().
 *   4. Upserts one LlmCredential row keyed on your User.id, mode
 *      "user_oauth", provider "openai".
 *
 * SECURITY: run this locally against your prod .env, not against
 * the checked-in .env. The refresh token is long-lived and
 * grants access to your ChatGPT account.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

/* ------------------------------------------------------------------
 * CLI parsing
 * ---------------------------------------------------------------- */

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { userEmail: null, file: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === "--user-email" || arg === "-u") && args[i + 1]) {
      out.userEmail = args[++i];
    } else if ((arg === "--file" || arg === "-f") && args[i + 1]) {
      out.file = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!out.userEmail) {
    console.error("error: --user-email is required");
    printHelp();
    process.exit(2);
  }
  if (!out.file) {
    // Default to opencode's location on Linux/macOS.
    out.file = resolve(homedir(), ".local/share/opencode/auth.json");
  }
  return out;
}

function printHelp() {
  console.log(
    "usage: node scripts/import-openai-oauth.mjs --user-email <email> [--file <path>]\n" +
      "\n" +
      "  --user-email  Email of the User row to attach the credential to (required)\n" +
      "  --file        Path to opencode/codex auth.json\n" +
      "                (default: ~/.local/share/opencode/auth.json)\n",
  );
}

/* ------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------- */

async function main() {
  const { userEmail, file } = parseArgs();

  // Read the source auth blob.
  let authRaw;
  try {
    authRaw = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`error: could not read ${file}: ${err.message}`);
    process.exit(1);
  }
  let authJson;
  try {
    authJson = JSON.parse(authRaw);
  } catch (err) {
    console.error(`error: ${file} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  const openai = authJson?.openai;
  if (!openai || openai.type !== "oauth") {
    console.error(
      `error: ${file} does not contain a valid openai.type="oauth" entry`,
    );
    process.exit(1);
  }
  const { refresh, access, expires, accountId } = openai;
  if (typeof refresh !== "string" || !refresh) {
    console.error(`error: openai.refresh is missing or empty`);
    process.exit(1);
  }
  if (typeof access !== "string" || !access) {
    console.error(`error: openai.access is missing or empty`);
    process.exit(1);
  }
  if (typeof expires !== "number" || expires <= 0) {
    console.error(`error: openai.expires is missing or invalid`);
    process.exit(1);
  }
  if (typeof accountId !== "string" || !accountId) {
    console.error(`error: openai.accountId is missing or empty`);
    process.exit(1);
  }

  // Import at runtime AFTER we've validated inputs so a broken
  // .env doesn't fail before the user knows the flags are wrong.
  // Dynamic imports for tsx-compiled paths inside dist/... don't
  // work in dev — resolve against the source tree instead.
  const { PrismaClient } = await import("@prisma/client");
  const { encryptLlmSecret } = await import(
    "../src/lib/llm/crypto.ts"
  ).catch(async () => {
    // Fallback: build the paths manually for a node-only script.
    // encryptLlmSecret is small; inline it here rather than
    // adding a compilation step.
    return {
      encryptLlmSecret: inlineEncryptLlmSecret,
    };
  });

  const db = new PrismaClient();
  try {
    const user = await db.user.findUnique({ where: { email: userEmail } });
    if (!user) {
      console.error(`error: no User with email=${userEmail}`);
      process.exit(1);
    }

    const accessTokenEnc = encryptLlmSecret(access);
    const refreshTokenEnc = encryptLlmSecret(refresh);
    const accessExpiresAt = new Date(expires);

    await db.llmCredential.upsert({
      where: { userId: user.id },
      update: {
        mode: "user_oauth",
        provider: "openai",
        apiKeyEnc: null,
        accessTokenEnc,
        refreshTokenEnc,
        accessExpiresAt,
        chatgptAccountId: accountId,
        creditsExhaustedUntil: null,
      },
      create: {
        userId: user.id,
        mode: "user_oauth",
        provider: "openai",
        accessTokenEnc,
        refreshTokenEnc,
        accessExpiresAt,
        chatgptAccountId: accountId,
      },
    });

    console.log("✓ ChatGPT subscription OAuth credential imported.");
    console.log(`  user:    ${user.email} (id=${user.id})`);
    console.log(`  account: ${accountId}`);
    console.log(`  expires: ${accessExpiresAt.toISOString()}`);
    console.log(
      `  approx  ${Math.round((expires - Date.now()) / 1000 / 3600)} hours until access token expiry — refresh happens automatically at the 5-min horizon.`,
    );
  } finally {
    await db.$disconnect();
  }
}

/* ------------------------------------------------------------------
 * Inline encryptLlmSecret — kept in sync with src/lib/llm/crypto.ts
 *
 * Reason: this script is executed as plain Node (not tsx) so the
 * TypeScript source can't be imported directly. Copy the AES-GCM
 * envelope here. If crypto.ts ever changes format, update this
 * mirror or the script fails at import time.
 * ---------------------------------------------------------------- */

async function inlineEncryptLlmSecret(plaintext) {
  const { createCipheriv, randomBytes } = await import("node:crypto");
  const rawKey = (process.env.LLM_CRED_ENC_KEY || "").trim();
  if (!rawKey) {
    console.error(
      "error: LLM_CRED_ENC_KEY is not set. Add it to your .env before running this script.",
    );
    process.exit(1);
  }
  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    console.error(
      `error: LLM_CRED_ENC_KEY decodes to ${key.length} bytes; expected 32.`,
    );
    process.exit(1);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
