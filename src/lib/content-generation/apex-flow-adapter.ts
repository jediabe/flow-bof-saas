import { ApexMcpError, callMcpTool } from "@/lib/apex-mcp";
import type { ServiceActorContext } from "@/lib/content-runs/types";

export interface ApexFlowBoundContext {
  actor: ServiceActorContext;
  /** Persisted application binding; never sourced from a Hermes tool argument. */
  flowEmail: string;
}

export interface ApexMcpToolResult {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
}

export type ApexMcpToolCaller = (input: {
  sub: string;
  flowEmail: string;
  name: string;
  args: Record<string, unknown>;
}) => Promise<ApexMcpToolResult>;

export type ApexFlowErrorClassification =
  | "technical-retryable"
  | "terminal-nontechnical";

export class ApexFlowAdapterError extends Error {
  readonly name = "ApexFlowAdapterError";

  constructor(
    message: string,
    readonly classification: ApexFlowErrorClassification,
    readonly code: string,
    readonly acceptedProviderIdentity: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GenerateImageInput {
  prompt: string;
  model: string;
  aspectRatio?: string;
  referenceMediaIds?: string[];
}

export interface GeneratedMediaResult {
  mediaGenerationId: string;
  url: string;
}

export interface UploadAssetInput {
  base64Data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "video/mp4";
  expectedKind: "image" | "video";
  expectedSizeBytes: number;
}

export interface UploadedAssetResult {
  mediaGenerationId: string;
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
}

export interface StartVideoInput {
  prompt: string;
  model: string;
  sourceImageMediaGenerationId: string;
  aspectRatio?: string;
  durationSeconds?: number;
}

export interface StartedVideoResult {
  providerJobId: string;
}

export type VideoPollFailureKind = "audio_generation" | "provider";

export type VideoPollResult =
  | { status: "running"; providerJobId: string }
  | {
      status: "completed";
      providerJobId: string;
      mediaGenerationId: string;
      url: string;
    }
  | {
      status: "failed";
      providerJobId: string;
      reason: string;
      failureKind: VideoPollFailureKind;
      errorCode?: string;
    };

export interface ApexFlowAdapter {
  uploadAsset(input: UploadAssetInput): Promise<UploadedAssetResult>;
  generateImage(input: GenerateImageInput): Promise<GeneratedMediaResult>;
  startVideo(input: StartVideoInput): Promise<StartedVideoResult>;
  pollVideo(input: { providerJobId: string }): Promise<VideoPollResult>;
  resolveAssetUrl(input: {
    mediaGenerationId: string;
  }): Promise<GeneratedMediaResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function toolErrorText(content: unknown[]): string {
  const parts: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    const text = nonEmptyString(record?.text);
    if (text) parts.push(text);
  }
  return parts.join("\n").slice(0, 1_000) || "APEX Flow tool failed";
}

function looksLikeTransportFailure(error: unknown): boolean {
  if (error instanceof ApexMcpError) {
    return error.status === 0 || error.code === "network";
  }
  const record = asRecord(error);
  const name = nonEmptyString(record?.name) ?? "";
  const message =
    error instanceof Error ? error.message : nonEmptyString(record?.message) ?? "";
  return /abort|timeout|network|fetch|socket|econn|enotfound/i.test(
    `${name} ${message}`,
  );
}

function hasStructuredPreAcceptanceRetryProof(
  structuredContent: unknown,
): boolean {
  const structured = asRecord(structuredContent);
  const retrySafety = asRecord(structured?.retrySafety);
  return (
    retrySafety?.kind === "provider_pre_acceptance" &&
    retrySafety.safeToRetry === true
  );
}

function classifyThrownError(
  error: unknown,
  acceptedProviderIdentity: boolean,
): ApexFlowAdapterError {
  if (error instanceof ApexFlowAdapterError) return error;
  const technical = looksLikeTransportFailure(error);
  const message =
    error instanceof Error && error.message
      ? error.message.slice(0, 1_000)
      : "APEX Flow request failed";
  return new ApexFlowAdapterError(
    message,
    technical && acceptedProviderIdentity
      ? "technical-retryable"
      : "terminal-nontechnical",
    technical ? "transport_failure" : "provider_failure",
    acceptedProviderIdentity,
    { cause: error },
  );
}

function classifyToolError(
  result: ApexMcpToolResult,
  acceptedProviderIdentity: boolean,
): ApexFlowAdapterError {
  const message = toolErrorText(result.content);
  const technical = /timed?\s*out|network|fetch failed|connection (?:reset|closed)/i.test(
    message,
  );
  const provenPreAcceptance = hasStructuredPreAcceptanceRetryProof(
    result.structuredContent,
  );
  return new ApexFlowAdapterError(
    message,
    technical && provenPreAcceptance
      ? "technical-retryable"
      : "terminal-nontechnical",
    technical ? "transport_failure" : "provider_failure",
    acceptedProviderIdentity,
  );
}

function malformed(
  message: string,
  acceptedProviderIdentity: boolean,
): ApexFlowAdapterError {
  return new ApexFlowAdapterError(
    message,
    "terminal-nontechnical",
    "malformed_output",
    acceptedProviderIdentity,
  );
}

function sanitizeProviderErrorCode(value: unknown): string | null {
  const code = nonEmptyString(value);
  return code && /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : null;
}

const AUDIO_GENERATION_ERROR_CODES = new Set([
  "audio_generation_failed",
  "audio_generation_error",
  "failed_to_generate_audio",
]);

function classifyVideoPollFailure(
  structured: Record<string, unknown>,
  reason: string,
): { failureKind: VideoPollFailureKind; errorCode?: string } {
  const errorCode =
    sanitizeProviderErrorCode(structured.errorCode) ??
    sanitizeProviderErrorCode(structured.code) ??
    sanitizeProviderErrorCode(structured.failureCode);
  if (errorCode && AUDIO_GENERATION_ERROR_CODES.has(errorCode.toLowerCase())) {
    return { failureKind: "audio_generation", errorCode };
  }
  if (/\b(?:audio generation failed|audio generation error|failed to generate audio)\b/i.test(reason)) {
    return { failureKind: "audio_generation" };
  }
  return { failureKind: "provider" };
}

export function createApexFlowAdapter(
  context: ApexFlowBoundContext,
  dependencies: { callTool?: ApexMcpToolCaller } = {},
): ApexFlowAdapter {
  const callTool = dependencies.callTool ?? callMcpTool;

  async function invoke(
    name: string,
    args: Record<string, unknown>,
    acceptedProviderIdentity: boolean,
  ): Promise<ApexMcpToolResult> {
    let result: ApexMcpToolResult;
    try {
      result = await callTool({
        sub: context.actor.workspaceId,
        flowEmail: context.flowEmail,
        name,
        args,
      });
    } catch (error) {
      throw classifyThrownError(error, acceptedProviderIdentity);
    }
    if (result.isError) {
      throw classifyToolError(result, acceptedProviderIdentity);
    }
    return result;
  }

  return {
    async uploadAsset(input): Promise<UploadedAssetResult> {
      const result = await invoke(
        "google_flow_upload_asset",
        {
          base64_data: input.base64Data,
          mime_type: input.mimeType,
          response_format: "json",
        },
        true,
      );
      const structured = asRecord(result.structuredContent);
      const mediaGenerationId = nonEmptyString(structured?.mediaGenerationId);
      const kind = nonEmptyString(structured?.kind);
      const mimeType = nonEmptyString(structured?.mimeType);
      const sizeBytes = structured?.sizeBytes;
      const email = nonEmptyString(structured?.email);
      if (
        structured?.operation !== "upload_asset" ||
        !mediaGenerationId ||
        kind !== input.expectedKind ||
        mimeType !== input.mimeType ||
        typeof sizeBytes !== "number" ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes !== input.expectedSizeBytes ||
        email !== context.flowEmail
      ) {
        throw malformed("APEX Flow returned malformed upload asset output", true);
      }
      return { mediaGenerationId, kind, mimeType, sizeBytes };
    },

    async generateImage(input): Promise<GeneratedMediaResult> {
      const result = await invoke(
        "google_flow_generate_image",
        {
          prompt: input.prompt,
          model: input.model,
          ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
          count: 1,
          ...(input.referenceMediaIds
            ? { references: input.referenceMediaIds }
            : {}),
          response_format: "json",
        },
        false,
      );
      const structured = asRecord(result.structuredContent);
      const media = Array.isArray(structured?.media) ? structured.media : [];
      const image = media.length === 1 ? asRecord(media[0]) : null;
      const mediaGenerationId = nonEmptyString(image?.mediaGenerationId);
      const url = nonEmptyString(image?.url);
      if (image?.kind !== "image" || !mediaGenerationId || !url) {
        throw malformed("APEX Flow returned malformed image output", false);
      }
      return { mediaGenerationId, url };
    },

    async startVideo(input): Promise<StartedVideoResult> {
      const result = await invoke(
        "google_flow_generate_video",
        {
          prompt: input.prompt,
          model: input.model,
          start_image: input.sourceImageMediaGenerationId,
          ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
          ...(input.durationSeconds ? { duration: input.durationSeconds } : {}),
          count: 1,
          async: true,
          response_format: "json",
        },
        false,
      );
      const structured = asRecord(result.structuredContent);
      const providerJobId = nonEmptyString(structured?.jobId);
      if (
        structured?.operation !== "generate_video" ||
        structured?.mode !== "async" ||
        structured?.status !== "created" ||
        !providerJobId
      ) {
        throw malformed("APEX Flow returned malformed video start output", false);
      }
      return { providerJobId };
    },

    async pollVideo(input): Promise<VideoPollResult> {
      const result = await invoke(
        "google_flow_get_job",
        { job_id: input.providerJobId, response_format: "json" },
        true,
      );
      const structured = asRecord(result.structuredContent);
      const providerJobId = nonEmptyString(structured?.jobId);
      const status = nonEmptyString(structured?.status);

      if (
        providerJobId !== input.providerJobId ||
        structured?.type !== "video"
      ) {
        throw malformed("APEX Flow returned mismatched video job output", true);
      }

      if (status === "created" || status === "started") {
        return { status: "running", providerJobId };
      }
      if (status === "failed") {
        const reason =
          nonEmptyString(structured?.error) ??
          nonEmptyString(structured?.reason) ??
          "Provider video generation failed";
        const failure = classifyVideoPollFailure(structured, reason);
        return {
          status: "failed",
          providerJobId,
          reason,
          failureKind: failure.failureKind,
          ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
        };
      }
      if (status === "completed") {
        const media = Array.isArray(structured?.media) ? structured.media : [];
        const video = media.length === 1 ? asRecord(media[0]) : null;
        const mediaGenerationId = nonEmptyString(video?.mediaGenerationId);
        const url = nonEmptyString(video?.url);
        if (video?.kind !== "video" || !mediaGenerationId || !url) {
          throw malformed(
            "APEX Flow returned malformed completed video output",
            true,
          );
        }
        return {
          status: "completed",
          providerJobId,
          mediaGenerationId,
          url,
        };
      }
      throw malformed("APEX Flow returned an unknown video job status", true);
    },

    async resolveAssetUrl(input): Promise<GeneratedMediaResult> {
      const result = await invoke(
        "google_flow_get_asset",
        {
          media_generation_id: input.mediaGenerationId,
          response_format: "json",
        },
        true,
      );
      const structured = asRecord(result.structuredContent);
      const returnedMediaGenerationId = nonEmptyString(
        structured?.mediaGenerationId,
      );
      const url = nonEmptyString(structured?.url);
      if (returnedMediaGenerationId !== input.mediaGenerationId || !url) {
        throw malformed("APEX Flow returned malformed asset output", true);
      }
      return { mediaGenerationId: returnedMediaGenerationId, url };
    },
  };
}
