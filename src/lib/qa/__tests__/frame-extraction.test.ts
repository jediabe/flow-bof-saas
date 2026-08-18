import { describe, it, expect } from "vitest";
import {
  computeSampleTimestamps,
  DEFAULT_FRAME_SAMPLING,
} from "../frame-extraction";

// Real ffmpeg / ffprobe invocations aren't unit-tested here —
// the extraction pipeline is exercised end-to-end by the manual
// smoke script (scripts/qa-smoke.mjs). Unit coverage focuses on
// the sampling policy — pure math the orchestrator depends on.

describe("computeSampleTimestamps — sampling policy", () => {
  it("returns [0] for zero duration when includeFirst is true", () => {
    expect(
      computeSampleTimestamps(0, DEFAULT_FRAME_SAMPLING),
    ).toEqual([0]);
  });

  it("returns [] for zero duration when includeFirst is false", () => {
    expect(
      computeSampleTimestamps(0, {
        ...DEFAULT_FRAME_SAMPLING,
        includeFirst: false,
        includeLast: false,
      }),
    ).toEqual([]);
  });

  it("includes first + last + ~1fps for a typical 8s Style 1 clip", () => {
    const out = computeSampleTimestamps(8.0, DEFAULT_FRAME_SAMPLING);
    // Expected: 0, 1, 2, 3, 4, 5, 6, 7 (from 1fps loop) + 7.95 (last frame - 0.05).
    // Length: 9 entries.
    expect(out.length).toBeGreaterThanOrEqual(8);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[0]).toBe(0);
    expect(out).toContain(1);
    expect(out).toContain(7);
    // Last frame close to duration.
    expect(out.at(-1)).toBeCloseTo(7.95, 2);
  });

  it("dedupes when includeLast collides with a 1fps sample", () => {
    // At fps=1 with duration=8, 1fps loop hits 7. Last frame
    // offset=0.0 would ALSO be 8.0 (well, 8-0=8, but > duration
    // is trimmed to duration-offset). Set offset=0 with duration
    // exactly on a whole second: last is duration itself which
    // the loop skips (`t < durationSec`). No dup expected.
    const out = computeSampleTimestamps(8, {
      ...DEFAULT_FRAME_SAMPLING,
      lastFrameOffsetSec: 0,
    });
    // With offset 0, last = 8 exactly, added to set. Loop
    // covers 0..7. Total unique: 9.
    expect(out).toContain(8);
    expect(new Set(out).size).toBe(out.length);
  });

  it("respects a higher fps", () => {
    const out = computeSampleTimestamps(2.0, {
      ...DEFAULT_FRAME_SAMPLING,
      fps: 4,
    });
    // 4fps over 2s = 0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75 + last (1.95)
    expect(out).toContain(0);
    expect(out).toContain(0.25);
    expect(out).toContain(1.75);
  });

  it("respects maxFrames cap", () => {
    const out = computeSampleTimestamps(60, {
      ...DEFAULT_FRAME_SAMPLING,
      maxFrames: 5,
    });
    expect(out.length).toBe(5);
    expect(out[0]).toBe(0);
    // Cap trims trailing entries — the last frame at ~60 may
    // be lost if it falls past index 5. That's the tradeoff of
    // the cap; documented in the module.
  });

  it("returns sorted ascending timestamps", () => {
    const out = computeSampleTimestamps(10.0, DEFAULT_FRAME_SAMPLING);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThan(out[i - 1]);
    }
  });

  it("guarantees first frame for arbitrary duration", () => {
    for (const dur of [0.1, 1, 3.7, 8, 15.2]) {
      const out = computeSampleTimestamps(dur, DEFAULT_FRAME_SAMPLING);
      expect(out[0]).toBe(0);
    }
  });

  it("guarantees a near-last frame for arbitrary duration", () => {
    for (const dur of [1, 3.7, 8, 15.2]) {
      const out = computeSampleTimestamps(dur, DEFAULT_FRAME_SAMPLING);
      const last = out.at(-1)!;
      expect(last).toBeGreaterThanOrEqual(dur - 0.06);
      expect(last).toBeLessThanOrEqual(dur);
    }
  });

  it("negative fps is clamped so the loop terminates", () => {
    // fps <= 0 would infinite-loop; the function clamps to a
    // minimum of 0.001. Verify it doesn't hang and returns
    // just the guaranteed first + last frames.
    const out = computeSampleTimestamps(5, {
      ...DEFAULT_FRAME_SAMPLING,
      fps: -1,
      maxFrames: 10,
    });
    // step becomes 1000 sec — the loop body runs once at t=0.
    // Then includeLast adds 4.95. Deduped, sorted.
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBeCloseTo(4.95, 2);
    expect(out.length).toBeLessThanOrEqual(10);
  });
});
