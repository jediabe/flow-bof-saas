/**
 * Streamable HTTP transport plus the account administration API.
 *
 * Two distinct surfaces, deliberately separated:
 *
 *   POST /mcp     The tools. Authenticated per end user, pinned to that user's
 *                 Google Flow account. Reached by your backend's model loop.
 *
 *   /admin/*      Account connect, disconnect, and status. Guarded by a shared
 *                 service key. These routes handle raw Google session cookies
 *                 and can see every connected account, so they are NOT tools
 *                 and no model should ever be able to call them.
 *
 * The /mcp endpoint is stateless — a fresh transport and server per request —
 * so it scales horizontally with no sticky sessions.
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { buildServer } from "./server.js";
import { runWithContext } from "./context.js";
import {
  createAdminMiddleware,
  createAuthMiddleware,
  type AuthenticatedRequest,
} from "./auth/middleware.js";
import { GoogleFlowClient } from "./services/client.js";
import { GoogleFlowApiError, extractApiMessage } from "./services/errors.js";
import { API_BASE_URL, SERVER_NAME, SERVER_VERSION } from "./constants.js";

export function createHttpApp(config: Config) {
  const app = express();
  app.disable("x-powered-by");

  // Cookie blobs from Chrome DevTools run large; binary uploads do not pass
  // through here (the useapi client streams those directly).
  app.use(express.json({ limit: "10mb" }));

  const authenticate = createAuthMiddleware(config);
  const requireAdmin = createAdminMiddleware(config);

  /** Admin routes act as the subscription owner, not as any particular user. */
  const adminClient = (email = "") =>
    new GoogleFlowClient(config.useapiToken, email, config.USEAPI_BASE_URL);

  function adminError(res: Response, error: unknown): void {
    if (error instanceof GoogleFlowApiError) {
      res.status(error.status === 596 ? 502 : error.status).json({
        error: extractApiMessage(error.body) ?? error.message,
        upstreamStatus: error.status,
        ...(error.status === 596
          ? { code: "session_broken", action: "reconnect_account" }
          : {}),
      });
      return;
    }
    console.error("[admin]", error);
    res.status(500).json({ error: "Internal server error." });
  }

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: SERVER_NAME,
      version: SERVER_VERSION,
      authMode: config.AUTH_MODE,
      // Which upstream this process actually talks to. Reported because
      // "why am I seeing accounts I don't recognise" is otherwise very hard
      // to diagnose from the outside.
      upstream: config.USEAPI_BASE_URL ?? API_BASE_URL,
      usingMockUpstream: Boolean(config.USEAPI_BASE_URL),
    });
  });

  /* ---------------------------------------------------------------- *
   * MCP endpoint
   * ---------------------------------------------------------------- */

  app.post("/mcp", authenticate, async (req: AuthenticatedRequest, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await runWithContext(
        {
          userId: req.apexUserId!,
          flowEmail: req.apexFlowEmail!,
          requestId: req.apexRequestId ?? randomUUID(),
        },
        () => transport.handleRequest(req, res, req.body),
      );
    } catch (error) {
      console.error(
        `[mcp] request ${req.apexRequestId} for user ${req.apexUserId} failed:`,
        error,
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "This server runs in stateless mode. Send JSON-RPC requests as POST /mcp; " +
          "GET and DELETE are not supported.",
      },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  /* ---------------------------------------------------------------- *
   * Account administration
   * ---------------------------------------------------------------- */

  app.use("/admin", requireAdmin);

  /**
   * Connect a user's Google Flow account.
   *
   * The `cookies` blob is the tab-separated table the user copies out of their
   * browser's DevTools for accounts.google.com. Do not log it, do not persist
   * it — useapi.net takes ownership of the session from here and refreshes it
   * an hour before expiry.
   *
   * Returns the connected account email. Store it against your user record;
   * it is what you put in the `flow_email` JWT claim from then on.
   */
  app.post("/admin/accounts", async (req, res) => {
    const { cookies } = (req.body ?? {}) as { cookies?: string };

    if (typeof cookies !== "string" || cookies.trim().length < 50) {
      res.status(400).json({
        error:
          "Body must include a 'cookies' string: the tab-separated cookie table copied " +
          "from the browser's DevTools for https://accounts.google.com/.",
      });
      return;
    }

    try {
      const raw = (await adminClient().request("/accounts", {
        method: "POST",
        body: { cookies },
        timeoutMs: 120_000,
      })) as Record<string, unknown>;

      const sessionUser = (raw?.["sessionData"] as Record<string, unknown> | undefined)?.[
        "user"
      ] as Record<string, unknown> | undefined;
      const email = (sessionUser?.["email"] as string | undefined) ?? null;

      console.log(`[admin] connected Google Flow account${email ? ` for ${email}` : ""}`);

      // Deliberately does not echo the cookies field back.
      res.status(201).json({
        email,
        name: (sessionUser?.["name"] as string | undefined) ?? null,
        health: (raw?.["health"] as string | undefined) ?? "OK",
        project: raw?.["project"] ?? null,
        nextRefresh: raw?.["nextRefresh"] ?? null,
      });
    } catch (error) {
      if (error instanceof GoogleFlowApiError && error.status === 400) {
        res.status(400).json({
          error:
            "Google rejected those cookies. They may be stale, from the wrong domain, or " +
            "captured without checking 'Don't ask again on this device' at the 2FA prompt.",
          code: "invalid_cookies",
          upstreamStatus: 400,
        });
        return;
      }
      adminError(res, error);
    }
  });

  /** Every connected account and its health — for your ops dashboard. */
  app.get("/admin/accounts", async (_req, res) => {
    try {
      const raw = (await adminClient().request("/accounts")) as Record<
        string,
        Record<string, unknown>
      >;
      res.json({
        count: Object.keys(raw ?? {}).length,
        accounts: Object.entries(raw ?? {}).map(([email, info]) => ({
          email,
          health: info?.["health"] ?? "unknown",
          created: info?.["created"] ?? null,
          sessionExpires:
            (info?.["sessionData"] as Record<string, unknown> | undefined)?.["expires"] ?? null,
          nextRefresh:
            (info?.["nextRefresh"] as Record<string, unknown> | undefined)?.["scheduledFor"] ??
            null,
        })),
      });
    } catch (error) {
      adminError(res, error);
    }
  });

  /**
   * One account's health and credits.
   *
   * Poll this to detect a broken session before the user hits it mid-generation:
   * `healthy: false` means they need to reconnect, and no amount of retrying
   * will fix it.
   */
  app.get("/admin/accounts/:email", async (req, res) => {
    try {
      const raw = (await adminClient().request(
        `/accounts/${encodeURIComponent(req.params.email)}`,
      )) as Record<string, unknown>;

      const health = (raw?.["health"] as string | undefined) ?? "unknown";
      res.json({
        email: req.params.email,
        health,
        healthy: health === "OK",
        credits: raw?.["credits"] ?? null,
        project: raw?.["project"] ?? null,
        nextRefresh: raw?.["nextRefresh"] ?? null,
        // sessionData and cookies are intentionally omitted.
      });
    } catch (error) {
      adminError(res, error);
    }
  });

  /** Disconnect an account. Also the first half of recovering from a 596. */
  app.delete("/admin/accounts/:email", async (req, res) => {
    try {
      const raw = await adminClient().request(
        `/accounts/${encodeURIComponent(req.params.email)}`,
        { method: "DELETE" },
      );
      console.log(`[admin] disconnected Google Flow account ${req.params.email}`);
      res.json({ email: req.params.email, deleted: true, upstream: raw });
    } catch (error) {
      adminError(res, error);
    }
  });

  /**
   * Throughput and throttling stats across every connected account.
   * Not exposed as a tool: it would leak other users' accounts to any caller.
   */
  app.get("/admin/stats", async (req, res) => {
    const options = String(req.query["options"] ?? "summary");
    if (!["summary", "executing", "history"].includes(options)) {
      res.status(400).json({ error: "options must be summary, executing, or history." });
      return;
    }
    try {
      res.json(await adminClient().request("/jobs", { query: { options } }));
    } catch (error) {
      adminError(res, error);
    }
  });

  /** Captcha provider configuration and solve statistics. */
  app.get("/admin/captcha", async (_req, res) => {
    try {
      const [providers, stats] = await Promise.all([
        adminClient().request("/accounts/captcha-providers"),
        adminClient().request("/accounts/captcha-stats"),
      ]);
      res.json({ providers, stats });
    } catch (error) {
      adminError(res, error);
    }
  });

  return app;
}
