/**
 * Account health, credit balance, and model discovery — scoped to the caller.
 *
 * There is deliberately no "list accounts" tool. `GET /accounts` returns every
 * Google Flow account on the useapi.net subscription, which in this deployment
 * means every one of your users. That listing belongs on the admin API, behind
 * the service key, not in a tool an end user's model can call.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { responseFormatParam } from "../schemas/common.js";
import { result, runTool } from "./shared.js";

interface VideoModelInfo {
  key?: string;
  displayName?: string;
  supportedAspectRatios?: string[];
  capabilities?: string[];
  videoLengthSeconds?: number;
  creditCost?: number;
  paygateTier?: string;
  accessType?: string;
}

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "google_flow_get_account",
    {
      title: "Get Account Status, Credits, and Available Models",
      description: `Get the current user's Google Flow account: session health, remaining credit balance, subscription tier, and which video models their plan can actually use.

Call this before an expensive generation to confirm there are enough credits and that the
requested model is available. There is nothing to pass — the account is determined by who is
making the request.

Returns:
  { "email": string, "health": string, "healthy": boolean,
    "credits": { "credits": number, "userPaygateTier": string },
    "videoModels": [{ "key": string, "displayName": string, "creditCost": number,
                      "supportedAspectRatios": [string], "videoLengthSeconds": number,
                      "paygateTier": string, "accessType": string }] }

Paygate tiers: PAYGATE_TIER_ZERO (free) | ONE | TIER1P5 | TWO. Credits and models are populated
only when health is "OK"; when it is not, the user's Google Flow connection has broken and they
need to reconnect it before anything will generate.

Credit costs for reference: veo-3.1-lite 10 (5 on Ultra), veo-3.1-fast 20 (10 on Ultra),
veo-3.1-quality 100, veo-3.1-lite-low-priority 0 but Ultra $199 tier only,
omni-flash 15/20/25/30 for 4/6/8/10s, omni-flash video-to-video 40, 4K video upscale 50.

Examples:
  - "Can I afford a quality render?" -> compare credits against the 100-credit veo-3.1-quality cost
  - "Why can't I use 4K?" -> check userPaygateTier
  - "Why is nothing working?" -> check health`,
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
        const email = client.email;
        const raw = (await client.request(
          `/accounts/${encodeURIComponent(email)}`,
        )) as Record<string, unknown>;

        const health = (raw?.["health"] as string | undefined) ?? "unknown";
        const healthy = health === "OK";
        const credits = (raw?.["credits"] as Record<string, unknown> | undefined) ?? null;
        const videoModels =
          ((raw?.["models"] as Record<string, unknown> | undefined)?.[
            "videoModels"
          ] as VideoModelInfo[] | undefined) ?? [];

        const structured = {
          email,
          health,
          healthy,
          credits,
          videoModels: videoModels.map((m) => ({
            key: m.key ?? null,
            displayName: m.displayName ?? null,
            creditCost: m.creditCost ?? null,
            supportedAspectRatios: m.supportedAspectRatios ?? [],
            videoLengthSeconds: m.videoLengthSeconds ?? null,
            paygateTier: m.paygateTier ?? null,
            accessType: m.accessType ?? null,
          })),
        };

        const md = [
          `# Google Flow account`,
          "",
          `- **health**: ${health}`,
          credits
            ? `- **credits**: ${credits["credits"]} (tier ${credits["userPaygateTier"]})`
            : "- **credits**: unavailable",
          "",
          healthy
            ? ""
            : "**This account's Google session is broken.** Nothing will generate until the user reconnects their Google Flow account. Tell them to reconnect rather than retrying.",
          "",
          structured.videoModels.length
            ? [
                "## Available video models",
                "",
                "| Model | Credits | Max length | Aspect ratios | Tier |",
                "|---|---|---|---|---|",
                ...structured.videoModels.map(
                  (m) =>
                    `| ${m.key ?? m.displayName} | ${m.creditCost ?? "—"} | ${m.videoLengthSeconds ?? "—"}s | ${m.supportedAspectRatios.join(", ") || "—"} | ${m.paygateTier ?? "—"} |`,
                ),
              ].join("\n")
            : "_No video models reported._",
        ]
          .filter((line) => line !== "")
          .join("\n");

        return result(structured, md, params.response_format);
      }),
  );
}
