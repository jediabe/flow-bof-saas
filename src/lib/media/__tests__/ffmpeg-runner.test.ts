import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FfmpegRunError, runFfmpeg } from "../ffmpeg-runner";
import { probeMedia } from "../probe-media";

async function hasBinary(binary: string): Promise<boolean> {
  try {
    await runFfmpeg({ binary, args: ["-version"], timeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}

describe("ffmpeg runner and probe primitives", () => {
  it("uses argv arrays without shell interpolation and returns a deterministic command manifest", async () => {
    const result = await runFfmpeg({ binary: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "a;b && c"], timeoutMs: 2000 });

    expect(result.stdout).toBe("a;b && c");
    expect(result.command).toEqual({ binary: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "a;b && c"] });
  });

  it("rejects null-byte argv entries before spawn", async () => {
    await expect(runFfmpeg({ binary: process.execPath, args: ["bad\0arg"] })).rejects.toBeInstanceOf(FfmpegRunError);
  });

  it("fails closed on nonzero process exits with bounded stderr", async () => {
    await expect(
      runFfmpeg({ binary: process.execPath, args: ["-e", "console.error('x'.repeat(10000)); process.exit(7)"], stderrLimitBytes: 256 }),
    ).rejects.toMatchObject({ code: "NONZERO_EXIT", exitCode: 7 });
  });

  it("probes real synthetic media streams when ffmpeg is available", async () => {
    if (!(await hasBinary(process.env.FFMPEG_PATH ?? "ffmpeg")) || !(await hasBinary(process.env.FFPROBE_PATH ?? "ffprobe"))) {
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "probe-media-test-"));
    try {
      const out = join(dir, "sample.mp4");
      await runFfmpeg({
        binary: process.env.FFMPEG_PATH ?? "ffmpeg",
        args: [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x240:rate=15:duration=1",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          out,
        ],
      });

      const probe = await probeMedia(out);
      expect(probe.durationSeconds).toBeCloseTo(1, 1);
      expect(probe.video).toMatchObject({ width: 320, height: 240, codec: "h264" });
      expect(probe.audio?.codec).toBe("aac");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed media instead of returning partial metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "probe-bad-test-"));
    try {
      const file = join(dir, "bad.mp4");
      await writeFile(file, "not video");
      await expect(probeMedia(file)).rejects.toThrow(/ffprobe|probe/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
