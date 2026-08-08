/** Zod fragments reused across tool input schemas. */

import { z } from "zod";
import { ResponseFormat } from "../types.js";

/*
 * There is deliberately no `email` parameter anywhere in this file.
 *
 * The Google Flow account each request runs against is pinned from the signed
 * request context. Exposing it as a tool input would let a confused or
 * prompt-injected model spend a different user's generation credits.
 */

export const responseFormatParam = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for a compact human-readable summary, 'json' for the full structured payload.",
  );

export const asyncParam = z
  .boolean()
  .default(true)
  .describe(
    "true (default): return a jobId immediately and poll with google_flow_get_job. " +
      "false: block until generation finishes — only safe for fast operations, and it " +
      "risks a client timeout on video models that take 60-180s.",
  );

export const replyUrlParam = z
  .string()
  .url()
  .optional()
  .describe(
    "Optional webhook URL. useapi.net POSTs the job payload here on created/started/completed/failed, " +
      "so your application can react without polling.",
  );

export const replyRefParam = z
  .string()
  .max(200)
  .optional()
  .describe("Opaque correlation string echoed back in the webhook payload.");

export const seedParam = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Seed for reproducible generation. Reuse the same seed and prompt to get the same result.");

export const captchaRetryParam = z
  .number()
  .int()
  .min(1)
  .max(10)
  .optional()
  .describe("How many times to retry captcha solving before failing. Default 3.");

export const mediaGenerationIdParam = z
  .string()
  .min(1)
  .describe(
    "mediaGenerationId of an existing asset, e.g. 'user:12345-email:...-video:...'. " +
      "Obtain one from google_flow_generate_video, google_flow_generate_image, or google_flow_upload_asset.",
  );

/** Captcha controls, identical across every generation endpoint. */
export const captchaShape = {
  captcha_token: z
    .string()
    .optional()
    .describe("Pre-solved captcha token. Mutually exclusive with captcha_retry/captcha_order."),
  captcha_retry: captchaRetryParam,
  captcha_order: z
    .string()
    .optional()
    .describe("Comma-separated captcha provider order, e.g. 'capsolver,anticaptcha'."),
};

/** Maps the snake_case tool params above onto the API's camelCase body keys. */
export function captchaBody(params: {
  captcha_token?: string | undefined;
  captcha_retry?: number | undefined;
  captcha_order?: string | undefined;
}): Record<string, unknown> {
  return {
    captchaToken: params.captcha_token,
    captchaRetry: params.captcha_retry,
    captchaOrder: params.captcha_order,
  };
}
