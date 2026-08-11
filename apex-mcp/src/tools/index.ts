/** Registers every tool on an McpServer instance. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAccountTools } from "./accounts.js";
import { registerAssetTools } from "./assets.js";
import { registerCharacterTools } from "./characters.js";
import { registerImageTools } from "./images.js";
import { registerJobTools } from "./jobs.js";
import { registerVideoTools } from "./videos.js";
import { registerVoiceTools } from "./voices.js";
import { registerStyle2Tools } from "./style2.js";
import { registerCaptchaTools } from "./captcha.js";

export function registerAllTools(server: McpServer): void {
  registerAccountTools(server);
  registerAssetTools(server);
  registerImageTools(server);
  registerVideoTools(server);
  registerJobTools(server);
  registerCharacterTools(server);
  registerVoiceTools(server);
  registerStyle2Tools(server);
  registerCaptchaTools(server);
}
