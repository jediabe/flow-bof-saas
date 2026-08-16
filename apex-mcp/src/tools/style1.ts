/**
 * Style 1 MCP prompt registration.
 *
 * Style 1 (Store Discovery) has no pure/tool logic like Style 2
 * — it's a two-scene image+video chain that the chat agent
 * drives directly via google_flow_generate_image /
 * google_flow_generate_video. This module exists solely to
 * expose the rev-3 spec (from docs/STYLE-1-SOP.md) as an MCP
 * prompt so the chat agent can fetch it server-side and inline
 * it into its system prompt — matching the style2_flow_agent_v6
 * pattern.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStyle1AgentInstructions } from "./style1/agent-instructions.js";

export function registerStyle1Tools(server: McpServer): void {
  registerFlowAgentV3Prompt(server);
}

function registerFlowAgentV3Prompt(server: McpServer): void {
  server.registerPrompt(
    "style1_flow_agent_v3",
    {
      title: "Style 1 · Flow-agent instructions (rev 3.1)",
      description:
        "Full Style 1 (Store Discovery) instructions for a chat agent that will drive the two-scene image + video chain end-to-end via google_flow_generate_image and google_flow_generate_video. Enforces model lock (veo-3.1-lite + Nano), the strict attachment rule (video calls take startImage only — never referenceImages/characters alongside a start frame, per the confirmed-live Flow constraint), the market/room table, and the four fixed prompt templates for Scene 1 image/video and Scene 2 image/video. Load at the start of any Style 1 conversation via prompts/get.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: getStyle1AgentInstructions(),
          },
        },
      ],
    }),
  );
}
