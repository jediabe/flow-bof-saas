/** Reusable character management. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compact } from "../services/client.js";
import { captchaBody, captchaShape, responseFormatParam } from "../schemas/common.js";
import { result, runTool } from "./shared.js";

interface CharacterRecord {
  character?: string;
  entityId?: string;
  displayName?: string;
  personalityNotes?: string;
  voice?: unknown;
  thumbnailUrl?: string;
  createTime?: string;
  updateTime?: string;
}

function renderCharacter(c: CharacterRecord): string {
  return [
    `**${c.displayName ?? "(unnamed)"}**`,
    `- ref: \`${c.character ?? c.entityId ?? "?"}\``,
    c.personalityNotes ? `- notes: ${c.personalityNotes}` : "",
    c.voice ? `- voice: ${typeof c.voice === "string" ? c.voice : JSON.stringify(c.voice)}` : "",
    c.createTime ? `- created: ${c.createTime}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerCharacterTools(server: McpServer): void {
  server.registerTool(
    "google_flow_list_characters",
    {
      title: "List Characters",
      description: `List the reusable characters saved on a Google Flow account. Characters keep a subject visually consistent across multiple generations.

Returns:
  { "count": number,
    "characters": [{ "character": string, "entityId": string, "displayName": string,
                     "personalityNotes": string, "voice": object, "createTime": string }] }

The 'character' field is the ref you pass in the 'characters' array of
google_flow_generate_video or google_flow_generate_image.

Errors:
The account is determined by who is making the request — there is nothing to pass.`,
      inputSchema: {
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
        const raw = (await client.request("/characters", {
          query: { email },
        })) as { characters?: CharacterRecord[] };

        const characters = raw?.characters ?? [];
        const structured = { count: characters.length, email, characters };

        const md = characters.length
          ? `# Characters on ${email} (${characters.length})\n\n${characters.map(renderCharacter).join("\n\n")}`
          : `# No characters saved on ${email}\n\nCreate one with google_flow_create_character.`;

        return result(structured, md, params.response_format);
      }),
  );

  server.registerTool(
    "google_flow_get_character",
    {
      title: "Get Character",
      description: `Retrieve one character, including signed preview URLs for its reference images and, if a voice is attached, a sample audio URL.

Returns:
  { "character": string, "entityId": string, "displayName": string, "personalityNotes": string,
    "imageReferences": [{ "mediaId": string, "previewUrl": string }],
    "thumbnailUrl": string, "voice": { ..., "audioUrl": string } }

Preview URLs are signed and expire in about 6 hours.`,
      inputSchema: {
        character_ref: z
          .string()
          .min(1)
          .describe("The character ref or entityId returned by google_flow_list_characters."),
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
        const raw = (await client.requestById("/characters/", params.character_ref)) as CharacterRecord & { imageReferences?: unknown[] };

        const md = [
          `# ${raw?.displayName ?? "Character"}`,
          "",
          renderCharacter(raw),
          raw?.thumbnailUrl ? `\n- thumbnail: ${raw.thumbnailUrl}` : "",
          Array.isArray(raw?.imageReferences)
            ? `\n- reference images: ${raw.imageReferences.length}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        return result(raw as Record<string, unknown>, md, params.response_format);
      }),
  );

  server.registerTool(
    "google_flow_create_character",
    {
      title: "Create Character",
      description: `Create a reusable character from one or two reference images, so the same subject can appear consistently across generations.

Upload the images first with google_flow_upload_asset (or reuse ids from google_flow_generate_image),
then pass their mediaGenerationIds here. A maximum of two images per character.

Returns:
  { "operation": "create_character", "character": string, "entityId": string,
    "displayName": string, "personalityNotes": string, "voice": object }

Use the returned 'character' ref in the 'characters' array of the generation tools.
Note: on Veo models, characters work only with veo-3.1-fast / veo-3.1-lite at 8 seconds, and
reference images plus characters must total three or fewer. omni-flash allows up to seven.

Examples:
  - "Save this person as 'Detective Ross' so she appears in every scene"
    -> display_name 'Detective Ross', image_references: ["<id>"], voice 'Kore'`,
      inputSchema: {
        display_name: z
          .string()
          .min(1)
          .max(200)
          .describe("Human-readable name for the character, 1-200 characters."),
        image_references: z
          .array(z.string().min(1))
          .min(1, "At least one reference image is required")
          .max(2, "A character can have at most 2 reference images")
          .describe("One or two image mediaGenerationIds defining the character's appearance."),
        personality_notes: z
          .string()
          .max(2000)
          .optional()
          .describe("Optional description of the character's manner and personality, up to 2000 characters."),
        voice: z
          .string()
          .optional()
          .describe(
            "Optional voice: a system preset name such as 'Kore' or 'Puck', or a user voice ref. " +
              "See google_flow_list_voices.",
          ),
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
        const [first, second] = params.image_references;
        const raw = (await client.request("/characters", {
          method: "POST",
          body: compact({
            displayName: params.display_name,
            imageReference_1: first,
            imageReference_2: second,
            personalityNotes: params.personality_notes,
            voice: params.voice,
            ...captchaBody(params),
          }),
        })) as CharacterRecord;

        const md = [
          "# Character created",
          "",
          renderCharacter(raw),
          "",
          "_Pass the ref above in the `characters` array of google_flow_generate_video or google_flow_generate_image._",
        ].join("\n");

        return result(
          { operation: "create_character", ...(raw as Record<string, unknown>) },
          md,
          params.response_format,
        );
      }),
  );

  server.registerTool(
    "google_flow_delete_character",
    {
      title: "Delete Character",
      description: `Permanently delete a reusable character. Any voice attached to it is NOT deleted — remove that separately with google_flow_delete_voice if it is no longer needed.

This cannot be undone. Confirm with the user before calling it.

Returns:
  { "operation": "delete_character", "deleted": boolean, "entityId": string, "character": string }`,
      inputSchema: {
        character_ref: z.string().min(1).describe("Character ref or entityId to delete."),
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
        const raw = (await client.requestById("/characters/", params.character_ref, { method: "DELETE" })) as Record<string, unknown>;

        return result(
          { operation: "delete_character", ...raw },
          `# Character deleted\n\n- ref: \`${params.character_ref}\`\n- deleted: ${raw?.["deleted"] ?? true}\n\n_Any voice attached to this character still exists._`,
          params.response_format,
        );
      }),
  );
}
