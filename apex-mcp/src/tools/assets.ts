/** Asset upload and signed-URL resolution. */

import { z } from "zod";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UPLOAD_MIME_TYPES, UPLOAD_TIMEOUT_MS } from "../constants.js";
import { mediaGenerationIdParam, responseFormatParam } from "../schemas/common.js";
import { result, runTool } from "./shared.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * Blocks requests to loopback, link-local, and RFC1918 addresses.
 *
 * source_url lets a model hand this server an arbitrary URL to fetch, which is
 * a server-side request forgery vector into whatever private network the server
 * runs in. Resolving the host first and rejecting private targets closes it.
 */
function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === "::1" || v6 === "::") return true;
    if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // unique local
    if (v6.startsWith("fe80")) return true; // link local
    // IPv4-mapped IPv6, e.g. ::ffff:10.0.0.1
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a = 0, b = 0] = parts;

  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link local / cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Error: '${rawUrl}' is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Error: source_url must use http or https.");
  }

  const host = url.hostname;
  const literal = isIP(host);
  const addresses = literal
    ? [{ address: host }]
    : await dnsLookup(host, { all: true }).catch(() => {
        throw new Error(`Error: could not resolve host '${host}'.`);
      });

  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(
      `Error: refusing to fetch '${host}' because it resolves to a private or reserved address.`,
    );
  }
  return url;
}

async function fetchRemoteFile(
  rawUrl: string,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const url = await assertPublicUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Error: fetching source_url returned HTTP ${res.status}.`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf, contentType: res.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort MIME sniffing from magic bytes, used when no hint is supplied. */
function sniffMimeType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return null;
}

export function registerAssetTools(server: McpServer): void {
  server.registerTool(
    "google_flow_upload_asset",
    {
      title: "Upload Image or Video Asset",
      description: `Upload an image or MP4 to a Google Flow account so it can be used as a start/end frame, a style reference, a character image, or the source of a video-to-video edit.

Provide the file either as a public URL (source_url) or as base64 (base64_data), not both.
Prefer source_url — base64 inflates the request and the model's context by about a third.

Limits: PNG, JPEG, and WebP up to 20 MB; MP4 up to 100 MB.

Returns:
  { "operation": "upload_asset", "mediaGenerationId": string, "kind": "image" | "video",
    "mimeType": string, "sizeBytes": number, "width": number, "height": number,
    "durationSeconds": number | null, "email": string }

The returned mediaGenerationId is what you pass to start_image, end_image, reference_images,
reference_video, references, or imageReference on character creation.

Examples:
  - "Animate this photo" -> upload with source_url, then google_flow_generate_video with start_image
  - "Use this as a style reference" -> upload, then pass the id in references

Errors:
  - 400: file too large, unsupported type, or the content was policy-filtered.`,
      inputSchema: {
        source_url: z
          .string()
          .url()
          .optional()
          .describe("Publicly reachable https URL of the file. Preferred over base64_data."),
        base64_data: z
          .string()
          .optional()
          .describe(
            "Base64-encoded file bytes. A 'data:<mime>;base64,' prefix is accepted and parsed. " +
              "Use only when the file has no public URL.",
          ),
        mime_type: z
          .enum(UPLOAD_MIME_TYPES)
          .optional()
          .describe(
            "Content type of the upload. Inferred from the response headers or the file's magic " +
              "bytes when omitted, but pass it explicitly if you know it.",
          ),
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
        if (!params.source_url && !params.base64_data) {
          throw new Error("Error: provide either source_url or base64_data.");
        }
        if (params.source_url && params.base64_data) {
          throw new Error("Error: provide source_url or base64_data, not both.");
        }

        let bytes: Buffer;
        let detectedType: string | null = null;

        if (params.source_url) {
          const fetched = await fetchRemoteFile(params.source_url);
          bytes = fetched.bytes;
          detectedType = fetched.contentType?.split(";")[0]?.trim() ?? null;
        } else {
          const cleaned = params.base64_data!.replace(/^data:([^;]+);base64,/, (_m, mime) => {
            detectedType = String(mime);
            return "";
          });
          bytes = Buffer.from(cleaned, "base64");
          if (bytes.length === 0) {
            throw new Error("Error: base64_data did not decode to any bytes.");
          }
        }

        const mimeType =
          params.mime_type ??
          (detectedType && (UPLOAD_MIME_TYPES as readonly string[]).includes(detectedType)
            ? detectedType
            : null) ??
          sniffMimeType(bytes);

        if (!mimeType || !(UPLOAD_MIME_TYPES as readonly string[]).includes(mimeType)) {
          throw new Error(
            `Error: could not determine a supported MIME type${detectedType ? ` (saw '${detectedType}')` : ""}. ` +
              `Pass mime_type explicitly as one of: ${UPLOAD_MIME_TYPES.join(", ")}.`,
          );
        }

        const isVideo = mimeType === "video/mp4";
        const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (bytes.length > limit) {
          throw new Error(
            `Error: file is ${(bytes.length / 1_048_576).toFixed(1)} MB, over the ` +
              `${limit / 1_048_576} MB limit for ${mimeType}.`,
          );
        }

        const email = client.email;
        const path = `/assets/${encodeURIComponent(email)}`;

        const raw = (await client.request(path, {
          method: "POST",
          rawBody: bytes,
          rawContentType: mimeType,
          timeoutMs: UPLOAD_TIMEOUT_MS,
        })) as Record<string, unknown>;

        // The API nests the id: { mediaGenerationId: { mediaGenerationId: "..." } }
        const idContainer = raw?.["mediaGenerationId"];
        const mediaGenerationId =
          typeof idContainer === "string"
            ? idContainer
            : ((idContainer as Record<string, unknown> | undefined)?.[
                "mediaGenerationId"
              ] as string | undefined) ?? null;

        const structured = {
          operation: "upload_asset",
          mediaGenerationId,
          kind: isVideo ? "video" : "image",
          mimeType,
          sizeBytes: bytes.length,
          width: (raw?.["width"] as number | undefined) ?? null,
          height: (raw?.["height"] as number | undefined) ?? null,
          durationSeconds: (raw?.["durationSeconds"] as number | undefined) ?? null,
          email: (raw?.["email"] as string | undefined) ?? email ?? null,
          raw,
        };

        const md = [
          "# Asset uploaded",
          "",
          `- **mediaGenerationId**: \`${mediaGenerationId ?? "(not returned)"}\``,
          `- **type**: ${mimeType}`,
          `- **size**: ${(bytes.length / 1_048_576).toFixed(2)} MB`,
          structured.width ? `- **dimensions**: ${structured.width}x${structured.height}` : "",
          structured.durationSeconds ? `- **duration**: ${structured.durationSeconds}s` : "",
          structured.email ? `- **account**: ${structured.email}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        return result(structured, md, params.response_format);
      }),
  );

  server.registerTool(
    "google_flow_get_asset",
    {
      title: "Resolve Asset Download URL",
      description: `Resolve a mediaGenerationId into a fresh signed download URL. Use this when an earlier URL has expired — signed links are valid for roughly 6 hours.

Returns:
  { "operation": "get_asset", "mediaGenerationId": string, "url": string, "expiresApproxHours": 6 }

Examples:
  - "The video link from earlier doesn't work anymore" -> pass the mediaGenerationId here
  - Don't use to list a user's assets — the API has no such endpoint; track ids in your application.

Errors:
  - 404: unknown mediaGenerationId, or it belongs to a different useapi.net user.`,
      inputSchema: {
        media_generation_id: mediaGenerationIdParam,
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
        const raw = (await client.requestById("/assets/", params.media_generation_id)) as Record<string, unknown>;

        const url = (raw?.["url"] as string | undefined) ?? null;
        const structured = {
          operation: "get_asset",
          mediaGenerationId: params.media_generation_id,
          url,
          expiresApproxHours: 6,
        };

        const md = url
          ? `# Asset URL resolved\n\n${url}\n\n_Valid for about 6 hours._`
          : `# No URL returned\n\nThe API did not include a signed URL for \`${params.media_generation_id}\`.`;

        return result(structured, md, params.response_format);
      }),
  );
}
