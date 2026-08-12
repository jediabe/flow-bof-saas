#!/usr/bin/env node
/**
 * reset-user-password.mjs — set a User's password from the CLI.
 *
 * Exists because there's no self-serve password-reset flow yet
 * (no email provider wired in, no /forgot-password route). When
 * someone gets locked out, the operator runs this against the
 * production DB to unstick them.
 *
 * Usage:
 *
 *   # Prompt for password interactively (input hidden — recommended)
 *   node scripts/reset-user-password.mjs --email user@example.com
 *
 *   # Or pass it inline (visible via `ps` on multi-user hosts)
 *   node scripts/reset-user-password.mjs \
 *     --email user@example.com \
 *     --password 'the-new-password'
 *
 *   # Read from stdin (safe for pipes / secret stores)
 *   echo -n 'the-new-password' | \
 *     node scripts/reset-user-password.mjs --email user@example.com --stdin
 *
 *   # List every User row so you can pick the right email
 *   node scripts/reset-user-password.mjs --list
 *
 * On the VPS: use scripts/prod-reset-user-password.sh, which
 * spins up the same one-shot node container pattern as
 * prod-import-openai-oauth.sh.
 *
 * Prerequisites:
 *   - DATABASE_URL points at the same DB the running app uses.
 *   - Password policy: >= 8 chars, <= 200 chars (matches
 *     src/lib/password.ts).
 *
 * SECURITY:
 *   - Never logs the password (input or hashed).
 *   - Uses bcrypt with the same cost factor as signup (10).
 *   - Prints the new password back ONCE at the end so the
 *     operator can hand it to the user out-of-band.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import process from "node:process";
import bcrypt from "bcryptjs";

/* ------------------------------------------------------------------
 * CLI parsing
 * ---------------------------------------------------------------- */

const ROUNDS = 10; // matches src/lib/password.ts
const MIN_LEN = 8;
const MAX_LEN = 200;

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    email: null,
    password: null,
    stdin: false,
    list: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === "--email" || arg === "-e") && args[i + 1]) {
      out.email = args[++i];
    } else if ((arg === "--password" || arg === "-p") && args[i + 1]) {
      out.password = args[++i];
    } else if (arg === "--stdin") {
      out.stdin = true;
    } else if (arg === "--list" || arg === "-l") {
      out.list = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!out.list && !out.email) {
    console.error("error: --email is required (or use --list to see all users)");
    printHelp();
    process.exit(2);
  }
  return out;
}

function printHelp() {
  console.log(
    "usage: node scripts/reset-user-password.mjs [flags]\n" +
      "\n" +
      "  --email, -e <email>     User's email (required unless --list)\n" +
      "  --password, -p <pass>   New password inline (skipped if --stdin, prompted if omitted)\n" +
      "  --stdin                 Read password from stdin (recommended for automation)\n" +
      "  --list, -l              List every User row's email + created date, then exit\n" +
      "  --help, -h              Show this help\n",
  );
}

/* ------------------------------------------------------------------
 * Password input
 * ---------------------------------------------------------------- */

async function readPasswordFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/**
 * Prompt for a password with input hidden (best-effort — some
 * terminals don't honour stdout.write("\x1b[8m") for masking, so
 * fall back to hiding via readline's own no-echo flag). Confirms
 * with a second prompt to catch typos.
 */
function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(
        new Error(
          "stdin is not a TTY — use --stdin (with the password piped in) or --password inline.",
        ),
      );
      return;
    }
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Monkey-patch stdout.write to suppress echo of typed chars.
    // Not perfect (arrow keys can still redisplay) but good enough
    // for a one-off password entry.
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      if (typeof chunk === "string" && chunk !== "\n" && chunk !== "\r\n") {
        return originalWrite("", ...rest);
      }
      return originalWrite(chunk, ...rest);
    };
    rl.question("", (answer) => {
      process.stdout.write = originalWrite;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function resolvePassword(cli) {
  if (cli.password) return cli.password;
  if (cli.stdin) return await readPasswordFromStdin();
  const first = await promptHidden("New password: ");
  const second = await promptHidden("Confirm password: ");
  if (first !== second) {
    console.error("error: passwords do not match.");
    process.exit(1);
  }
  return first;
}

function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length === 0) {
    return "Password is empty.";
  }
  if (pw.length < MIN_LEN) return `Password must be at least ${MIN_LEN} characters.`;
  if (pw.length > MAX_LEN) return "Password is too long.";
  return null;
}

/* ------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------- */

async function main() {
  const cli = parseArgs();
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  try {
    if (cli.list) {
      const users = await db.user.findMany({
        select: { id: true, email: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      if (users.length === 0) {
        console.log("(no User rows in this DB)");
        return;
      }
      console.log(`${users.length} user${users.length === 1 ? "" : "s"}:\n`);
      for (const u of users) {
        console.log(`  ${u.email}\n    id: ${u.id}    created: ${u.createdAt.toISOString()}`);
      }
      return;
    }

    const user = await db.user.findUnique({ where: { email: cli.email } });
    if (!user) {
      console.error(`error: no User with email=${cli.email}`);
      console.error("       Run with --list to see every registered email.");
      process.exit(1);
    }

    const password = await resolvePassword(cli);
    const invalid = validatePassword(password);
    if (invalid) {
      console.error(`error: ${invalid}`);
      process.exit(1);
    }

    const passwordHash = await bcrypt.hash(password, ROUNDS);
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    console.log(`\n✓ Password reset for ${user.email}`);
    console.log(`  id:  ${user.id}`);
    console.log(`  hash cost: bcrypt rounds=${ROUNDS}`);
    console.log(
      "\n  Hand the new password to the user out-of-band. Do not paste it into chat / email / commit logs.",
    );
    console.log(
      "  They can log in immediately at /login; no session invalidation is needed (existing sessions stay valid until their JWT expires).",
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
