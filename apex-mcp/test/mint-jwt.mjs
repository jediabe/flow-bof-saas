#!/usr/bin/env node
/**
 * Mint a JWT for manual testing — the same token your web app's backend would
 * sign per request.
 *
 *   node test/mint-jwt.mjs someone@gmail.com [userId] [expiresIn]
 *
 * Reads APEX_JWT_SECRET from the environment or a .env file in the project root.
 * Prints the bare token, so it composes:
 *
 *   JWT=$(node test/mint-jwt.mjs you@gmail.com)
 *   curl -H "Authorization: Bearer $JWT" ...
 */

import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";

function secretFromEnvFile() {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    return /^APEX_JWT_SECRET\s*=\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

const secret = process.env.APEX_JWT_SECRET ?? secretFromEnvFile();
const flowEmail = process.argv[2];
const userId = process.argv[3] ?? "local-user";
const expiresIn = process.argv[4] ?? "1h";

if (!secret) {
  console.error(
    "No APEX_JWT_SECRET found in the environment or .env.\n" +
      "Generate one with: openssl rand -base64 48",
  );
  process.exit(1);
}
if (!flowEmail) {
  console.error("Usage: node test/mint-jwt.mjs <flow-account-email> [userId] [expiresIn]");
  process.exit(1);
}

process.stdout.write(
  jwt.sign({ sub: userId, flow_email: flowEmail }, secret, {
    algorithm: "HS256",
    expiresIn,
  }) + "\n",
);
