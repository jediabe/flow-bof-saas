import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServiceActorContext } from "@/lib/content-runs/types";
import { createHermesContentHandlers, type HermesContentHandlers } from "./handlers";
import {
  HERMES_CONTENT_TOOL_NAMES,
  HERMES_CONTENT_TOOL_SCHEMAS,
  type HermesContentToolName,
} from "./schemas";

const TOOL_DESCRIPTIONS: Record<HermesContentToolName, string> = {
  content_get_product: "Get one approved product in the authenticated workspace.",
  content_create_run: "Validate and freeze a managed Style 1 or Style 2 content run.",
  content_generate_image: "Generate the exact next image slot from the frozen manifest.",
  content_generate_video: "Generate the exact next video slot from the frozen manifest.",
  content_run_qa: "Run mandatory QA for the exact persisted asset awaiting review.",
  content_run_final_output: "Drive at most one persisted final-output phase.",
  content_get_run: "Read the authoritative managed run projection and frozen style identity.",
};

export interface CreateHermesMcpServerDependencies {
  createHandlers?: (actor: ServiceActorContext) => HermesContentHandlers;
}

export function createHermesMcpServer(
  actor: ServiceActorContext,
  dependencies: CreateHermesMcpServerDependencies = {},
): McpServer {
  const server = new McpServer({ name: "flow-bof-managed-content", version: "1.0.0" });
  const handlers = (dependencies.createHandlers ?? createHermesContentHandlers)(actor);

  for (const name of HERMES_CONTENT_TOOL_NAMES) {
    const handler = handlers[name] as (input: unknown) => Promise<unknown>;
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: HERMES_CONTENT_TOOL_SCHEMAS[name],
        annotations: {
          readOnlyHint: name === "content_get_product" || name === "content_get_run",
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input: unknown) => {
        const result = await handler(input);
        const structuredContent = result && typeof result === "object" && !Array.isArray(result)
          ? result as Record<string, unknown>
          : { result };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      },
    );
  }

  return server;
}
