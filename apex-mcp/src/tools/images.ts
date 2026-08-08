/** Image generation tools: generate and upscale. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MODELS,
  SYNC_GENERATION_TIMEOUT_MS,
} from "../constants.js";
import { compact, expandSlots } from "../services/client.js";
import {
  captchaBody,
  captchaShape,
  mediaGenerationIdParam,
  replyRefParam,
  replyUrlParam,
  responseFormatParam,
  seedParam,
} from "../schemas/common.js";
import { generationResult, result, runTool } from "./shared.js";

export function registerImageTools(server: McpServer): void {
  server.registerTool(
    "google_flow_generate_image",
    {
      title: "Generate Images (Nano Banana / Imagen)",
      description: `Generate still images with Google Flow via useapi.net. Supports plain text-to-image plus reference images and reusable characters for consistent subjects.

Unlike video generation, this endpoint is synchronous by default and usually returns within seconds. The useapi.net docs do not list an 'async' parameter for images, so this tool always waits for the result; use reply_url if your application prefers a webhook.

Returns:
  { "operation": "generate_image", "mode": "sync", "jobId": string, "status": "completed",
    "media": [{ "kind": "image", "mediaGenerationId": string, "url": string,
                "seed": number, "prompt": string, "model": string, "aspectRatio": string }],
    "raw": {...} }

The 'url' field is a signed Google CDN link valid for about 6 hours. When the API returns
inline base64 instead of a URL, the media item is flagged with hasInlineBase64 and the bytes
are available in raw — re-resolve a fresh URL with google_flow_get_asset.

Examples:
  - "Draw a pirate cat on a cruise ship, widescreen, 4 options" -> prompt, aspect_ratio '16:9', count 4
  - "Same character as before, now in a forest" -> characters: ["<ref from google_flow_create_character>"]
  - "Match the style of this image I uploaded" -> upload it, then references: ["<mediaGenerationId>"]
  - Don't use for video — use google_flow_generate_video.

Errors:
  - 400 PUBLIC_ERROR_UNSAFE_GENERATION: prompt content-filtered; rewrite it.
  - 429: throttled on this user's own Google account. Wait and retry.`,
      inputSchema: {
        prompt: z
          .string()
          .min(1, "prompt is required")
          .max(5000)
          .describe("Description of the image to generate."),
        model: z
          .enum(IMAGE_MODELS)
          .optional()
          .describe(
            "nano-banana-2-lite (default, cheapest) | nano-banana-2 | nano-banana-pro (highest quality). " +
              "'nano-banana' and 'imagen-4' still work but are deprecated upstream.",
          ),
        aspect_ratio: z
          .enum(IMAGE_ASPECT_RATIOS)
          .optional()
          .describe(
            "16:9 (default for text-to-image) | 4:3 | 1:1 | 3:4 | 9:16 | auto (only valid when " +
              "references are supplied, on nano-banana-2 and nano-banana-pro).",
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("How many images to generate, 1-4. Default is 4 for this endpoint."),
        seed: seedParam,
        references: z
          .array(z.string())
          .max(10)
          .optional()
          .describe(
            "Up to 10 mediaGenerationIds of uploaded images used to steer style or subject. " +
              "Upload them first with google_flow_upload_asset.",
          ),
        characters: z
          .array(z.string())
          .max(7)
          .optional()
          .describe("Up to 7 character refs from google_flow_create_character, for consistent subjects."),
        reply_url: replyUrlParam,
        reply_ref: replyRefParam,
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
        const raw = await client.request("/images", {
          method: "POST",
          body: compact({
            prompt: params.prompt,
            model: params.model,
            aspectRatio: params.aspect_ratio,
            count: params.count,
            seed: params.seed,
            email: client.email,
            replyUrl: params.reply_url,
            replyRef: params.reply_ref,
            ...expandSlots("reference", params.references, 10),
            ...expandSlots("character", params.characters, 7),
            ...captchaBody(params),
          }),
          timeoutMs: SYNC_GENERATION_TIMEOUT_MS,
        });

        return generationResult(raw, {
          operation: "generate_image",
          isAsync: false,
          format: params.response_format,
        });
      }),
  );

  server.registerTool(
    "google_flow_upscale_image",
    {
      title: "Upscale Image",
      description: `Upscale a generated image to 2K (default) or 4K. This endpoint returns the result as base64 JPEG rather than a URL, so the payload is withheld from the tool result unless include_base64 is set to true.

Note the casing difference from video upscaling: image resolutions are lowercase ('2k', '4k'), video resolutions are '1080p' and '4K'.

Returns:
  { "operation": "upscale_image", "mediaGenerationId": string, "resolution": string,
    "sizeBytes": number, "encodedImage": string | null }

Errors:
  - 403 with a 'captcha_quality: PUBLIC_ERROR_UNUSUAL_ACTIVITY' message on a 4K request usually
    means the account's plan does not include 4K, not an actual captcha failure. Retry at 2k.`,
      inputSchema: {
        media_generation_id: mediaGenerationIdParam,
        resolution: z
          .enum(["2k", "4k"])
          .optional()
          .describe("'2k' (default) or '4k'. 4k requires a paid Google AI subscription."),
        include_base64: z
          .boolean()
          .default(false)
          .describe("Include the base64 JPEG in the result. Off by default to protect context."),
        ...captchaShape,
        response_format: responseFormatParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const raw = await client.request<{ encodedImage?: string }>("/images/upscale", {
          method: "POST",
          body: compact({
            mediaGenerationId: params.media_generation_id,
            resolution: params.resolution,
            ...captchaBody(params),
          }),
          timeoutMs: 180_000,
        });

        const encoded = raw?.encodedImage ?? "";
        const structured = {
          operation: "upscale_image",
          mediaGenerationId: params.media_generation_id,
          resolution: params.resolution ?? "2k",
          sizeBytes: Math.floor((encoded.length * 3) / 4),
          encodedImage: params.include_base64 ? encoded : null,
        };

        const md = [
          "# Image upscaled",
          "",
          `- **source**: \`${params.media_generation_id}\``,
          `- **resolution**: ${structured.resolution}`,
          `- **approx size**: ${(structured.sizeBytes / 1024).toFixed(0)} KB`,
          params.include_base64
            ? "- base64 JPEG included in structuredContent.encodedImage"
            : "- base64 JPEG omitted; call again with include_base64=true if the application needs the bytes",
        ].join("\n");

        return result(structured, md, params.response_format);
      }),
  );
}
