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

  it("classifies a network timeout before any accepted job as technical-retryable", async () => {
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
      classification: "technical-retryable",
      code: "transport_failure",
      acceptedProviderIdentity: false,
    });
  });
});
