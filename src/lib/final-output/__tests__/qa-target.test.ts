import { describe, expect, it } from "vitest";
import { assertExactlyOneQaTarget } from "../types";

describe("final QA target invariant", () => {
  it.each([
    [{ imageId: "image-1", videoId: null, finalVideoId: null }, "image"],
    [{ imageId: null, videoId: "video-1", finalVideoId: null }, "video"],
    [{ imageId: null, videoId: null, finalVideoId: "final-1" }, "finalVideo"],
  ] as const)("accepts exactly one persisted %s target", (target, expected) => {
    expect(assertExactlyOneQaTarget(target)).toEqual({ kind: expected, id: expect.any(String) });
  });

  it.each([
    { imageId: null, videoId: null, finalVideoId: null },
    { imageId: "image-1", videoId: "video-1", finalVideoId: null },
    { imageId: "image-1", videoId: null, finalVideoId: "final-1" },
    { imageId: null, videoId: "video-1", finalVideoId: "final-1" },
    { imageId: "image-1", videoId: "video-1", finalVideoId: "final-1" },
  ])("rejects zero or multiple QA targets", (target) => {
    expect(() => assertExactlyOneQaTarget(target)).toThrow(/exactly one/i);
  });
});
