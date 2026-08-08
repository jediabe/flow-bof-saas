/** Video generation tools: generate, extend, upscale, gif, concatenate. */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EXTEND_MODELS,
  SYNC_GENERATION_TIMEOUT_MS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODELS,
} from "../constants.js";
import { compact, expandSlots } from "../services/client.js";
import {
  asyncParam,
  captchaBody,
  captchaShape,
  mediaGenerationIdParam,
  replyRefParam,
  replyUrlParam,
  responseFormatParam,
  seedParam,
} from "../schemas/common.js";
import { generationResult, result, runTool } from "./shared.js";
import { ResponseFormat } from "../types.js";

const generateVideoShape = {
  prompt: z
    .string()
    .min(1, "prompt is required")
    .max(5000)
    .describe(
      "Scene description. May contain inline slot markers that must each have a matching " +
        "parameter: @character_1..7, @referenceImage_1..7, @referenceAudio_1..5. " +
        "@referenceVideo is NOT valid inline and causes a 400.",
    ),
  model: z
    .enum(VIDEO_MODELS)
    .default("veo-3.1-fast")
    .describe(
      "veo-3.1-fast (20 credits, default) | veo-3.1-lite (10) | veo-3.1-quality (100, no reference " +
        "images or characters) | veo-3.1-lite-low-priority (free, Google AI Ultra $199 tier only) | " +
        "omni-flash (15/20/25/30 by duration; audio-native, supports reference video editing).",
    ),
  aspect_ratio: z
    .enum(VIDEO_ASPECT_RATIOS)
    .optional()
    .describe(
      "Default 'landscape'. Veo accepts landscape|portrait|1:1|4:3|3:4. omni-flash accepts landscape|portrait only.",
    ),
  duration: z
    .union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)])
    .optional()
    .describe(
      "Seconds. Veo: 4, 6, or 8 (4 and 6 require a Google AI Ultra account); default 8. " +
        "omni-flash: 4, 6, 8, or 10. Must be omitted for omni-flash video-to-video edits.",
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Number of variations to generate, 1-4. Default 1. Each variation costs full credits."),
  seed: seedParam,
  start_image: z
    .string()
    .optional()
    .describe("mediaGenerationId of the first frame. Switches to image-to-video mode."),
  end_image: z
    .string()
    .optional()
    .describe(
      "mediaGenerationId of the last frame, for first-and-last-frame interpolation. " +
        "Requires start_image. Veo models only — not supported by omni-flash.",
    ),
  reference_images: z
    .array(z.string())
    .max(7)
    .optional()
    .describe(
      "mediaGenerationIds used as style/subject references. Veo: max 3 and not supported on " +
        "veo-3.1-quality. omni-flash: max 7. Combined reference_images + characters must be <= 3 on Veo.",
    ),
  characters: z
    .array(z.string())
    .max(7)
    .optional()
    .describe(
      "Character refs from google_flow_create_character. Veo fast/lite only, 8s duration only, " +
        "and combined with reference_images must total <= 3. omni-flash allows up to 7 at any duration.",
    ),
  reference_audio: z
    .array(z.string())
    .max(5)
    .optional()
    .describe(
      "System voice names (e.g. 'Kore', 'Puck') or user voice refs. Veo accepts exactly 1 and only " +
        "in reference-to-video mode. omni-flash accepts up to 5 (or 3 for video-to-video edits). " +
        "Call google_flow_list_voices for the available names.",
    ),
  reference_video: z
    .string()
    .optional()
    .describe(
      "mediaGenerationId of an uploaded MP4 to edit (video-to-video). omni-flash only. " +
        "Cannot be combined with start_image or end_image, and duration must be omitted.",
    ),
  start_frame_index: z
    .number()
    .int()
    .min(0)
    .max(239)
    .optional()
    .describe("Video-to-video trim start on a 24fps timeline (0-239). omni-flash only. Default 0."),
  end_frame_index: z
    .number()
    .int()
    .min(1)
    .max(240)
    .optional()
    .describe(
      "Video-to-video trim end on a 24fps timeline (1-240, 240 = 10s). Must exceed start_frame_index. omni-flash only.",
    ),
  async: asyncParam,
  reply_url: replyUrlParam,
  reply_ref: replyRefParam,
  ...captchaShape,
  response_format: responseFormatParam,
};

const extendVideoShape = {
  media_generation_id: mediaGenerationIdParam.describe(
    "mediaGenerationId of the Veo-generated video to extend. omni-flash videos cannot be extended.",
  ),
  prompt: z
    .string()
    .min(1)
    .max(5000)
    .describe("What should happen in the appended ~8 seconds."),
  model: z
    .enum(EXTEND_MODELS)
    .optional()
    .describe("Default veo-3.1-fast. omni-flash is not supported for extension."),
  count: z.number().int().min(1).max(4).optional().describe("Number of variations, 1-4. Default 1."),
  seed: seedParam,
  async: asyncParam,
  reply_url: replyUrlParam,
  reply_ref: replyRefParam,
  ...captchaShape,
  response_format: responseFormatParam,
};

const upscaleVideoShape = {
  media_generation_id: mediaGenerationIdParam,
  resolution: z
    .enum(["1080p", "4K"])
    .optional()
    .describe(
      "'1080p' (default, free) or '4K' (50 credits, Google AI Ultra only). " +
        "Note the capital K — image upscaling uses lowercase '2k'/'4k' instead.",
    ),
  async: asyncParam,
  reply_url: replyUrlParam,
  reply_ref: replyRefParam,
  ...captchaShape,
  response_format: responseFormatParam,
};

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "google_flow_generate_video",
    {
      title: "Generate Video (Veo 3.1 / Gemini Omni Flash)",
      description: `Generate an AI video with Google Flow via useapi.net. Supports text-to-video, image-to-video, first-and-last-frame interpolation, reference-to-video, and (omni-flash only) video-to-video editing.

Modes are selected implicitly by which parameters you pass:
  - text-to-video:        prompt only
  - image-to-video:       + start_image
  - first/last frame:     + start_image and end_image (Veo only)
  - reference-to-video:   + reference_images and/or characters and/or reference_audio
  - video-to-video edit:  + reference_video (omni-flash only; omit duration)

Returns (async=true, the default):
  { "operation": "generate_video", "mode": "async", "jobId": string, "status": "created", "media": [], "raw": {...} }
  Poll google_flow_get_job with the jobId. Generation typically takes 60-180 seconds.

Returns (async=false):
  { "operation": "generate_video", "mode": "sync", "jobId": string, "status": "completed",
    "media": [{ "kind": "video", "mediaGenerationId": string, "url": string, "thumbnailUrl": string,
                "seed": number, "model": string, "aspectRatio": string, "durationSeconds": number }],
    "remainingCredits": number, "raw": {...} }

Examples:
  - "Make an 8s cinematic shot of a lighthouse in a storm" -> prompt + model 'veo-3.1-fast'
  - "Animate this photo I uploaded" -> upload with google_flow_upload_asset, then pass start_image
  - "Have the character speak with the Kore voice" -> model 'omni-flash', characters: ["..."], reference_audio: ["Kore"]
  - Don't use for still images — use google_flow_generate_image instead.

Errors:
  - 402: not enough credits, or the model needs a higher Google AI tier. Check google_flow_get_account.
  - 400 PUBLIC_ERROR_UNSAFE_GENERATION: the prompt was content-filtered; rewrite it.
  - 429: throttled on this user's own Google account. Wait and retry; there is no other account to fall back to.`,
      inputSchema: generateVideoShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const body = compact({
          prompt: params.prompt,
          model: params.model,
          aspectRatio: params.aspect_ratio,
          duration: params.duration,
          count: params.count,
          seed: params.seed,
          email: client.email,
          startImage: params.start_image,
          endImage: params.end_image,
          referenceVideo_1: params.reference_video,
          startFrameIndex_1: params.start_frame_index,
          endFrameIndex_1: params.end_frame_index,
          async: params.async,
          replyUrl: params.reply_url,
          replyRef: params.reply_ref,
          ...expandSlots("referenceImage", params.reference_images, 7),
          ...expandSlots("character", params.characters, 7),
          ...expandSlots("referenceAudio", params.reference_audio, 5),
          ...captchaBody(params),
        });

        const raw = await client.request("/videos", {
          method: "POST",
          body,
          timeoutMs: params.async ? undefined : SYNC_GENERATION_TIMEOUT_MS,
        });

        return generationResult(raw, {
          operation: "generate_video",
          isAsync: params.async,
          format: params.response_format,
        });
      }),
  );

  server.registerTool(
    "google_flow_extend_video",
    {
      title: "Extend Video",
      description: `Append roughly 8 more seconds to an existing Veo-generated video, continuing from its final frame with about 1 second of overlap. The extension inherits the source video's aspect ratio, so there is no aspect_ratio or duration parameter.

Only Veo-generated videos can be extended — omni-flash output cannot.

Returns the same shape as google_flow_generate_video: a jobId when async=true (the default), or a completed media array when async=false.

Examples:
  - "Keep the scene going, the ship sails out of frame" -> media_generation_id + prompt
  - Don't use to change an existing video's style — that needs google_flow_generate_video with reference_video on omni-flash.

Errors:
  - 400: the source video was made with omni-flash, or the mediaGenerationId refers to an image.`,
      inputSchema: extendVideoShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const raw = await client.request("/videos/extend", {
          method: "POST",
          body: compact({
            mediaGenerationId: params.media_generation_id,
            prompt: params.prompt,
            model: params.model,
            count: params.count,
            seed: params.seed,
            async: params.async,
            replyUrl: params.reply_url,
            replyRef: params.reply_ref,
            ...captchaBody(params),
          }),
          timeoutMs: params.async ? undefined : SYNC_GENERATION_TIMEOUT_MS,
        });

        return generationResult(raw, {
          operation: "extend_video",
          isAsync: params.async,
          format: params.response_format,
        });
      }),
  );

  server.registerTool(
    "google_flow_upscale_video",
    {
      title: "Upscale Video",
      description: `Upscale a generated video to 1080p (free) or 4K (50 credits, Google AI Ultra accounts only). Re-upscaling the same video returns a cached result at no additional cost.

Typically takes 30-60 seconds for 1080p and a few minutes for 4K.

Returns the same shape as google_flow_generate_video, with a new mediaGenerationId for the upscaled asset.

Errors:
  - 403: 4K requested on an account whose plan does not include it.`,
      inputSchema: upscaleVideoShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) =>
      runTool(async (client) => {
        const raw = await client.request("/videos/upscale", {
          method: "POST",
          body: compact({
            mediaGenerationId: params.media_generation_id,
            resolution: params.resolution,
            async: params.async,
            replyUrl: params.reply_url,
            replyRef: params.reply_ref,
            ...captchaBody(params),
          }),
          timeoutMs: params.async ? undefined : SYNC_GENERATION_TIMEOUT_MS,
        });

        return generationResult(raw, {
          operation: "upscale_video",
          isAsync: params.async,
          format: params.response_format,
        });
      }),
  );

  server.registerTool(
    "google_flow_video_to_gif",
    {
      title: "Convert Video to GIF",
      description: `Convert a generated video into an animated GIF. Synchronous, takes up to 90 seconds.

Because the API returns the GIF as base64 rather than a URL, this tool does NOT put the payload in the conversation — that would flood the context. It returns the byte size and a base64 string only when include_base64 is explicitly set to true.

Returns:
  { "operation": "video_to_gif", "mediaGenerationId": string, "sizeBytes": number,
    "encodedGif": string | null }

Errors:
  - 400: the mediaGenerationId refers to an image, not a video.`,
      inputSchema: {
        media_generation_id: mediaGenerationIdParam,
        include_base64: z
          .boolean()
          .default(false)
          .describe(
            "Set true only if the calling application needs the raw base64 GIF in the tool result. " +
              "Leaving it false keeps large payloads out of the model's context.",
          ),
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
        const raw = await client.request<{ encodedGif?: string }>("/videos/gif", {
          method: "POST",
          body: { mediaGenerationId: params.media_generation_id },
          timeoutMs: 120_000,
        });

        const encoded = raw?.encodedGif ?? "";
        const structured = {
          operation: "video_to_gif",
          mediaGenerationId: params.media_generation_id,
          sizeBytes: Math.floor((encoded.length * 3) / 4),
          encodedGif: params.include_base64 ? encoded : null,
        };

        const md = [
          "# GIF created",
          "",
          `- **source**: \`${params.media_generation_id}\``,
          `- **approx size**: ${(structured.sizeBytes / 1024).toFixed(0)} KB`,
          params.include_base64
            ? "- base64 payload included in structuredContent.encodedGif"
            : "- base64 payload omitted; call again with include_base64=true if the application needs the bytes",
        ].join("\n");

        return result(structured, md, params.response_format);
      }),
  );

  server.registerTool(
    "google_flow_concatenate_videos",
    {
      title: "Concatenate Videos",
      description: `Join 2-10 generated videos into a single MP4, with optional per-clip trimming. All inputs must share the same aspect ratio and belong to the same Google Flow account. Takes about 15-20 seconds.

The API returns the result as base64 (roughly 7 MB per input clip), so as with GIF conversion the payload is withheld unless include_base64 is true.

Returns:
  { "operation": "concatenate_videos", "jobId": string, "status": string,
    "inputsCount": number, "sizeBytes": number, "encodedVideo": string | null }

Examples:
  - "Stitch these three clips into one, dropping the first half-second of each"
    -> clips: [{media_generation_id, trim_start: 0.5}, ...]

Errors:
  - 400: mixed aspect ratios, fewer than 2 clips, or clips from different accounts.`,
      inputSchema: {
        clips: z
          .array(
            z.object({
              media_generation_id: z.string().min(1).describe("mediaGenerationId of this clip."),
              trim_start: z
                .number()
                .min(0)
                .max(8)
                .optional()
                .describe("Seconds to trim from the start of this clip, 0-8. Default 0."),
              trim_end: z
                .number()
                .min(0)
                .max(8)
                .optional()
                .describe("Seconds to trim from the end of this clip, 0-8. Default 0."),
            }),
          )
          .min(2, "At least 2 clips are required")
          .max(10, "At most 10 clips are allowed")
          .describe("Clips to join, in output order."),
        include_base64: z
          .boolean()
          .default(false)
          .describe("Include the base64 MP4 in the result. Off by default to protect context."),
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
        const raw = await client.request<{
          jobId?: string;
          status?: string;
          inputsCount?: number;
          encodedVideo?: string;
        }>("/videos/concatenate", {
          method: "POST",
          body: {
            media: params.clips.map((c) =>
              compact({
                mediaGenerationId: c.media_generation_id,
                trimStart: c.trim_start,
                trimEnd: c.trim_end,
              }),
            ),
          },
          timeoutMs: 240_000,
        });

        const encoded = raw?.encodedVideo ?? "";
        const structured = {
          operation: "concatenate_videos",
          jobId: raw?.jobId ?? null,
          status: raw?.status ?? "unknown",
          inputsCount: raw?.inputsCount ?? params.clips.length,
          sizeBytes: Math.floor((encoded.length * 3) / 4),
          encodedVideo: params.include_base64 ? encoded : null,
        };

        const md = [
          "# Videos concatenated",
          "",
          `- **status**: ${structured.status}`,
          `- **clips joined**: ${structured.inputsCount}`,
          `- **approx size**: ${(structured.sizeBytes / 1_048_576).toFixed(1)} MB`,
          params.include_base64
            ? "- base64 MP4 included in structuredContent.encodedVideo"
            : "- base64 MP4 omitted; call again with include_base64=true if the application needs the bytes",
        ].join("\n");

        return result(structured, md, params.response_format);
      }),
  );
}
