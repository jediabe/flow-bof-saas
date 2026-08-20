import { describe, expect, it, vi } from "vitest";
import {
  ApexFlowAdapterError,
  createApexFlowAdapter,
  type ApexMcpToolCaller,
} from "../apex-flow-adapter";

const boundContext = {
  actor: {
    workspaceId: "workspace-1",
    actorType: "service" as const,
    actorId: "hermes-service",
  },
  flowEmail: "bound-account@example.com",
};

function mockCaller(
  structuredContent: unknown,
): ApexMcpToolCaller & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    isError: false,
    content: [],
    structuredContent,
  });
}

describe("APEX Flow generation adapter", () => {
  it("uploads SaaS-owned source bytes and strictly validates the Flow media identity", async () => {
    const callTool = mockCaller({
      operation: "upload_asset",
      mediaGenerationId: "flow-uploaded-reference-1",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 9,
      email: "bound-account@example.com",
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    await expect(
      adapter.uploadAsset({
        base64Data: "iVBORw0KGgo=",
        mimeType: "image/png",
        expectedKind: "image",
        expectedSizeBytes: 9,
      }),
    ).resolves.toEqual({
      mediaGenerationId: "flow-uploaded-reference-1",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 9,
    });
    expect(callTool).toHaveBeenCalledWith({
      sub: "workspace-1",
      flowEmail: "bound-account@example.com",
      name: "google_flow_upload_asset",
      args: {
        base64_data: "iVBORw0KGgo=",
        mime_type: "image/png",
        response_format: "json",
      },
    });
  });

  it("rejects a malformed upload result instead of using an unsafe reference", async () => {
    const adapter = createApexFlowAdapter(boundContext, {
      callTool: mockCaller({
        operation: "upload_asset",
        mediaGenerationId: "flow-uploaded-reference-1",
        kind: "video",
        mimeType: "video/mp4",
        sizeBytes: 9,
      }),
    });

    await expect(
      adapter.uploadAsset({
        base64Data: "iVBORw0KGgo=",
        mimeType: "image/png",
        expectedKind: "image",
        expectedSizeBytes: 9,
      }),
    ).rejects.toMatchObject({
      classification: "terminal-nontechnical",
      code: "malformed_output",
      acceptedProviderIdentity: true,
    });
  });

  it("normalizes one synchronous image result without exposing the bound Flow account in generation input", async () => {
    const callTool = mockCaller({
      operation: "generate_image",
      mode: "sync",
      status: "completed",
      media: [
        {
          kind: "image",
          mediaGenerationId: "media-image-1",
          url: "https://cdn.example.test/image-1.png",
        },
      ],
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    const result = await adapter.generateImage({
      prompt: "A product on a store shelf",
      model: "nano-banana-pro",
      aspectRatio: "9:16",
      referenceMediaIds: ["reference-1"],
    });

    expect(result).toEqual({
      mediaGenerationId: "media-image-1",
      url: "https://cdn.example.test/image-1.png",
    });
    expect(callTool).toHaveBeenCalledWith({
      sub: "workspace-1",
      flowEmail: "bound-account@example.com",
      name: "google_flow_generate_image",
      args: {
        prompt: "A product on a store shelf",
        model: "nano-banana-pro",
        aspect_ratio: "9:16",
        count: 1,
        references: ["reference-1"],
        response_format: "json",
      },
    });

    if (false) {
      await adapter.generateImage({
        prompt: "Hermes-controlled prompt",
        model: "application-frozen-model",
        // @ts-expect-error Flow account selection is bound application context.
        flowEmail: "hermes-supplied@example.com",
      });
    }
  });

  it("normalizes an asynchronous video start into a provider job ID", async () => {
    const callTool = mockCaller({
      operation: "generate_video",
      mode: "async",
      jobId: "provider-job-1",
      status: "created",
      media: [],
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    await expect(
      adapter.startVideo({
        prompt: "Slow camera push toward the product",
        model: "veo-3.1-lite",
        sourceImageMediaGenerationId: "media-image-1",
        aspectRatio: "portrait",
      }),
    ).resolves.toEqual({ providerJobId: "provider-job-1" });
    expect(callTool).toHaveBeenCalledWith({
      sub: "workspace-1",
      flowEmail: "bound-account@example.com",
      name: "google_flow_generate_video",
      args: {
        prompt: "Slow camera push toward the product",
        model: "veo-3.1-lite",
        start_image: "media-image-1",
        aspect_ratio: "portrait",
        count: 1,
        async: true,
        response_format: "json",
      },
    });
  });

  it("rejects a failed asynchronous video start even when it includes a job ID", async () => {
    const adapter = createApexFlowAdapter(boundContext, {
      callTool: mockCaller({
        operation: "generate_video",
        mode: "async",
        jobId: "provider-job-failed",
        status: "failed",
        media: [],
      }),
    });

    await expect(
      adapter.startVideo({
        prompt: "Animate product",
        model: "veo-3.1-lite",
        sourceImageMediaGenerationId: "media-image-1",
      }),
    ).rejects.toMatchObject({
      classification: "terminal-nontechnical",
      code: "malformed_output",
      acceptedProviderIdentity: false,
    });
  });

  it.each([
    ["created", { status: "running", providerJobId: "provider-job-1" }],
    ["started", { status: "running", providerJobId: "provider-job-1" }],
    [
      "completed",
      {
        status: "completed",
        providerJobId: "provider-job-1",
        mediaGenerationId: "media-video-1",
        url: "https://cdn.example.test/video-1.mp4",
      },
    ],
    [
      "failed",
      {
        status: "failed",
        providerJobId: "provider-job-1",
        reason: "Provider render failed",
        failureKind: "provider",
      },
    ],
  ] as const)("normalizes a %s video poll", async (status, expected) => {
    const callTool = mockCaller({
      jobId: "provider-job-1",
      type: "video",
      status,
      media:
        status === "completed"
          ? [
              {
                kind: "video",
                mediaGenerationId: "media-video-1",
                url: "https://cdn.example.test/video-1.mp4",
              },
            ]
          : [],
      error: status === "failed" ? "Provider render failed" : null,
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    await expect(
      adapter.pollVideo({ providerJobId: "provider-job-1" }),
    ).resolves.toEqual(expected);
  });

  it.each([
    ["structured error code", { errorCode: "audio_generation_failed", error: "render failed" }, "audio_generation_failed"],
    ["structured code", { code: "audio_generation_error", error: "render failed" }, "audio_generation_error"],
    ["structured failure code", { failureCode: "failed_to_generate_audio", error: "render failed" }, "failed_to_generate_audio"],
    ["narrow reason phrase", { error: "Audio generation failed while rendering narration" }, null],
  ] as const)("classifies failed video poll audio generation failures from %s", async (_label, failureFields, expectedCode) => {
    const adapter = createApexFlowAdapter(boundContext, {
      callTool: mockCaller({
        jobId: "provider-job-1",
        type: "video",
        status: "failed",
        media: [],
        ...failureFields,
      }),
    });

    await expect(
      adapter.pollVideo({ providerJobId: "provider-job-1" }),
    ).resolves.toEqual({
      status: "failed",
      providerJobId: "provider-job-1",
      reason: failureFields.error,
      failureKind: "audio_generation",
      ...(expectedCode ? { errorCode: expectedCode } : {}),
    });
  });

  it.each([
    ["generic provider code", { errorCode: "render_failed", error: "Provider render failed" }],
    ["ambiguous audio text", { error: "audio stream unavailable" }],
    ["unsafe code characters", { errorCode: "audio_generation_failed; DROP TABLE", error: "Provider render failed" }],
  ] as const)("keeps %s failed video poll in provider failure lane", async (_label, failureFields) => {
    const adapter = createApexFlowAdapter(boundContext, {
      callTool: mockCaller({
        jobId: "provider-job-1",
        type: "video",
        status: "failed",
        media: [],
        ...failureFields,
      }),
    });

    await expect(
      adapter.pollVideo({ providerJobId: "provider-job-1" }),
    ).resolves.toEqual({
      status: "failed",
      providerJobId: "provider-job-1",
      reason: failureFields.error,
      failureKind: "provider",
    });
  });

  it("rejects a video poll whose returned job ID does not match the persisted job", async () => {
    const adapter = createApexFlowAdapter(boundContext, {
      callTool: mockCaller({
        jobId: "other-provider-job",
        type: "video",
        status: "started",
        media: [],
      }),
    });

    await expect(
      adapter.pollVideo({ providerJobId: "provider-job-1" }),
    ).rejects.toMatchObject({
      classification: "terminal-nontechnical",
      code: "malformed_output",
      acceptedProviderIdentity: true,
    });
  });

  it("resolves a fresh signed asset URL by stable media ID", async () => {
    const callTool = mockCaller({
      operation: "get_asset",
      mediaGenerationId: "media-video-1",
      url: "https://cdn.example.test/fresh-video.mp4",
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    await expect(
      adapter.resolveAssetUrl({ mediaGenerationId: "media-video-1" }),
    ).resolves.toEqual({
      mediaGenerationId: "media-video-1",
      url: "https://cdn.example.test/fresh-video.mp4",
    });
    expect(callTool).toHaveBeenCalledWith({
      sub: "workspace-1",
      flowEmail: "bound-account@example.com",
      name: "google_flow_get_asset",
      args: {
        media_generation_id: "media-video-1",
        response_format: "json",
      },
    });
  });

  it.each([
    "Error: Google Flow account session failed (596)",
    "Error: payment required (402): insufficient credits",
    "Error: forbidden (403): model is not available for this account",
    "Error: PUBLIC_ERROR_UNSAFE_GENERATION content safety rejection",
    "Error: insufficient credits for this generation",
    "Error: account is disconnected",
    "Error: requested model is unavailable",
  ])("classifies terminal provider failure as nontechnical: %s", async (text) => {
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: "text", text }],
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    const rejection = adapter.generateImage({
      prompt: "A safe product scene",
      model: "nano-banana-pro",
    });

    await expect(rejection).rejects.toMatchObject({
      name: "ApexFlowAdapterError",
      classification: "terminal-nontechnical",
      acceptedProviderIdentity: false,
    });
  });

  it("classifies malformed provider output as terminal and nontechnical", async () => {
    const adapter = createApexFlowAdapter(boundContext, {
      callTool: mockCaller({ status: "completed", media: [] }),
    });

    await expect(
      adapter.generateImage({ prompt: "Product", model: "nano-banana-pro" }),
    ).rejects.toMatchObject({
      classification: "terminal-nontechnical",
      code: "malformed_output",
    });
  });

  it("classifies an unproven start-call network timeout as terminal to avoid duplicate spend", async () => {
    const timeout = Object.assign(new Error("request timed out"), {
      name: "TimeoutError",
    });
    const callTool = vi.fn().mockRejectedValue(timeout);
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    const rejection = adapter.startVideo({
      prompt: "Animate product",
      model: "veo-3.1-lite",
      sourceImageMediaGenerationId: "media-image-1",
    });

    await expect(rejection).rejects.toBeInstanceOf(ApexFlowAdapterError);
    await expect(rejection).rejects.toMatchObject({
      classification: "terminal-nontechnical",
      code: "transport_failure",
      acceptedProviderIdentity: false,
    });
  });

  it("does not trust free-form tool error text as pre-acceptance retry proof", async () => {
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [
        {
          type: "text",
          text: "network timeout before provider acceptance; request not sent to provider",
        },
      ],
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    await expect(
      adapter.startVideo({
        prompt: "Animate product",
        model: "veo-3.1-lite",
        sourceImageMediaGenerationId: "media-image-1",
      }),
    ).rejects.toMatchObject({
      classification: "terminal-nontechnical",
      code: "transport_failure",
      acceptedProviderIdentity: false,
    });
  });

  it("allows retry only for structured pre-acceptance tool proof", async () => {
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "network timeout" }],
      structuredContent: {
        retrySafety: {
          kind: "provider_pre_acceptance",
          safeToRetry: true,
        },
      },
    });
    const adapter = createApexFlowAdapter(boundContext, { callTool });

    await expect(
      adapter.startVideo({
        prompt: "Animate product",
        model: "veo-3.1-lite",
        sourceImageMediaGenerationId: "media-image-1",
      }),
    ).rejects.toMatchObject({
      classification: "technical-retryable",
      code: "transport_failure",
      acceptedProviderIdentity: false,
    });
  });
});
