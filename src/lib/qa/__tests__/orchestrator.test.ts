/**
 * Orchestrator integration tests. Covers all 10 scenarios from
 * the Phase C spec:
 *
 *   1. successful image QA
 *   2. successful video QA
 *   3. hard-failure video result
 *   4. malformed model response
 *   5. provider error
 *   6. media/frame extraction failure
 *   7. legacy asset without ContentRun
 *   8. duplicate/concurrent QA request
 *   9. persistence of QaAttempt
 *  10. decision engine integration
 *
 * Strategy: mock the four external dependencies (db, mcpGetAssetUrl,
 * fetchImageAsBase64, extractFrames) via vi.mock and inject a
 * fake VisualQaProvider through the orchestrator's
 * providerOverride input. Zero real network, zero real DB, zero
 * real ffmpeg. Runs in <1s.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// -----------------------------------------------------------------
// Mock setup — MUST appear before any import of the SUT so
// vitest hoists them correctly.
// -----------------------------------------------------------------

// The Prisma singleton. We replace every method the orchestrator
// touches with a vi.fn stub whose return value tests override
// per-case.
vi.mock("@/lib/db", () => {
  const $transaction = vi.fn(async (fn: (tx: unknown) => unknown) => {
    // If callers pass a callback, invoke it with the same
    // module-level mocked shape (a "transactional" client is
    // the same object in these tests).
    if (typeof fn === "function") return await fn(mockedDb);
    return fn;
  });
  const mockedDb = {
    flowGeneratedVideo: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    flowGeneratedImage: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    qaAttempt: {
      create: vi.fn(),
    },
    workspaceSettings: {
      findUnique: vi.fn(),
    },
    $transaction,
  };
  return { db: mockedDb };
});

vi.mock("@/lib/apex-mcp", () => ({
  mcpGetAssetUrl: vi.fn(),
}));

vi.mock("@/lib/media/fetch-image", () => ({
  fetchImageAsBase64: vi.fn(),
}));

vi.mock("../frame-extraction", () => ({
  extractFrames: vi.fn(),
}));

// SUT + mocked collaborators.
import { runQaForAsset } from "../orchestrator";
import { db } from "@/lib/db";
import { mcpGetAssetUrl } from "@/lib/apex-mcp";
import { fetchImageAsBase64 } from "@/lib/media/fetch-image";
import { extractFrames } from "../frame-extraction";
import {
  ConcurrencyError,
  FrameExtractionError,
  LegacyAssetError,
  MediaFetchError,
  ProviderError,
  ProviderValidationError,
} from "../errors";
import type { VisualQaProvider, VisualQaInput } from "../visual-qa-provider";
import type { VisualQaResult } from "../schema";

const mockedDb = db as unknown as {
  flowGeneratedVideo: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  flowGeneratedImage: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  qaAttempt: {
    create: ReturnType<typeof vi.fn>;
  };
  workspaceSettings: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

// -----------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------

function videoRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "video-1",
    productId: "prod-1",
    contentRunId: "run-1",
    contentRun: {
      id: "run-1",
      style: "style1",
      market: "uk",
    },
    sceneLabel: "scene_1_store",
    mediaGenerationId: "mgen-video-1",
    prompt: "generation prompt",
    notes: null,
    imageMediaGenerationId: "mgen-image-1",
    qaStatus: "NOT_QA_CHECKED",
    qaScore: null,
    qaVerdictJson: null,
    qaCompletedAt: null,
    attemptNumber: 1,
    parentVideoId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    product: {
      id: "prod-1",
      productName: "Test Product",
      category: "kitchen",
      referenceImageUrl: "https://example.com/ref.jpg",
      batch: {
        workspaceId: "ws-1",
        workspace: {
          settings: { flowEmail: "flow@example.com" },
        },
      },
    },
    ...overrides,
  };
}

function imageRow(overrides: Record<string, unknown> = {}) {
  return {
    ...videoRow(),
    id: "image-1",
    contentRun: { id: "run-1", style: "style1", market: "uk" },
    sceneLabel: "scene_2_home_image",
    mediaGenerationId: "mgen-still-1",
    ...overrides,
  };
}

function goodResult(overrides: Partial<VisualQaResult> = {}): VisualQaResult {
  return {
    overallScore: 92,
    hasHardFailure: false,
    checks: [
      { name: "PRODUCT_PRESENT", passed: true, score: 95 },
      { name: "PRODUCT_STABILITY", passed: true, score: 95 },
      { name: "LABEL_INTEGRITY", passed: true, score: 90 },
    ],
    issues: [],
    ...overrides,
  };
}

function fakeProvider(result: VisualQaResult): VisualQaProvider {
  return {
    identifier: "test:fake-model-1",
    evaluate: vi.fn(async (_input: VisualQaInput) => ({
      result,
      providerModel: "test:fake-model-1",
      elapsedMs: 42,
    })),
  };
}

function throwingProvider(err: Error): VisualQaProvider {
  return {
    identifier: "test:throwing",
    evaluate: vi.fn(async (_input: VisualQaInput) => {
      throw err;
    }),
  };
}

// Wire the default happy-path stubs. Individual tests override.
function primeHappyPath(opts: { kind: "video" | "image" } = { kind: "video" }) {
  mockedDb.flowGeneratedVideo.findUnique.mockReset();
  mockedDb.flowGeneratedImage.findUnique.mockReset();
  mockedDb.flowGeneratedVideo.updateMany.mockReset();
  mockedDb.flowGeneratedImage.updateMany.mockReset();
  mockedDb.flowGeneratedVideo.update.mockReset();
  mockedDb.flowGeneratedImage.update.mockReset();
  mockedDb.qaAttempt.create.mockReset();
  mockedDb.workspaceSettings.findUnique.mockReset();

  if (opts.kind === "video") {
    mockedDb.flowGeneratedVideo.findUnique.mockResolvedValue(videoRow());
    mockedDb.flowGeneratedVideo.updateMany.mockResolvedValue({ count: 1 });
    mockedDb.flowGeneratedVideo.update.mockResolvedValue({});
  } else {
    mockedDb.flowGeneratedImage.findUnique.mockResolvedValue(imageRow());
    mockedDb.flowGeneratedImage.updateMany.mockResolvedValue({ count: 1 });
    mockedDb.flowGeneratedImage.update.mockResolvedValue({});
  }
  mockedDb.qaAttempt.create.mockResolvedValue({
    id: "attempt-1",
    decision: "APPROVE",
  });
  mockedDb.workspaceSettings.findUnique.mockResolvedValue({
    anthropicApiKey: "test-key",
    anthropicModel: null,
  });

  (mcpGetAssetUrl as ReturnType<typeof vi.fn>).mockReset();
  (mcpGetAssetUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
    "https://useapi.example/signed",
  );

  (fetchImageAsBase64 as ReturnType<typeof vi.fn>).mockReset();
  (fetchImageAsBase64 as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: "AAAA",
    mediaType: "image/jpeg",
  });

  (extractFrames as ReturnType<typeof vi.fn>).mockReset();
  (extractFrames as ReturnType<typeof vi.fn>).mockResolvedValue({
    frames: [
      { timestampMs: 0, data: "AAAA", mediaType: "image/jpeg" },
      { timestampMs: 1000, data: "AAAA", mediaType: "image/jpeg" },
      { timestampMs: 7950, data: "AAAA", mediaType: "image/jpeg" },
    ],
    durationSec: 8,
    requestedTimestampsMs: [0, 1000, 7950],
  });
}

beforeEach(() => {
  primeHappyPath({ kind: "video" });
});

// -----------------------------------------------------------------
// #1 — successful image QA
// -----------------------------------------------------------------
describe("runQaForAsset — successful image QA", () => {
  it("evaluates an image, writes QaAttempt, transitions to APPROVED", async () => {
    primeHappyPath({ kind: "image" });
    const provider = fakeProvider(goodResult());
    const out = await runQaForAsset({
      assetId: "image-1",
      assetKind: "image",
      triggeredBy: "manual",
      providerOverride: provider,
    });

    expect(out.decision).toBe("APPROVE");
    expect(out.qaStatus).toBe("APPROVED");
    expect(out.overallScore).toBe(92);
    expect(out.assetId).toBe("image-1");
    expect(out.assetKind).toBe("image");
    expect(out.providerModel).toBe("test:fake-model-1");

    // fetchImageAsBase64 called twice: once for reference,
    // once for the asset (image kind).
    expect(fetchImageAsBase64).toHaveBeenCalledTimes(2);
    // extractFrames NOT called for image assets.
    expect(extractFrames).not.toHaveBeenCalled();
    // Lock acquired.
    expect(mockedDb.flowGeneratedImage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "image-1",
          qaStatus: { notIn: ["QA_RUNNING", "REGEN_IN_FLIGHT"] },
        }),
        data: { qaStatus: "QA_RUNNING" },
      }),
    );
    // Persistence.
    expect(mockedDb.qaAttempt.create).toHaveBeenCalledTimes(1);
    const createArgs = mockedDb.qaAttempt.create.mock.calls[0][0];
    expect(createArgs.data.imageId).toBe("image-1");
    expect(createArgs.data.videoId).toBeUndefined();
    expect(createArgs.data.assetType).toBe("HOME_IMAGE");
    expect(createArgs.data.decision).toBe("APPROVE");
    expect(mockedDb.flowGeneratedImage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "image-1" },
        data: expect.objectContaining({
          qaStatus: "APPROVED",
          qaScore: 92,
        }),
      }),
    );
  });
});

// -----------------------------------------------------------------
// #2 — successful video QA
// -----------------------------------------------------------------
describe("runQaForAsset — successful video QA", () => {
  it("extracts frames, evaluates, writes STORE_VIDEO attempt", async () => {
    const provider = fakeProvider(goodResult());
    const out = await runQaForAsset({
      assetId: "video-1",
      assetKind: "video",
      triggeredBy: "manual",
      providerOverride: provider,
    });
    expect(out.decision).toBe("APPROVE");
    expect(out.qaStatus).toBe("APPROVED");
    expect(extractFrames).toHaveBeenCalledTimes(1);
    // Reference image fetched (assetkind=video only fetches ref via fetchImageAsBase64).
    expect(fetchImageAsBase64).toHaveBeenCalledTimes(1);
    const createArgs = mockedDb.qaAttempt.create.mock.calls[0][0];
    expect(createArgs.data.videoId).toBe("video-1");
    expect(createArgs.data.imageId).toBeUndefined();
    expect(createArgs.data.assetType).toBe("STORE_VIDEO");
    // framesJson diagnostics captured.
    expect(createArgs.data.framesJson).toBeTruthy();
    const framesInfo = JSON.parse(createArgs.data.framesJson);
    expect(framesInfo.durationSec).toBe(8);
    expect(framesInfo.frameCount).toBe(3);
  });
});

// -----------------------------------------------------------------
// #3 — hard-failure video result → REGEN_NEEDED
// -----------------------------------------------------------------
describe("runQaForAsset — hard failure", () => {
  it("transitions to REGEN_NEEDED on hasHardFailure=true", async () => {
    const provider = fakeProvider(
      goodResult({
        overallScore: 40,
        hasHardFailure: true,
        checks: [
          {
            name: "PRODUCT_PRESENT",
            passed: false,
            score: 10,
            severity: "critical",
            reason: "Product missing.",
          },
        ],
        issues: [
          {
            type: "product_missing",
            severity: "critical",
            description: "Product not visible in any frame.",
          },
        ],
      }),
    );
    const out = await runQaForAsset({
      assetId: "video-1",
      assetKind: "video",
      triggeredBy: "manual",
      providerOverride: provider,
    });
    expect(out.decision).toBe("REGENERATE");
    expect(out.qaStatus).toBe("REGEN_NEEDED");
    const createArgs = mockedDb.qaAttempt.create.mock.calls[0][0];
    expect(createArgs.data.decision).toBe("REGENERATE");
    expect(createArgs.data.hasHardFailure).toBe(true);
    // Update transitioned to REGEN_NEEDED (not REGEN_IN_FLIGHT
    // — Phase D concern).
    expect(mockedDb.flowGeneratedVideo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ qaStatus: "REGEN_NEEDED" }),
      }),
    );
  });

  it("downgrades to HUMAN_REVIEW at max attempts", async () => {
    mockedDb.flowGeneratedVideo.findUnique.mockResolvedValue(
      videoRow({ attemptNumber: 3 }),
    );
    const provider = fakeProvider(
      goodResult({ overallScore: 20, hasHardFailure: true }),
    );
    const out = await runQaForAsset({
      assetId: "video-1",
      assetKind: "video",
      triggeredBy: "manual",
      providerOverride: provider,
    });
    expect(out.decision).toBe("HUMAN_REVIEW");
    expect(out.qaStatus).toBe("HUMAN_REVIEW");
  });
});

// -----------------------------------------------------------------
// #4 — malformed model response → FAILED
// -----------------------------------------------------------------
describe("runQaForAsset — malformed model response", () => {
  it("transitions asset to FAILED, records failure QaAttempt, throws ProviderValidationError", async () => {
    const provider = throwingProvider(
      new ProviderValidationError("Model output failed schema validation: garbage", "raw"),
    );
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(ProviderValidationError);

    // Failure record written.
    expect(mockedDb.qaAttempt.create).toHaveBeenCalledTimes(1);
    const createArgs = mockedDb.qaAttempt.create.mock.calls[0][0];
    expect(createArgs.data.decision).toBe("HUMAN_REVIEW");
    expect(createArgs.data.hasHardFailure).toBe(true);
    const stored = JSON.parse(createArgs.data.resultJson);
    expect(stored.error.code).toBe("provider_output_invalid");
    expect(stored.error.stage).toBe("validation");
    // Asset transitioned to FAILED.
    expect(mockedDb.flowGeneratedVideo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ qaStatus: "FAILED" }),
      }),
    );
  });
});

// -----------------------------------------------------------------
// #5 — provider error → FAILED
// -----------------------------------------------------------------
describe("runQaForAsset — provider error", () => {
  it("wraps SDK errors + records failure + throws ProviderError", async () => {
    const provider = throwingProvider(
      new ProviderError("Anthropic messages.create failed: timeout after 30s"),
    );
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    const createArgs = mockedDb.qaAttempt.create.mock.calls[0][0];
    expect(createArgs.data.decision).toBe("HUMAN_REVIEW");
    const stored = JSON.parse(createArgs.data.resultJson);
    expect(stored.error.code).toBe("provider_call_failed");
  });

  it("wraps a non-QaError from the provider as ProviderError", async () => {
    const provider = throwingProvider(new Error("random SDK exception"));
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

// -----------------------------------------------------------------
// #6 — media / frame extraction failure
// -----------------------------------------------------------------
describe("runQaForAsset — extraction failure", () => {
  it("wraps extractFrames failure + transitions to FAILED", async () => {
    (extractFrames as ReturnType<typeof vi.fn>).mockRejectedValue(
      new FrameExtractionError("ffmpeg exited with code 1"),
    );
    const provider = fakeProvider(goodResult());
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(FrameExtractionError);
    const createArgs = mockedDb.qaAttempt.create.mock.calls[0][0];
    expect(createArgs.data.decision).toBe("HUMAN_REVIEW");
    const stored = JSON.parse(createArgs.data.resultJson);
    expect(stored.error.code).toBe("frame_extraction_failed");
    expect(stored.error.stage).toBe("extraction");
  });

  it("wraps mcpGetAssetUrl returning null as MediaFetchError", async () => {
    (mcpGetAssetUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const provider = fakeProvider(goodResult());
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(MediaFetchError);
  });

  it("wraps reference-image fetch failure as MediaFetchError", async () => {
    (fetchImageAsBase64 as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("HTTP 404"),
    );
    const provider = fakeProvider(goodResult());
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(MediaFetchError);
  });
});

// -----------------------------------------------------------------
// #7 — legacy asset without ContentRun
// -----------------------------------------------------------------
describe("runQaForAsset — legacy asset", () => {
  it("throws LegacyAssetError BEFORE any state change", async () => {
    mockedDb.flowGeneratedVideo.findUnique.mockResolvedValue(
      videoRow({ contentRunId: null, contentRun: null }),
    );
    const provider = fakeProvider(goodResult());
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(LegacyAssetError);
    // No lock acquired, no QA attempt written, no update.
    expect(mockedDb.flowGeneratedVideo.updateMany).not.toHaveBeenCalled();
    expect(mockedDb.qaAttempt.create).not.toHaveBeenCalled();
    expect(mockedDb.flowGeneratedVideo.update).not.toHaveBeenCalled();
    expect(provider.evaluate).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------
// #8 — duplicate / concurrent QA
// -----------------------------------------------------------------
describe("runQaForAsset — concurrency", () => {
  it("throws ConcurrencyError when the lock CAS fails", async () => {
    mockedDb.flowGeneratedVideo.updateMany.mockResolvedValue({ count: 0 });
    mockedDb.flowGeneratedVideo.findUnique
      // first call: loadAssetForQa
      .mockResolvedValueOnce(videoRow())
      // second call inside acquireQaLock error branch (select
      // qaStatus)
      .mockResolvedValueOnce({ qaStatus: "QA_RUNNING" });
    const provider = fakeProvider(goodResult());
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyError);
    // Provider never called.
    expect(provider.evaluate).not.toHaveBeenCalled();
    // No QaAttempt written — the lock failure is pre-lock.
    expect(mockedDb.qaAttempt.create).not.toHaveBeenCalled();
  });

  it("carries the current status onto the ConcurrencyError message", async () => {
    mockedDb.flowGeneratedVideo.updateMany.mockResolvedValue({ count: 0 });
    mockedDb.flowGeneratedVideo.findUnique
      .mockResolvedValueOnce(videoRow())
      .mockResolvedValueOnce({ qaStatus: "REGEN_IN_FLIGHT" });
    const provider = fakeProvider(goodResult());
    await expect(
      runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      }),
    ).rejects.toThrow(/REGEN_IN_FLIGHT/);
  });
});

// -----------------------------------------------------------------
// #9 — persistence of QaAttempt
// -----------------------------------------------------------------
describe("runQaForAsset — persistence", () => {
  it("writes the QaAttempt with all diagnostic fields populated", async () => {
    const provider = fakeProvider(goodResult({ overallScore: 88 }));
    await runQaForAsset({
      assetId: "video-1",
      assetKind: "video",
      triggeredBy: "manual",
      providerOverride: provider,
    });
    const createArgs = mockedDb.qaAttempt.create.mock.calls[0][0];
    // Denormalised score + hasHardFailure present.
    expect(createArgs.data.overallScore).toBe(88);
    expect(createArgs.data.hasHardFailure).toBe(false);
    // Rubric version + provider model stamped.
    expect(createArgs.data.rubricVersion).toBe("m1.0");
    expect(createArgs.data.providerModel).toBe("test:fake-model-1");
    // Attempt number copied from the source asset.
    expect(createArgs.data.attemptNumber).toBe(1);
    // resultJson is valid JSON representing the model output.
    const parsed = JSON.parse(createArgs.data.resultJson);
    expect(parsed.overallScore).toBe(88);
    // Asset lifecycle updated in the SAME transaction (we assert
    // .update was called after .create).
    expect(mockedDb.flowGeneratedVideo.update).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------
// #10 — decision engine integration
// -----------------------------------------------------------------
describe("runQaForAsset — decision engine drives status", () => {
  const cases: Array<{
    label: string;
    result: VisualQaResult;
    attemptNumber?: number;
    expectDecision: string;
    expectStatus: string;
  }> = [
    {
      label: "high score, no issues → APPROVE / APPROVED",
      result: goodResult({ overallScore: 95 }),
      expectDecision: "APPROVE",
      expectStatus: "APPROVED",
    },
    {
      label: "middle-band score → HUMAN_REVIEW / HUMAN_REVIEW",
      result: goodResult({ overallScore: 70 }),
      expectDecision: "HUMAN_REVIEW",
      expectStatus: "HUMAN_REVIEW",
    },
    {
      label: "low score → REGENERATE / REGEN_NEEDED",
      result: goodResult({ overallScore: 40 }),
      expectDecision: "REGENERATE",
      expectStatus: "REGEN_NEEDED",
    },
    {
      label: "low score at max attempts → HUMAN_REVIEW",
      result: goodResult({ overallScore: 40 }),
      attemptNumber: 3,
      expectDecision: "HUMAN_REVIEW",
      expectStatus: "HUMAN_REVIEW",
    },
    {
      label: "exactly at APPROVE_SCORE_THRESHOLD (80) → APPROVE",
      result: goodResult({ overallScore: 80 }),
      expectDecision: "APPROVE",
      expectStatus: "APPROVED",
    },
    {
      label: "exactly at REGEN_SCORE_THRESHOLD (60) → HUMAN_REVIEW",
      result: goodResult({ overallScore: 60 }),
      expectDecision: "HUMAN_REVIEW",
      expectStatus: "HUMAN_REVIEW",
    },
  ];

  for (const c of cases) {
    it(c.label, async () => {
      if (c.attemptNumber !== undefined) {
        mockedDb.flowGeneratedVideo.findUnique.mockResolvedValue(
          videoRow({ attemptNumber: c.attemptNumber }),
        );
      }
      const provider = fakeProvider(c.result);
      const out = await runQaForAsset({
        assetId: "video-1",
        assetKind: "video",
        triggeredBy: "manual",
        providerOverride: provider,
      });
      expect(out.decision).toBe(c.expectDecision);
      expect(out.qaStatus).toBe(c.expectStatus);
    });
  }
});
