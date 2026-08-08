/**
 * Job polling.
 *
 * There is no "list jobs" tool. useapi.net's `GET /jobs` reports statistics for
 * every account on the subscription — every one of your users — so it lives on
 * the admin API behind the service key, not in a tool an end user can reach.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  jobIdMatchesAccount,
  normalizeJob,
  normalizeMediaList,
  readRemainingCredits,
} from "../services/client.js";
import { responseFormatParam } from "../schemas/common.js";
import { renderMedia, result, runTool } from "./shared.js";

export function registerJobTools(server: McpServer): void {
  server.registerTool(
    "google_flow_get_job",
    {
      title: "Get Job Status",
      description: `Poll an asynchronous Google Flow generation job and, once it is finished, retrieve its results.

Job lifecycle: created -> started -> completed, or -> failed.

Returns:
  { "jobId": string,
    "type": "video" | "image",
    "status": "created" | "started" | "completed" | "failed",
    "isTerminal": boolean,
    "created": string, "updated": string,
    "media": [{ "kind", "mediaGenerationId", "url", "thumbnailUrl", "seed", "model", "aspectRatio", "durationSeconds" }],
    "remainingCredits": number,
    "error": string | null,
    "nextAction": string }

Polling guidance: video jobs generally finish in 60-180 seconds. Wait about 15 seconds between
polls; polling faster wastes calls and can contribute to rate limiting. The 'nextAction' field
in the response says explicitly whether to poll again or stop.

Examples:
  - "Is my video ready?" -> job_id from the earlier google_flow_generate_video call
  - Don't call this for google_flow_generate_image results — those return synchronously.

Errors:
  - 404: unknown jobId, or the job has aged out of useapi.net's retention window.`,
      inputSchema: {
        job_id: z
          .string()
          .min(1)
          .describe(
            "Job identifier returned by a generation tool, e.g. " +
              "'j1731859234567v-u12345-email:jo***@gmail.com-bot:google-flow'.",
          ),
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
        // Jobs are scoped to the useapi.net token, which is shared across every
        // user of this deployment. Without this check a caller could read another
        // user's job by replaying its id.
        if (!jobIdMatchesAccount(params.job_id, client.email)) {
          const maskedInJob = /-email:(.+?)-bot:/.exec(params.job_id)?.[1] ?? "(none found)";
          throw new Error(
            `Error: that jobId belongs to a different Google Flow account. ` +
              `The jobId names '${maskedInJob}' but this request is for '${client.email}'. ` +
              "Only jobs started by this user can be polled.",
          );
        }

        const raw = await client.requestById("/jobs/", params.job_id);
        const job = normalizeJob(raw);
        const media = normalizeMediaList(job.response?.["media"]);
        const isTerminal = job.status === "completed" || job.status === "failed";

        const errorText =
          job.status === "failed"
            ? String(
                job.error ??
                  (job.response?.["error"] as Record<string, unknown> | undefined)?.["message"] ??
                  "Job failed without a message.",
              )
            : null;

        const nextAction = isTerminal
          ? job.status === "completed"
            ? "Done. Media URLs are signed and expire in roughly 6-24 hours — download them or re-resolve with google_flow_get_asset."
            : "Do not poll again. Inspect the error, adjust the request, and resubmit."
          : "Not finished. Wait about 15 seconds and call google_flow_get_job again.";

        const structured = {
          jobId: job.jobId || params.job_id,
          type: job.type,
          status: job.status,
          isTerminal,
          created: job.created ?? null,
          updated: job.updated ?? null,
          media,
          remainingCredits: readRemainingCredits(raw) ?? null,
          error: errorText,
          nextAction,
          raw,
        };

        const md = [
          `# Job ${job.status}`,
          "",
          `- **jobId**: \`${structured.jobId}\``,
          `- **type**: ${job.type}`,
          job.created ? `- **created**: ${job.created}` : "",
          job.updated ? `- **updated**: ${job.updated}` : "",
          structured.remainingCredits !== null
            ? `- **remaining credits**: ${structured.remainingCredits}`
            : "",
          errorText ? `\n**Error**: ${errorText}` : "",
          media.length ? `\n## Results\n\n${renderMedia(media)}` : "",
          `\n_${nextAction}_`,
        ]
          .filter(Boolean)
          .join("\n");

        return result(structured, md, params.response_format);
      }),
  );
}
