/**
 * Captcha-provider management for the useapi.net Google Flow API.
 *
 * The captcha-config endpoints are SUBSCRIPTION-WIDE — the useapi.net
 * token holder configures one or more captcha solvers (CapSolver,
 * AntiCaptcha, YesCaptcha, SolveCaptcha, 2Captcha, EzCaptcha) and
 * every Google Flow account under that subscription uses them
 * automatically. There is nothing per-user to manage.
 *
 * That means "app-wide captcha" in this deployment collapses to:
 *   1. Operator sets USEAPI_CAPTCHA_PROVIDERS_JSON in .env.
 *   2. On boot, this module POSTs those keys to useapi.net once
 *      (idempotent — safe to re-run on every restart).
 *   3. Users never touch captcha config; every generation just
 *      works.
 *
 * We also expose two READ-ONLY MCP tools so agents / operators can
 * inspect what's configured and monitor solver health:
 *   - google_flow_list_captcha_providers
 *   - google_flow_get_captcha_stats
 *
 * We deliberately do NOT expose a WRITE MCP tool (POST). Because
 * the config is subscription-wide, an end user calling it would
 * change the deployment's config for everyone else. Operator-only
 * configuration goes through the env var + restart cycle, or a
 * dedicated admin CLI script if we build one later.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { responseFormatParam } from "../schemas/common.js";
import { result, runTool } from "./shared.js";
import { API_BASE_URL } from "../constants.js";

/* ==================================================================
 * Public: registration on server boot
 *
 * Called from src/index.ts once at startup. No-op when the config
 * has no captchaProviders map (operator hasn't set the env var).
 * Failures log a WARN and continue — captcha config is a nice-to-
 * have; missing it doesn't stop the server from booting, and the
 * next generation request will surface a per-request captcha error
 * that the operator can debug from there.
 * ================================================================ */

export interface CaptchaBootInput {
  useapiToken: string;
  useapiBaseUrl?: string | undefined;
  providers: Record<string, string>;
}

export async function registerCaptchaProvidersOnBoot(
  input: CaptchaBootInput,
): Promise<void> {
  const base = input.useapiBaseUrl ?? API_BASE_URL;
  const url = `${base}/accounts/captcha-providers`;
  const keys = Object.keys(input.providers);
  if (keys.length === 0) {
    console.warn(
      "[captcha] USEAPI_CAPTCHA_PROVIDERS_JSON is empty — skipping registration.",
    );
    return;
  }
  console.log(
    `[captcha] Registering ${keys.length} provider(s) with useapi.net: ${keys.join(", ")}`,
  );
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${input.useapiToken}`,
      },
      body: JSON.stringify(input.providers),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await resp.text();
    if (!resp.ok) {
      console.warn(
        `[captcha] Registration failed (HTTP ${resp.status}): ${body.slice(0, 400)} — captcha will fall back to whatever's already configured, or free credits.`,
      );
      return;
    }
    // useapi.net echoes back the MASKED keys on success. Log the
    // configured provider names only — never the keys themselves.
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const registered = Object.keys(parsed).filter(
        (k) => k !== "freeCaptchaCredits",
      );
      console.log(
        `[captcha] Registration OK. Active providers on this subscription: ${registered.join(", ") || "(none — free credits remain)"}.`,
      );
    } catch {
      console.log(`[captcha] Registration OK (unparseable response).`);
    }
  } catch (err) {
    console.warn(
      `[captcha] Registration error: ${(err as Error).message?.slice(0, 300)} — continuing without captcha config.`,
    );
  }
}

/* ==================================================================
 * Public: read-only MCP tools
 * ================================================================ */

export function registerCaptchaTools(server: McpServer): void {
  server.registerTool(
    "google_flow_list_captcha_providers",
    {
      title: "List Configured Captcha Providers",
      description: `List which captcha solver providers are configured on this useapi.net subscription. Keys are returned MASKED (e.g. "abc...***...xyz") — the full key is never exposed. Use this to verify a captcha provider is actually configured before running a batch of expensive generations, or to check whether the free-CapSolver-credit allocation has run out.

The captcha config is SUBSCRIPTION-WIDE (not per-Google-Flow-account), so the list you get back is the same for every user under this deployment. Configuration happens on the server via the USEAPI_CAPTCHA_PROVIDERS_JSON env var + restart — there is deliberately no "set provider" tool because a change would affect every user.

Returns:
  { "providers": { "CapSolver": "abc***xyz", "AntiCaptcha": "def***uvw" },
    "freeCaptchaCredits": number | null }

When no providers are configured AND free credits remain, only freeCaptchaCredits is populated (an integer count). When free credits are exhausted and no providers are configured, both fields are empty — any image/video/voice generation will 403 on captcha until the operator adds a provider.

Errors:
  - 401 Unauthorized: the useapi.net token is invalid — the operator needs to fix USEAPI_TOKEN on the server.`,
      inputSchema: {
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const raw = (await client.request(
          "/accounts/captcha-providers",
          { method: "GET" },
        )) as Record<string, unknown>;

        const record = raw ?? {};
        const providers: Record<string, string> = {};
        let freeCaptchaCredits: number | null = null;
        for (const [k, v] of Object.entries(record)) {
          if (k === "freeCaptchaCredits") {
            if (typeof v === "number") freeCaptchaCredits = v;
            continue;
          }
          if (typeof v === "string") providers[k] = v;
        }

        const structured = { providers, freeCaptchaCredits };
        const md = [
          "# Captcha providers",
          "",
          Object.keys(providers).length > 0
            ? `**${Object.keys(providers).length} provider(s) configured** (keys masked):`
            : "**No providers configured.**",
          "",
          ...Object.entries(providers).map(
            ([k, v]) => `- **${k}**: \`${v}\``,
          ),
          freeCaptchaCredits !== null
            ? `\n_${freeCaptchaCredits} free CapSolver credits remaining on this subscription._`
            : "",
          Object.keys(providers).length === 0 && freeCaptchaCredits === null
            ? "\n⚠️ No providers configured AND no free credits. Image/video/voice generation will fail on captcha until a provider is added via USEAPI_CAPTCHA_PROVIDERS_JSON on the server."
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        return result(structured, md, params.response_format);
      }),
  );

  server.registerTool(
    "google_flow_get_captcha_stats",
    {
      title: "Get Captcha Solver Statistics",
      description: `Get captcha solve rates and sample sizes across the configured providers on this useapi.net subscription. Useful for comparing provider health — if CapSolver has a 20% success rate over the last 24h and AntiCaptcha has 95%, drop the low performer.

The stats are SUBSCRIPTION-WIDE (same across every Google Flow account under this deployment). Filters narrow the time window / provider / row count.

Returns:
  { "stats": [{ "date": "YYYY-MM-DD", "provider": string,
                "successCount": number, "failureCount": number,
                "successRate": number, ... }, ...],
    "raw": {...} }

When anonymized=true, the response summarises across ALL useapi.net users' captcha solves (last 10000 records), which is useful for benchmarking "is our solver worse than average" without other operators seeing our own numbers.

Errors:
  - 401 Unauthorized: the useapi.net token is invalid.
  - 400 Bad Request: usually an invalid date format (use YYYY-MM-DD).`,
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
          .optional()
          .describe("Filter to a single day, YYYY-MM-DD. Default: recent history."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .describe("Max rows returned. Default per useapi.net."),
        provider: z
          .string()
          .optional()
          .describe(
            "Filter to a single provider (e.g. 'CapSolver'). Case-sensitive.",
          ),
        anonymized: z
          .boolean()
          .optional()
          .describe(
            "true: return aggregated cross-user benchmark (last 10000 records across the entire useapi.net platform). Ignores date/limit/provider when set.",
          ),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (params.date) query.date = params.date;
        if (params.limit) query.limit = params.limit;
        if (params.provider) query.provider = params.provider;
        if (params.anonymized) query.anonymized = params.anonymized;

        const raw = (await client.request(
          "/accounts/captcha-stats",
          { method: "GET", query },
        )) as Record<string, unknown>;

        const structured = { raw };
        const md = [
          "# Captcha stats",
          params.anonymized
            ? "_Anonymized cross-user benchmark (last 10000 records across all useapi.net users)._"
            : `_Filters: date=${params.date ?? "recent"}, provider=${params.provider ?? "all"}, limit=${params.limit ?? "default"}._`,
          "",
          "```json",
          JSON.stringify(raw, null, 2).slice(0, 4_000),
          "```",
        ].join("\n");
        return result(structured, md, params.response_format);
      }),
  );
}
