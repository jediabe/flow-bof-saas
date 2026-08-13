/**
 * Style 2 agent instructions — loads the rev-6 spec from
 * apex-mcp/docs/STYLE-2-SOP.md at module init and serves it
 * to callers of the style2_flow_agent_v6 MCP prompt.
 *
 * Single source of truth: the .md file. That's the human-
 * readable doc AND what the prompt serves — if a change lands
 * in the .md, the next process restart picks it up
 * automatically. No manual sync between two copies.
 *
 * File-system access is scoped to a single readFileSync at
 * import time (cached module-scoped), so the prompt handler
 * itself does no I/O per request.
 *
 * Runtime layout:
 *   dev  (tsx): src/tools/style2/agent-instructions.ts
 *               → ../../../docs/STYLE-2-SOP.md
 *   prod (dist): /app/dist/tools/style2/agent-instructions.js
 *               → /app/docs/STYLE-2-SOP.md
 *   The Dockerfile copies docs/ into /app/docs at image build.
 *
 * Failure mode: if the doc file is missing (bad deployment,
 * removed .md), we log loudly + serve a clear "instructions
 * unavailable" stub. That prevents a boot crash and gives the
 * operator something greppable in docker logs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(HERE, "../../../docs/STYLE-2-SOP.md");

let cachedInstructions: string | null = null;

/** Return the rev-6 Style 2 agent instructions. Cached after
 *  first read; safe to call repeatedly. */
export function getStyle2AgentInstructions(): string {
  if (cachedInstructions !== null) return cachedInstructions;
  try {
    cachedInstructions = readFileSync(DOC_PATH, "utf8");
    console.log(
      `[style2] loaded agent instructions from ${DOC_PATH} (${cachedInstructions.length} chars)`,
    );
    return cachedInstructions;
  } catch (err) {
    const message = (err as Error).message?.slice(0, 200);
    console.warn(
      `[style2] FAILED to load STYLE-2-SOP.md from ${DOC_PATH}: ${message}. Prompt will serve a stub.`,
    );
    cachedInstructions =
      "# Style 2 instructions unavailable\n\n" +
      `Could not read STYLE-2-SOP.md at ${DOC_PATH}: ${message}\n\n` +
      "This usually means the Dockerfile isn't copying docs/ into the image, " +
      "or the file was removed. Check the deployment and restart the MCP.";
    return cachedInstructions;
  }
}
