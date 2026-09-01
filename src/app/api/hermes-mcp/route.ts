import {
  handleHermesMcpPost,
  hermesMcpJsonRpcError,
} from "@/lib/hermes-mcp/transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleHermesMcpPost(request);
}

export async function GET(): Promise<Response> {
  return hermesMcpJsonRpcError(405, -32000, "Method not allowed");
}

export async function DELETE(): Promise<Response> {
  return hermesMcpJsonRpcError(405, -32000, "Method not allowed");
}
