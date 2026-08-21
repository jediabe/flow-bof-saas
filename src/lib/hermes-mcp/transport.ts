import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authenticateHermesMcpRequest, HermesMcpAuthError } from "./auth";
import { createHermesMcpServer } from "./server";
import type { ServiceActorContext } from "@/lib/content-runs/types";

export const HERMES_MCP_NO_CACHE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
};

interface TransportDependencies {
  authenticate?: (request: Request) => Promise<ServiceActorContext>;
  createServer?: (actor: ServiceActorContext) => McpServer;
}

export function hermesMcpJsonRpcError(status: number, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: HERMES_MCP_NO_CACHE_HEADERS },
  );
}

export async function handleHermesMcpPost(
  request: Request,
  dependencies: TransportDependencies = {},
): Promise<Response> {
  let actor: ServiceActorContext;
  try {
    actor = await (dependencies.authenticate ?? authenticateHermesMcpRequest)(request);
  } catch (error) {
    if (error instanceof HermesMcpAuthError) {
      return hermesMcpJsonRpcError(
        error.status,
        -32001,
        error.status === 401 ? "Unauthorized" : "Authentication unavailable",
      );
    }
    return hermesMcpJsonRpcError(500, -32603, "Internal server error");
  }

  const server = (dependencies.createServer ?? createHermesMcpServer)(actor);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(HERMES_MCP_NO_CACHE_HEADERS)) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return hermesMcpJsonRpcError(500, -32603, "Internal server error");
  }
}
