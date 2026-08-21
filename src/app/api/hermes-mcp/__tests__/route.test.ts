import { describe, expect, it, vi } from "vitest";
import { HermesMcpAuthError } from "@/lib/hermes-mcp/auth";
import { handleHermesMcpPost } from "@/lib/hermes-mcp/transport";

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "route-test", version: "1.0.0" },
  },
};

describe("POST /api/hermes-mcp", () => {
  it("returns 401 with no MCP execution when authentication fails", async () => {
    const createServer = vi.fn();
    const request = new Request("https://app.example/api/hermes-mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(initializeBody),
    });

    const response = await handleHermesMcpPost(request, {
      authenticate: vi.fn().mockRejectedValue(new HermesMcpAuthError("UNAUTHORIZED", "Authentication required.")),
      createServer,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    });
    expect(createServer).not.toHaveBeenCalled();
  });

  it("authenticates before serving a stateless MCP initialization response", async () => {
    const actor = { workspaceId: "workspace_a", actorType: "service" as const, actorId: "hermes-test" };
    const request = new Request("https://app.example/api/hermes-mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer workspace-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initializeBody),
    });

    const response = await handleHermesMcpPost(request, {
      authenticate: vi.fn().mockResolvedValue(actor),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const payload = await response.json();
    expect(payload).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "flow-bof-managed-content", version: "1.0.0" } },
    });
  });
});
