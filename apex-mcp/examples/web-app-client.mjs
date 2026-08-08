/**
 * Example: driving the Google Flow MCP server from a web application backend.
 *
 * The browser talks to your app; your app runs the model loop and speaks MCP to
 * this server. The MCP server is never exposed to the browser.
 *
 *   browser ──> your web app ──MCP/HTTP──> APEX MCP ──REST──> useapi.net
 *                    │
 *                    └──> Anthropic API (the model loop)
 *
 * There is one useapi.net token and it lives on the MCP server. What varies per
 * request is which Google Flow account to act as — an email address your app
 * already knows, put inside a token your app signs.
 *
 * Run:
 *   npm i @modelcontextprotocol/sdk @anthropic-ai/sdk jsonwebtoken
 *   MCP_URL=http://localhost:3000/mcp \
 *   APEX_JWT_SECRET=... APEX_SERVICE_KEY=... ANTHROPIC_API_KEY=... \
 *   DEMO_FLOW_EMAIL=your-flow-account@gmail.com \
 *   node examples/web-app-client.mjs "make an 8 second video of a lighthouse in a storm"
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Anthropic from "@anthropic-ai/sdk";
import jwt from "jsonwebtoken";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3000/mcp";
const ADMIN_BASE = MCP_URL.replace(/\/mcp$/, "");
const MODEL = process.env.MODEL ?? "claude-sonnet-4-5";

/* ===================================================================== *
 * 1. Onboarding — connecting a user's Google Flow account
 *
 * There is no OAuth for this. The user copies their Google session cookies
 * out of DevTools and pastes them into your UI; you forward them here once
 * and never store them. What you keep is the returned email address.
 * ===================================================================== */

export async function connectFlowAccount({ userId, cookies }) {
  const res = await fetch(`${ADMIN_BASE}/admin/accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.APEX_SERVICE_KEY}`,
    },
    body: JSON.stringify({ cookies }),
  });

  const body = await res.json();
  if (!res.ok) {
    // code === "invalid_cookies" means show the user the capture steps again.
    throw Object.assign(new Error(body.error), { code: body.code });
  }

  // THIS is what you persist, in your own users table. It is not a secret.
  //   UPDATE users SET flow_email = $1 WHERE id = $2
  await yourDatabase.setFlowEmail(userId, body.email);

  return body.email;
}

/**
 * Poll before a session goes stale. `healthy: false` means the user must
 * reconnect — usually because they opened Google Flow in their own browser,
 * which invalidates the session the API holds. Retrying never fixes it.
 */
export async function checkFlowAccount(flowEmail) {
  const res = await fetch(
    `${ADMIN_BASE}/admin/accounts/${encodeURIComponent(flowEmail)}`,
    { headers: { Authorization: `Bearer ${process.env.APEX_SERVICE_KEY}` } },
  );
  return res.json(); // { email, health, healthy, credits, ... }
}

export async function disconnectFlowAccount(flowEmail) {
  await fetch(`${ADMIN_BASE}/admin/accounts/${encodeURIComponent(flowEmail)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${process.env.APEX_SERVICE_KEY}` },
  });
}

/* ===================================================================== *
 * 2. The model loop
 * ===================================================================== */

/**
 * Mints a short-lived token naming the user and the Google Flow account to act
 * as. The email must be in the signed payload — the MCP server rejects it from
 * a header or a tool argument, so a prompt-injected model cannot redirect
 * generation onto someone else's account and spend their credits.
 */
function mintUserToken({ userId, flowEmail }) {
  return jwt.sign({ sub: userId, flow_email: flowEmail }, process.env.APEX_JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "5m",
  });
}

async function connectMcp({ userId, flowEmail }) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${mintUserToken({ userId, flowEmail })}` },
    },
  });

  const client = new Client({ name: "apex-web-app", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function toAnthropicTools(mcpTools) {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * One turn of the agent loop. Video jobs are asynchronous, so the model will
 * typically call google_flow_generate_video and then google_flow_get_job
 * several times. Give it enough iterations, and stream progress to your UI.
 */
export async function runAgentTurn({ userId, flowEmail, userMessage, onProgress = () => {} }) {
  const anthropic = new Anthropic();
  const mcp = await connectMcp({ userId, flowEmail });

  try {
    const { tools } = await mcp.listTools();
    const anthropicTools = toAnthropicTools(tools);
    const messages = [{ role: "user", content: userMessage }];

    for (let iteration = 0; iteration < 40; iteration++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        tools: anthropicTools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          onProgress({ type: "text", text: block.text });
        }
      }

      if (response.stop_reason !== "tool_use") {
        return { messages, final: response };
      }

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const toolResults = [];

      for (const call of toolUses) {
        onProgress({ type: "tool_call", name: call.name, input: call.input });

        try {
          const result = await mcp.callTool({ name: call.name, arguments: call.input });

          // structuredContent carries the same data as the text, already
          // machine-readable — that is what your UI should render media from.
          onProgress({
            type: "tool_result",
            name: call.name,
            structured: result.structuredContent,
            isError: Boolean(result.isError),
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: result.content ?? [{ type: "text", text: "(no content)" }],
            is_error: Boolean(result.isError),
          });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: [{ type: "text", text: `Tool transport error: ${error.message}` }],
            is_error: true,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });

      // A short pause keeps the model from burning iterations polling a job
      // that is only a few seconds old.
      if (toolUses.some((c) => c.name === "google_flow_get_job")) {
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }

    throw new Error("Agent loop exceeded 40 iterations without finishing.");
  } finally {
    await mcp.close();
  }
}

/* --------------------------------------------------------------------- *
 * Stand-in for your ORM, so this file runs as-is.
 * --------------------------------------------------------------------- */
const yourDatabase = {
  async setFlowEmail(userId, email) {
    console.log(`[db] users(${userId}).flow_email = ${email}`);
  },
};

/* --------------------------------------------------------------------- *
 * CLI demo
 * --------------------------------------------------------------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
  const flowEmail = process.env.DEMO_FLOW_EMAIL;
  if (!flowEmail) {
    console.error("Set DEMO_FLOW_EMAIL to a connected Google Flow account.");
    process.exit(1);
  }

  await runAgentTurn({
    userId: process.env.DEMO_USER_ID ?? "demo-user-1",
    flowEmail,
    userMessage: process.argv[2] ?? "How many credits do I have left?",
    onProgress: (event) => {
      if (event.type === "text") console.log(`\n${event.text}`);
      if (event.type === "tool_call")
        console.log(`  → ${event.name}(${JSON.stringify(event.input).slice(0, 160)})`);
      if (event.type === "tool_result")
        console.log(`  ← ${event.name} ${event.isError ? "FAILED" : "ok"}`);
    },
  });
}
