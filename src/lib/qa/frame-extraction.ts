/**
 * Video frame extraction for the Milestone 1 QA pipeline.
 *
 * Downloads a signed video URL to a unique temp directory,
 * probes duration with ffprobe, extracts a sampled set of
 * frames as JPEGs, base64-encodes them, and cleans up.
 *
 * DESIGN CHOICES:
 *
 *   1. child_process.spawn directly — no `fluent-ffmpeg` wrapper.
 *      The ffmpeg CLI surface is stable and one small spawn helper
 *      covers everything we need. Adding a wrapper dep for a
 *      handful of arg strings isn't worth the npm install.
 *
 *   2. FFMPEG_PATH / FFPROBE_PATH env vars → fallback to `ffmpeg`
 *      / `ffprobe` on PATH. The production Docker image installs
 *      Alpine's `ffmpeg` package which puts both binaries at
 *      /usr/bin/. Dev machines discover through PATH.
 *
 *   3. Frames emitted as JPEG at quality 3 (roughly 0.05-0.10 MB
 *      per 1024x1024 frame). Sending JPEG matches the Anthropic
 *      Messages API's most-efficient format and keeps the request
 *      well under the ~5 MiB per-image cap even for a dense
 *      sampling.
 *
 *   4. Frames are scaled to fit within a 1024x1024 box while
 *      preserving aspect ratio. For a 1080x1920 (9:16) Style 1
 *      clip that yields 576x1024. Retains label / hand / product
 *      readability while trimming ~65% of pixel bytes vs raw.
 *
 *   5. Sampling policy is data (see FrameSamplingOptions) so we
 *      can adjust it in one place. Default: guaranteed first
 *      frame, ~1 FPS through the clip, guaranteed last frame,
 *      deduplicated (a 4s clip on ~1fps + first + last collapses
 *      to 5 unique timestamps: 0, 1, 2, 3, 3.95).
 *
 * ERRORS:
 *   Wrapped as FrameExtractionError with cause. The most common
 *   failure modes are:
 *     - ffmpeg / ffprobe binary not found (misconfigured env)
 *     - HTTP fetch of the video URL failed
 *     - non-video content-type from the URL
 *     - ffprobe returned unparseable duration
 *     - ffmpeg exited non-zero (corrupt input, unsupported codec)
 *     - zero frames extracted (edge case — should be caught earlier)
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameExtractionError } from "./errors";
import type { ExtractedFrame } from "./visual-qa-provider";

/** How to pick frame timestamps from a clip. Kept as data so a
 *  Phase-D adjustment (denser sampling around suspected defect
 *  timestamps, etc.) is a config change, not a rewrite. */
export interface FrameSamplingOptions {
  /** Approximate frames per second through the clip. Default 1. */
  fps: number;
  /** Guarantee the very first frame (t=0) is included. Default true. */
  includeFirst: boolean;
  /** Guarantee a frame near the very end is included. Default true. */
  includeLast: boolean;
  /**
   * Offset (seconds) subtracted from `duration` to pick the last
   * frame timestamp. ffmpeg can't seek exactly to `duration`
   * without landing past-end, so we back off slightly. Default 0.05.
   */
  lastFrameOffsetSec: number;
  /** Maximum longest edge (pixels) of output frames. Default 1024. */
  maxDimension: number;
  /**
   * JPEG quality passed to ffmpeg `-q:v`. Range 2-31 (lower is
   * better). Default 3 — near-visually-lossless for QA purposes.
   */
  jpegQuality: number;
  /** Absolute hard cap on frames returned, defence against a
   *  pathological long input. Default 32. */
  maxFrames: number;
}

export const DEFAULT_FRAME_SAMPLING: FrameSamplingOptions = {
  fps: 1,
  includeFirst: true,
  includeLast: true,
  lastFrameOffsetSec: 0.05,
  maxDimension: 1024,
  jpegQuality: 3,
  maxFrames: 32,
};

export interface ExtractFramesInput {
  /** Signed URL to fetch the video from. */
  videoUrl: string;
  /** Optional sampling override. Undefined = DEFAULT_FRAME_SAMPLING. */
  sampling?: Partial<FrameSamplingOptions>;
  /** Optional path override for the ffmpeg binary. Falls back to
   *  process.env.FFMPEG_PATH or `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Same, for ffprobe. */
  ffprobePath?: string;
}

export interface ExtractFramesResult {
  frames: ExtractedFrame[];
  /** Full duration reported by ffprobe (seconds). Kept in the
   *  return for diagnostics on QaAttempt. */
  durationSec: number;
  /** Timestamps (ms) the sampler requested, in order. Useful for
   *  audit diagnostics if the extractor came back with a
   *  different count than expected. */
  requestedTimestampsMs: number[];
}

export async function extractFrames(
  input: ExtractFramesInput,
): Promise<ExtractFramesResult> {
  const sampling: FrameSamplingOptions = {
    ...DEFAULT_FRAME_SAMPLING,
    ...(input.sampling ?? {}),
  };
  const ffmpegPath = input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const ffprobePath =
    input.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";

  const workDir = await mkdtemp(join(tmpdir(), "qa-frames-"));
  const videoPath = join(workDir, "input");
  const framesDir = join(workDir, "frames");
  await mkdir(framesDir, { recursive: true });

  try {
    // 1. Fetch the video bytes.
    let resp: Response;
    try {
      resp = await fetch(input.videoUrl);
    } catch (err) {
      throw new FrameExtractionError(
        `Video fetch failed: ${(err as Error).message?.slice(0, 200)}`,
        { cause: err },
      );
    }
    if (!resp.ok) {
      throw new FrameExtractionError(
        `Video fetch returned HTTP ${resp.status} ${resp.statusText}`,
      );
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    await writeFile(videoPath, bytes);

    // 2. Probe duration.
    const durationSec = await probeDurationSec(ffprobePath, videoPath);

    // 3. Compute requested timestamps in seconds → ms.
    const timestampsSec = computeSampleTimestamps(durationSec, sampling);
    const requestedTimestampsMs = timestampsSec.map((s) => Math.round(s * 1000));

    if (timestampsSec.length === 0) {
      throw new FrameExtractionError(
        `Sampling produced zero timestamps for duration ${durationSec}s.`,
      );
    }

    // 4. Extract each timestamp as a separate ffmpeg call. N
    //    calls for N frames — for a typical 8s Style 1 clip
    //    that's ~9 fast invocations. Simpler + more reliable
    //    than a single-call select-filter expression, and
    //    parallelizable if we ever need it.
    const scaleExpr = `scale='min(${sampling.maxDimension},iw)':'min(${sampling.maxDimension},ih)':force_original_aspect_ratio=decrease`;
    const frames: ExtractedFrame[] = [];
    for (let i = 0; i < timestampsSec.length; i++) {
      const ts = timestampsSec[i];
      const outPath = join(
        framesDir,
        `frame_${String(i).padStart(3, "0")}.jpg`,
      );
      await runFfmpeg(ffmpegPath, [
        "-y",                     // overwrite (shouldn't happen, defensive)
        "-loglevel", "error",     // silence chatter
        "-ss", String(ts),        // seek input (fast, keyframe-accurate is fine for QA)
        "-i", videoPath,
        "-frames:v", "1",
        "-vf", scaleExpr,
        "-q:v", String(sampling.jpegQuality),
        outPath,
      ]);
      let jpegBytes: Buffer;
      try {
        jpegBytes = await readFile(outPath);
      } catch (err) {
        throw new FrameExtractionError(
          `ffmpeg reported success but frame file was missing at ${outPath}.`,
          { cause: err },
        );
      }
      frames.push({
        timestampMs: requestedTimestampsMs[i],
        data: jpegBytes.toString("base64"),
        mediaType: "image/jpeg",
      });
    }

    return { frames, durationSec, requestedTimestampsMs };
  } finally {
    // Best-effort cleanup. Failure here shouldn't mask the
    // primary result / error.
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Compute the sorted, deduplicated list of sample timestamps
 * (seconds) for a clip of the given duration and sampling
 * config.
 *
 *   - includeFirst adds 0.0
 *   - Every 1/fps interval through the clip is added
 *   - includeLast adds max(0, duration - lastFrameOffsetSec)
 *   - Deduplicated to millisecond precision (two timestamps
 *     within 1ms of each other collapse — happens when the last
 *     frame lands on a whole second at 1fps)
 *   - Trimmed to maxFrames
 *
 * Exported for tests — the sampling policy is worth pinning
 * independently of the ffmpeg invocation.
 */
export function computeSampleTimestamps(
  durationSec: number,
  opts: FrameSamplingOptions,
): number[] {
  if (durationSec <= 0) return opts.includeFirst ? [0] : [];
  const stepSec = 1 / Math.max(0.001, opts.fps);
  const set = new Set<number>();
  const round = (s: number) => Math.round(s * 1000) / 1000;

  if (opts.includeFirst) set.add(0);
  for (let t = 0; t < durationSec; t += stepSec) {
    set.add(round(t));
  }
  if (opts.includeLast) {
    const last = Math.max(0, durationSec - opts.lastFrameOffsetSec);
    set.add(round(last));
  }
  const sorted = [...set].sort((a, b) => a - b);
  return sorted.slice(0, opts.maxFrames);
}

async function probeDurationSec(ffprobePath: string, videoPath: string): Promise<number> {
  const stdout = await runProcess(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration < 0) {
    throw new FrameExtractionError(
      `ffprobe returned unparseable duration: ${stdout.slice(0, 100).trim() || "<empty>"}`,
    );
  }
  return duration;
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  await runProcess(ffmpegPath, args);
}

/**
 * Spawn a child process and resolve with its stdout, or reject
 * with FrameExtractionError on non-zero exit / spawn failure.
 * Kept small and dependency-free.
 */
async function runProcess(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(
        new FrameExtractionError(
          `Failed to spawn ${binary}: ${err.message}. Is ffmpeg installed? Set FFMPEG_PATH / FFPROBE_PATH to override the binary location.`,
          { cause: err },
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      reject(
        new FrameExtractionError(
          `${binary} exited with code ${code}. Last stderr lines:\n${tail || "<no stderr>"}`,
        ),
      );
    });
  });
}

// Referenced by orchestrator + tests. Kept internal.
export const __internals = {
  computeSampleTimestamps,
  runProcess,
  probeDurationSec,
  DEFAULT_FRAME_SAMPLING,
};

