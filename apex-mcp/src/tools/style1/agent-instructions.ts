/**
 * Style 1 agent instructions — loads the rev-3 spec from
 * apex-mcp/docs/STYLE-1-SOP.md at module init and serves it
 * to callers of the style1_flow_agent_v3 MCP prompt.
 *
 * Mirrors the style2 loader — same single-source-of-truth
 * pattern, same failure-mode handling. See
 * apex-mcp/src/tools/style2/agent-instructions.ts for the
 * full rationale.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(HERE, "../../../docs/STYLE-1-SOP.md");

let cachedInstructions: string | null = null;

export function getStyle1AgentInstructions(): string {
  if (cachedInstructions !== null) return cachedInstructions;
  try {
    cachedInstructions = readFileSync(DOC_PATH, "utf8");
    console.log(
      `[style1] loaded agent instructions from ${DOC_PATH} (${cachedInstructions.length} chars)`,
    );
    return cachedInstructions;
  } catch (err) {
    const message = (err as Error).message?.slice(0, 200);
    console.warn(
      `[style1] FAILED to load STYLE-1-SOP.md from ${DOC_PATH}: ${message}. Prompt will serve a stub.`,
    );
    cachedInstructions =
      "# Style 1 instructions unavailable\n\n" +
      `Could not read STYLE-1-SOP.md at ${DOC_PATH}: ${message}\n\n` +
      "This usually means the Dockerfile isn't copying docs/ into the image, " +
      "or the file was removed. Check the deployment and restart the MCP.";
    return cachedInstructions;
  }
}
