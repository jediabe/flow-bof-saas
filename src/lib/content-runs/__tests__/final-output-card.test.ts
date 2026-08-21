import { describe, expect, it, vi } from "vitest";
import { loadFinalOutputCard } from "../final-output-card";

const scope = { workspaceId: "workspace_a", contentRunId: "run_1" };
const persisted = {
  id: "final_1",
  status: "APPROVED",
  finalQaStatus: "APPROVED",
  finalQaScore: 94,
  mediaValidationPassed: true,
  finalStorageBucket: "private-media",
  finalStorageKey: "managed-content/workspace_a/run_1/final/final_1.mp4",
  finalContentType: "video/mp4",
  finalBytes: 123456,
  finalSha256: "a".repeat(64),
};

function dependencies(asset: typeof persisted | Record<string, unknown> | null) {
  return {
    prisma: { finalVideoAsset: { findFirst: vi.fn().mockResolvedValue(asset) } },
    storage: {
      bucket: "private-media",
      createSignedReadUrl: vi.fn().mockResolvedValue("https://signed.example/final.mp4"),
    },
  };
}

describe("final output card read model", () => {
  it("queries the final asset through the run and authenticated workspace boundary", async () => {
    const deps = dependencies(null);

    const view = await loadFinalOutputCard(scope, deps as never);

    expect(view).toEqual({ state: "none" });
    expect(deps.prisma.finalVideoAsset.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        contentRunId: "run_1",
        contentRun: { product: { batch: { workspaceId: "workspace_a" } } },
      },
    }));
    expect(deps.storage.createSignedReadUrl).not.toHaveBeenCalled();
  });

  it("signs and exposes only a fully persisted fenced MP4", async () => {
    const deps = dependencies(persisted);

    const view = await loadFinalOutputCard(scope, deps as never);

    expect(view).toEqual({
      state: "available",
      id: "final_1",
      status: "APPROVED",
      qaStatus: "APPROVED",
      qaScore: 94,
      bytes: 123456,
      sha256: "a".repeat(64),
      url: "https://signed.example/final.mp4",
    });
    expect(deps.storage.createSignedReadUrl).toHaveBeenCalledWith(
      "managed-content/workspace_a/run_1/final/final_1.mp4",
    );
  });

  it.each([
    ["wrong bucket", { finalStorageBucket: "other-bucket" }],
    ["wrong workspace prefix", { finalStorageKey: "managed-content/workspace_b/run_1/final/final_1.mp4" }],
    ["wrong run prefix", { finalStorageKey: "managed-content/workspace_a/run_2/final/final_1.mp4" }],
    ["non-final key", { finalStorageKey: "managed-content/workspace_a/run_1/video/final_1.mp4" }],
    ["non-MP4 content", { finalContentType: "video/webm" }],
    ["invalid hash", { finalSha256: "not-a-hash" }],
  ])("does not sign a persisted-looking object with %s", async (_caseName, override) => {
    const deps = dependencies({ ...persisted, ...override });

    const view = await loadFinalOutputCard(scope, deps as never);

    expect(view).toMatchObject({ state: "unavailable", status: "APPROVED" });
    expect(deps.storage.createSignedReadUrl).not.toHaveBeenCalled();
  });

  it.each([
    "MEDIA_VALIDATED",
    "QA_RUNNING",
    "HUMAN_REVIEW",
    "FAILED",
  ])("does not sign a persisted MP4 while lifecycle status is %s", async (status) => {
    const deps = dependencies({ ...persisted, status });

    const view = await loadFinalOutputCard(scope, deps as never);

    expect(view).toMatchObject({ state: "unavailable", status });
    expect(deps.storage.createSignedReadUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["final QA pending", { finalQaStatus: "QA_RUNNING" }],
    ["deterministic media validation missing", { mediaValidationPassed: null }],
    ["deterministic media validation failed", { mediaValidationPassed: false }],
  ])("does not sign a persisted MP4 when %s", async (_caseName, override) => {
    const deps = dependencies({ ...persisted, ...override });

    const view = await loadFinalOutputCard(scope, deps as never);

    expect(view).toMatchObject({ state: "unavailable", status: "APPROVED" });
    expect(deps.storage.createSignedReadUrl).not.toHaveBeenCalled();
  });

  it("renders legacy or incomplete final rows gracefully without signing", async () => {
    const deps = dependencies({
      ...persisted,
      finalStorageBucket: null,
      finalStorageKey: null,
      finalContentType: null,
      finalBytes: null,
      finalSha256: null,
    });

    const view = await loadFinalOutputCard(scope, deps as never);

    expect(view).toMatchObject({
      state: "legacy",
      status: "APPROVED",
      qaStatus: "APPROVED",
      qaScore: 94,
    });
    expect(deps.storage.createSignedReadUrl).not.toHaveBeenCalled();
  });
});
