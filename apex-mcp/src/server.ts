/** MCP server construction. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerAllTools } from "./tools/index.js";

const INSTRUCTIONS = `This server generates images and video through Google Flow (Veo 3.1, Gemini Omni Flash, Nano Banana) via useapi.net.

Two things shape almost every workflow here:

1. Video generation is asynchronous. google_flow_generate_video returns a jobId immediately;
   poll google_flow_get_job roughly every 15 seconds until status is 'completed' or 'failed'.
   Typical completion is 60-180 seconds. Image generation, by contrast, returns results inline.

2. Everything is addressed by mediaGenerationId. Uploading a file, generating an image, or
   generating a video all yield one, and that id is what you pass to use the asset as a start
   frame, a style reference, a character image, or the source of an edit. Download URLs are
   signed and expire in about 6 hours — re-resolve them with google_flow_get_asset rather than
   reusing a stale link.

Generation costs credits against the user's own Google AI subscription. Before an expensive
render (veo-3.1-quality costs 100 credits), check the balance with google_flow_get_account.
Model availability depends on the account's paygate tier, so a 402 or 403 usually means the
plan does not include what was asked for rather than that the request was malformed.

There is no account-selection parameter anywhere in these tools. Every call runs against the
Google Flow account belonging to whoever is making the request, determined outside the
conversation. If a tool reports that the account's session is broken (596), the user has to
reconnect their Google account — say so and stop, rather than retrying.`;

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerAllTools(server);
  return server;
}
