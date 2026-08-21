import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERMES_CONTENT_TOOL_NAMES } from "../schemas";
import { createHermesMcpServer } from "../server";

const connected: Array<{ client: Client; server: Awaited<ReturnType<typeof createHermesMcpServer>> }> = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
});

describe("managed content MCP server", () => {
  it("lists exactly the approved managed business tools", async () => {
    const actor = { workspaceId: "workspace_a", actorType: "service" as const, actorId: "hermes-test" };
    const server = createHermesMcpServer(actor);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connected.push({ client, server });

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(HERMES_CONTENT_TOOL_NAMES);
    for (const tool of listed.tools) {
      const serializedSchema = JSON.stringify(tool.inputSchema);
      expect(serializedSchema, `${tool.name} must advertise closed object schemas`).toContain(
        '"additionalProperties":false',
      );
    }
  });

  it("binds calls to handlers created with the authenticated actor", async () => {
    const actor = { workspaceId: "workspace_a", actorType: "service" as const, actorId: "hermes-test" };
    const content_get_product = vi.fn().mockResolvedValue({ id: "product_1", name: "Example" });
    const createHandlers = vi.fn().mockReturnValue({
      content_get_product,
      content_create_run: vi.fn(),
      content_generate_image: vi.fn(),
      content_generate_video: vi.fn(),
      content_run_qa: vi.fn(),
      content_run_final_output: vi.fn(),
      content_get_run: vi.fn(),
    });
    const server = createHermesMcpServer(actor, { createHandlers });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connected.push({ client, server });

    const result = await client.callTool({ name: "content_get_product", arguments: { productId: "product_1" } });

    expect(createHandlers).toHaveBeenCalledWith(actor);
    expect(content_get_product).toHaveBeenCalledWith({ productId: "product_1" });
    expect(result.structuredContent).toEqual({ id: "product_1", name: "Example" });
  });
});
