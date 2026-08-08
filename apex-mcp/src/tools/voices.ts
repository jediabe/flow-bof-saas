/** Voice listing and custom voice management. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SYSTEM_VOICES } from "../constants.js";
import { compact } from "../services/client.js";
import { captchaBody, captchaShape, responseFormatParam } from "../schemas/common.js";
import { result, runTool } from "./shared.js";

interface VoiceRecord {
  voice?: string;
  source?: string;
  displayName?: string;
  baseVoice?: string;
  sampleUrl?: string;
  audioUrl?: string;
  workflowId?: string;
}

export function registerVoiceTools(server: McpServer): void {
  server.registerTool(
    "google_flow_list_voices",
    {
      title: "List Voices",
      description: `List the voices available on a Google Flow account: the 30 built-in system presets and any custom voices the user has created.

Returns:
  { "count": number, "email": string,
    "voices": [{ "voice": string, "source": "system" | "user", "displayName": string,
                 "baseVoice": string, "sampleUrl": string }] }

Pass a voice name in the 'reference_audio' array of google_flow_generate_video, or as the
'voice' field when creating a character. Names are case-sensitive — use the exact capitalization.

The 30 system voices are: ${SYSTEM_VOICES.join(", ")}.`,
      inputSchema: {
        source: z
          .enum(["system", "user"])
          .optional()
          .describe("Filter to built-in presets or the user's custom voices. Omit for both."),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const email = client.email;
        const raw = (await client.request("/voices", {
          query: compact({ email, source: params.source }) as Record<string, string>,
        })) as { voices?: VoiceRecord[] };

        const voices = raw?.voices ?? [];
        const structured = { count: voices.length, email, voices };

        const system = voices.filter((v) => v.source !== "user");
        const custom = voices.filter((v) => v.source === "user");

        const md = [
          `# Voices on ${email} (${voices.length})`,
          "",
          system.length
            ? `**System presets (${system.length})**: ${system.map((v) => v.voice ?? v.displayName).join(", ")}`
            : "",
          "",
          custom.length
            ? `**Custom voices (${custom.length})**\n\n${custom
                .map(
                  (v) =>
                    `- **${v.displayName ?? v.voice}** — ref \`${v.voice}\`${v.baseVoice ? `, based on ${v.baseVoice}` : ""}`,
                )
                .join("\n")}`
            : "_No custom voices._",
        ]
          .filter(Boolean)
          .join("\n");

        return result(structured, md, params.response_format, "Filter with source='user' to shorten this.");
      }),
  );

  server.registerTool(
    "google_flow_get_voice",
    {
      title: "Get Voice",
      description: `Retrieve one voice by name or ref, including a sample audio URL.

Accepts either a system preset name (e.g. 'Kore') or a custom voice ref.

Returns:
  { "voice": string, "source": "system" | "user", "displayName": string,
    "baseVoice": string, "sampleUrl": string, "audioUrl": string }`,
      inputSchema: {
        voice_ref: z
          .string()
          .min(1)
          .describe("System voice name (exact capitalization, e.g. 'Zephyr') or a custom voice ref."),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const raw = (await client.requestById("/voices/", params.voice_ref)) as VoiceRecord;

        const md = [
          `# ${raw?.displayName ?? params.voice_ref}`,
          "",
          `- ref: \`${raw?.voice ?? params.voice_ref}\``,
          raw?.source ? `- source: ${raw.source}` : "",
          raw?.baseVoice ? `- base voice: ${raw.baseVoice}` : "",
          raw?.sampleUrl ? `- sample: ${raw.sampleUrl}` : "",
          raw?.audioUrl ? `- audio: ${raw.audioUrl}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        return result(raw as Record<string, unknown>, md, params.response_format);
      }),
  );

  server.registerTool(
    "google_flow_create_voice",
    {
      title: "Create Custom Voice",
      description: `Create a custom voice derived from one of the 30 built-in presets, shaped by a short sample line and a performance direction.

Returns:
  { "operation": "create_voice", "voice": string, "source": "user", "displayName": string,
    "baseVoice": string, "dialog": string, "voicePerformance": string, "audioUrl": string }

Use the returned 'voice' ref in reference_audio arrays or when creating a character.

Examples:
  - "Make a gravelly narrator voice based on Charon"
    -> base_voice 'Charon', display_name 'Gravelly Narrator',
       dialog 'The city never really sleeps.', voice_performance 'low, gravelly, unhurried'`,
      inputSchema: {
        base_voice: z
          .enum(SYSTEM_VOICES)
          .describe("System preset to derive from. Case-sensitive."),
        display_name: z.string().min(1).max(200).describe("Name for the new voice, 1-200 characters."),
        dialog: z
          .string()
          .min(1)
          .max(120)
          .describe("Sample line the voice will speak, 1-120 characters."),
        voice_performance: z
          .string()
          .min(1)
          .max(120)
          .describe("Delivery direction, e.g. 'warm and conspiratorial, slightly rushed'. 1-120 characters."),
        ...captchaShape,
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const email = client.email;
        const raw = (await client.request("/voices", {
          method: "POST",
          body: compact({
            email,
            voice: params.base_voice,
            displayName: params.display_name,
            dialog: params.dialog,
            voicePerformance: params.voice_performance,
            ...captchaBody(params),
          }),
          timeoutMs: 180_000,
        })) as VoiceRecord;

        const md = [
          "# Voice created",
          "",
          `- ref: \`${raw?.voice ?? "(not returned)"}\``,
          `- name: ${raw?.displayName ?? params.display_name}`,
          `- based on: ${raw?.baseVoice ?? params.base_voice}`,
          raw?.audioUrl ? `- sample: ${raw.audioUrl}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        return result(
          { operation: "create_voice", ...(raw as Record<string, unknown>) },
          md,
          params.response_format,
        );
      }),
  );

  server.registerTool(
    "google_flow_delete_voice",
    {
      title: "Delete Custom Voice",
      description: `Permanently delete a custom voice. Built-in system presets cannot be deleted and are rejected with a 400.

Characters that referenced the deleted voice keep working but will report the voice as deleted.

This cannot be undone. Confirm with the user before calling it.

Returns:
  { "operation": "delete_voice", "deleted": boolean, "workflowId": string, "voice": string }`,
      inputSchema: {
        voice_ref: z
          .string()
          .min(1)
          .describe("Custom voice ref to delete. System preset names are not accepted."),
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        if ((SYSTEM_VOICES as readonly string[]).includes(params.voice_ref)) {
          throw new Error(
            `Error: '${params.voice_ref}' is a built-in system voice and cannot be deleted. ` +
              "Only custom voices created with google_flow_create_voice can be removed.",
          );
        }

        const raw = (await client.requestById("/voices/", params.voice_ref, { method: "DELETE" })) as Record<string, unknown>;

        return result(
          { operation: "delete_voice", ...raw },
          `# Voice deleted\n\n- ref: \`${params.voice_ref}\`\n- deleted: ${raw?.["deleted"] ?? true}`,
          params.response_format,
        );
      }),
  );
}
