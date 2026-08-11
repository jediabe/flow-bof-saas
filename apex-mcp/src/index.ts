#!/usr/bin/env node
/**
 * APEX MCP — Google Flow MCP server.
 *
 * Exposes the useapi.net Google Flow v1 API (Veo 3.1, Gemini Omni Flash,
 * Nano Banana) as MCP tools.
 *
 * One useapi.net token owns the deployment. Each end user has connected their
 * own Google Flow account to that subscription, and every request names which
 * account it acts for via a signed claim from your backend. Nothing secret is
 * stored per user, so there is no database.
 *
 * Transports:
 *   TRANSPORT=http  (default) Streamable HTTP at POST /mcp — for the web app.
 *   TRANSPORT=stdio           Single account — for MCP Inspector or Claude Desktop.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type Config } from "./config.js";
import { buildServer } from "./server.js";
import { createHttpApp } from "./http.js";
import { runWithContext } from "./context.js";
import { setUseapiConfig } from "./tools/shared.js";
import { registerCaptchaProvidersOnBoot } from "./tools/captcha.js";
import { API_BASE_URL, SERVER_NAME, SERVER_VERSION } from "./constants.js";

/**
 * USEAPI_BASE_URL is a test-only escape hatch. A stale one — left over in a
 * shell from running the mock — silently sends every call to fake data, and
 * the symptom (unfamiliar accounts, phantom credits) looks nothing like the
 * cause. So say it loudly at startup.
 */
function warnIfMockUpstream(config: Config): void {
  if (!config.USEAPI_BASE_URL) return;
  const bar = "=".repeat(74);
  console.warn(
    `\n${bar}\n` +
      `  NOT talking to the real API.\n\n` +
      `  USEAPI_BASE_URL is set to ${config.USEAPI_BASE_URL}\n` +
      `  Every account, credit balance, and generation you see will be fake.\n\n` +
      `  This variable exists only for the test suite. If you did not mean to\n` +
      `  set it, it is probably left over in this shell from running the mock.\n` +
      `  Remember: a shell variable overrides .env, so clearing it from .env\n` +
      `  is not enough — close this terminal and open a new one.\n` +
      `${bar}\n`,
  );
}

async function runHttp(config: Config): Promise<void> {
  const app = createHttpApp(config);
  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(
      `${SERVER_NAME} v${SERVER_VERSION} listening on http://${config.HOST}:${config.PORT}/mcp\n` +
        `  auth:     ${config.AUTH_MODE}\n` +
        `  upstream: ${config.USEAPI_BASE_URL ?? API_BASE_URL}`,
    );
    warnIfMockUpstream(config);
  });

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => process.exit(0));
    // Don't hang forever on lingering keep-alive sockets.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function runStdio(config: Config): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();

  // stdio serves one account for the whole process lifetime, so the context is
  // established once around the connection rather than per request.
  await runWithContext(
    {
      userId: "stdio",
      flowEmail: config.DEFAULT_FLOW_EMAIL!,
      requestId: "stdio",
    },
    async () => {
      await server.connect(transport);
      // Log to stderr — stdout carries the JSON-RPC stream.
      console.error(
        `${SERVER_NAME} v${SERVER_VERSION} running on stdio as ${config.DEFAULT_FLOW_EMAIL} ` +
          `(upstream: ${config.USEAPI_BASE_URL ?? API_BASE_URL})`,
      );
      await new Promise<void>((resolve) => {
        process.on("SIGINT", resolve);
        process.on("SIGTERM", resolve);
      });
    },
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      `${SERVER_NAME} v${SERVER_VERSION}\n\n` +
        "Environment:\n" +
        "  USEAPI_TOKEN        your useapi.net token, including the 'user:' prefix (required)\n" +
        "  TRANSPORT           http (default) | stdio\n" +
        "  PORT                HTTP port, default 3000\n" +
        "  AUTH_MODE           jwt (default) | service-key | none\n" +
        "  APEX_JWT_SECRET     HS256 secret when AUTH_MODE=jwt\n" +
        "  APEX_SERVICE_KEY    guards the /admin account routes; also the bearer token\n" +
        "                      when AUTH_MODE=service-key\n" +
        "  DEFAULT_FLOW_EMAIL  account used by stdio mode and AUTH_MODE=none\n" +
        "  ALLOWED_ORIGINS     comma-separated allowlist for the Origin header\n\n" +
        "Per-request identity (AUTH_MODE=jwt):\n" +
        "  JWT claims 'sub' (your user id) and 'flow_email' (their connected\n" +
        "  Google Flow account). The email must be signed — this server will not\n" +
        "  accept it from a header or a tool argument.\n",
    );
    return;
  }

  const config = loadConfig();
  if (config.TRANSPORT === "stdio") warnIfMockUpstream(config);
  setUseapiConfig(config.useapiToken, config.USEAPI_BASE_URL);

  // Application-wide captcha registration. Fire-and-log: any
  // failure is warned about but doesn't block the server from
  // booting — a broken captcha config surfaces later as a
  // per-request captcha error, which is a better failure mode
  // than "server didn't start and no one can generate anything".
  if (config.captchaProviders) {
    await registerCaptchaProvidersOnBoot({
      useapiToken: config.useapiToken,
      useapiBaseUrl: config.USEAPI_BASE_URL,
      providers: config.captchaProviders,
    });
  }

  if (config.TRANSPORT === "stdio") {
    await runStdio(config);
  } else {
    await runHttp(config);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
