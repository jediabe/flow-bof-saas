import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleFinalVideo, AssemblyValidationError, type AssemblyManifest, type AssemblyMediaSources } from "../assemble-final-video";
import { runFfmpeg } from "../ffmpeg-runner";

async function hasFfmpeg(): Promise<boolean> {
  try {
    await runFfmpeg({ binary: process.env.FFMPEG_PATH ?? "ffmpeg", args: ["-version"], timeoutMs: 2000 });
    await runFfmpeg({ binary: process.env.FFPROBE_PATH ?? "ffprobe", args: ["-version"], timeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function synthClip(path: string, color: string, tone: number, duration = 1.2) {
  await runFfmpeg({
    binary: process.env.FFMPEG_PATH ?? "ffmpeg",
    args: [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:size=540x960:rate=12:duration=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${tone}:duration=${duration}`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path,
    ],
    timeoutMs: 10000,
  });
}

async function synthVoice(path: string, duration = 2) {
  await runFfmpeg({
    binary: process.env.FFMPEG_PATH ?? "ffmpeg",
    args: ["-y", "-f", "lavfi", "-i", `sine=frequency=880:duration=${duration}`, "-c:a", "aac", path],
    timeoutMs: 10000,
  });
}

async function fixture(dir: string, modes: ["duck" | "mute" | "preserve", "duck" | "mute" | "preserve"] = ["duck", "duck"]): Promise<{ manifest: AssemblyManifest; sources: AssemblyMediaSources }> {
  await mkdir(dir, { recursive: true });
  const clipA = join(dir, "clip-a.mp4");
  const clipB = join(dir, "clip-b.mp4");
  const voice = join(dir, "voice.m4a");
  await synthClip(clipA, "red", 330);
  await synthClip(clipB, "blue", 550);
  await synthVoice(voice, 2);
  const [clipABytes, clipBBytes, voiceBytes] = await Promise.all([readFile(clipA), readFile(clipB), readFile(voice)]);
  const manifest: AssemblyManifest = {
    version: "assembly-manifest-v1",
    ffmpegVersion: "8.1",
    output: {
      width: 1080,
      height: 1920,
      fps: 24,
      expectedDurationSeconds: 2,
      voiceoverGainDb: 0,
      nativeAudioGainDb: -18,
      duckingThresholdDb: -24,
    },
    clips: [
      { order: 0, slotId: "slot-a", assetId: "asset-a", assetSha256: sha256(clipABytes), approvalStatus: "APPROVED", trimStartSeconds: 0, trimEndSeconds: 1, durationSeconds: 1, nativeAudioMode: modes[0] },
      { order: 1, slotId: "slot-b", assetId: "asset-b", assetSha256: sha256(clipBBytes), approvalStatus: "APPROVED", trimStartSeconds: 0, trimEndSeconds: 1, durationSeconds: 1, nativeAudioMode: modes[1] },
    ],
    audio: { assetId: "voice-asset", assetSha256: sha256(voiceBytes), durationSeconds: 2 },
  };
  return {
    manifest,
    sources: {
      sourceRoot: dir,
      assets: {
        "asset-a": { path: clipA },
        "asset-b": { path: clipB },
        "voice-asset": { path: voice },
      },
    },
  };
}

async function extractFrameRgb(videoBytes: Uint8Array, atSeconds: number): Promise<[number, number, number]> {
  const dir = await mkdtemp(join(tmpdir(), "assembly-frame-test-"));
  try {
    const videoPath = join(dir, "video.mp4");
    const rgbPath = join(dir, "frame.rgb");
    await writeFile(videoPath, videoBytes);
    await runFfmpeg({
      binary: process.env.FFMPEG_PATH ?? "ffmpeg",
      args: ["-y", "-ss", String(atSeconds), "-i", videoPath, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", rgbPath],
      timeoutMs: 10000,
    });
    const rgb = await readFile(rgbPath);
    return [rgb[0], rgb[1], rgb[2]];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function audioRmsDb(videoBytes: Uint8Array): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "assembly-audio-test-"));
  try {
    const videoPath = join(dir, "video.mp4");
    await writeFile(videoPath, videoBytes);
    const result = await runFfmpeg({
      binary: process.env.FFMPEG_PATH ?? "ffmpeg",
      args: ["-i", videoPath, "-af", "astats=metadata=1:reset=0", "-f", "null", "-"],
      timeoutMs: 10000,
      stderrLimitBytes: 128 * 1024,
    });
    const matches = [...result.stderr.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?)/g)];
    const value = Number(matches.at(-1)?.[1]);
    if (!Number.isFinite(value)) throw new Error(`Could not parse RMS from ffmpeg astats: ${result.stderr}`);
    return value;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("assembleFinalVideo", () => {
  it("validates the persisted AssemblyManifest contract before resolving source media", async () => {
    const invalid = {
      id: "old-contract",
      clips: [],
      output: { width: 1080, height: 1920, fps: 24, finalDurationSeconds: 2, audioMix: { voiceoverGainDb: 0, nativeAudioGainDb: -18, duckingThresholdDb: -24 } },
    };

    await expect(assembleFinalVideo(invalid as never, { sourceRoot: tmpdir(), assets: {} })).rejects.toThrow(/AssemblyManifest/i);
  });

  it("rejects missing root, traversal, ambiguous path plus bytes, and hash drift before running ffmpeg", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assembly-reject-test-"));
    try {
      const { manifest, sources } = await fixture(dir);
      await expect(assembleFinalVideo(manifest, { assets: sources.assets })).rejects.toThrow(/sourceRoot/i);

      await expect(
        assembleFinalVideo(manifest, { sourceRoot: dir, assets: { ...sources.assets, "asset-a": { path: resolve(dir, "..", "outside.mp4") } } }),
      ).rejects.toBeInstanceOf(AssemblyValidationError);

      await expect(
        assembleFinalVideo(manifest, { sourceRoot: dir, assets: { ...sources.assets, "asset-a": { path: join(dir, "clip-a.mp4"), bytes: new Uint8Array([1]) } } }),
      ).rejects.toThrow(/either path or bytes/i);

      const hashManifest: AssemblyManifest = { ...manifest, clips: [{ ...manifest.clips[0], assetSha256: "0".repeat(64) }, manifest.clips[1]] };
      await expect(assembleFinalVideo(hashManifest, sources)).rejects.toThrow(/hash/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("accepts selected all-bytes assembly sources without a dummy sourceRoot despite unrelated path-backed extras", async () => {
    if (!(await hasFfmpeg())) return;
    const dir = await mkdtemp(join(tmpdir(), "assembly-bytes-only-test-"));
    try {
      const { manifest, sources } = await fixture(dir);
      const bytesOnlySources: AssemblyMediaSources = {
        assets: {
          "asset-a": { bytes: await readFile(sources.assets["asset-a"]!.path!) },
          "asset-b": { bytes: await readFile(sources.assets["asset-b"]!.path!) },
          "voice-asset": { bytes: await readFile(sources.assets["voice-asset"]!.path!) },
          "unselected-extra": { path: resolve(dir, "..", "outside-unselected.mp4") },
        },
      };

      const result = await assembleFinalVideo(manifest, bytesOnlySources);

      expect(result.bytes.length).toBeGreaterThan(1000);
      expect(JSON.stringify(result.commandManifest)).not.toContain(dir);
      expect(result.commandManifest.ffmpeg.args).not.toContain("undefined");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("rejects symlinked path sources whose real target escapes sourceRoot before reading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "assembly-symlink-root-test-"));
    const outside = await mkdtemp(join(tmpdir(), "assembly-symlink-outside-test-"));
    try {
      const { manifest, sources } = await fixture(dir);
      const outsideClip = join(outside, "outside.mp4");
      await synthClip(outsideClip, "green", 440);
      const outsideBytes = await readFile(outsideClip);
      const linkPath = join(dir, "linked-outside.mp4");
      try {
        await symlink(outsideClip, linkPath);
      } catch {
        return;
      }
      const escapedManifest: AssemblyManifest = {
        ...manifest,
        clips: [{ ...manifest.clips[0], assetSha256: sha256(outsideBytes) }, manifest.clips[1]],
      };

      await expect(
        assembleFinalVideo(escapedManifest, { sourceRoot: dir, assets: { ...sources.assets, "asset-a": { path: linkPath } } }),
      ).rejects.toThrow(/escapes sourceRoot/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 30000);

  it("assembles persisted manifest sources to exact ordered h264/yuv420p/aac 1080x1920 output", async () => {
    if (!(await hasFfmpeg())) return;
    const dir = await mkdtemp(join(tmpdir(), "assembly-video-test-"));
    try {
      const { manifest, sources } = await fixture(dir, ["duck", "duck"]);
      const result = await assembleFinalVideo(manifest, sources);

      expect(result.sha256).toHaveLength(64);
      expect(result.bytes.length).toBeGreaterThan(1000);
      expect(result.probe.video).toMatchObject({ width: 1080, height: 1920, codec: "h264", pixelFormat: "yuv420p", fps: 24 });
      expect(result.probe.audio?.codec).toBe("aac");
      expect(result.probe.durationSeconds).toBeGreaterThanOrEqual(1.8);
      expect(result.probe.durationSeconds).toBeLessThanOrEqual(2.35);
      expect(result.commandManifest.inputs.map((input) => input.assetId)).toEqual(["asset-a", "asset-b", "voice-asset"]);

      const first = await extractFrameRgb(result.bytes, 0.2);
      const second = await extractFrameRgb(result.bytes, 1.2);
      expect(first[0]).toBeGreaterThan(first[2]);
      expect(second[2]).toBeGreaterThan(second[0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("uses deterministic mute, preserve, and threshold-based duck native-audio modes", async () => {
    if (!(await hasFfmpeg())) return;
    const dir = await mkdtemp(join(tmpdir(), "assembly-audio-modes-test-"));
    try {
      const mutedFixture = await fixture(join(dir, "mute"), ["mute", "mute"]);
      const preservedFixture = await fixture(join(dir, "preserve"), ["preserve", "preserve"]);
      const duckFixture = await fixture(join(dir, "duck"), ["duck", "duck"]);
      const lessSensitiveDuckFixture = await fixture(join(dir, "duck-less-sensitive"), ["duck", "duck"]);
      lessSensitiveDuckFixture.manifest.output.duckingThresholdDb = -6;
      const muted = await assembleFinalVideo(mutedFixture.manifest, mutedFixture.sources);
      const preserved = await assembleFinalVideo(preservedFixture.manifest, preservedFixture.sources);
      const ducked = await assembleFinalVideo(duckFixture.manifest, duckFixture.sources);
      const lessSensitiveDucked = await assembleFinalVideo(lessSensitiveDuckFixture.manifest, lessSensitiveDuckFixture.sources);

      expect(muted.commandManifest.audioModes).toEqual(["mute", "mute"]);
      expect(preserved.commandManifest.audioModes).toEqual(["preserve", "preserve"]);
      expect(ducked.commandManifest.audioModes).toEqual(["duck", "duck"]);
      expect(ducked.commandManifest.filterGraph).toContain("sidechaincompress");
      expect(ducked.commandManifest.filterGraph).toContain("threshold=0.063096");
      expect(lessSensitiveDucked.commandManifest.filterGraph).toContain("threshold=0.501187");
      const mutedRms = await audioRmsDb(muted.bytes);
      const preservedRms = await audioRmsDb(preserved.bytes);
      const duckedRms = await audioRmsDb(ducked.bytes);
      const lessSensitiveDuckedRms = await audioRmsDb(lessSensitiveDucked.bytes);
      expect(preservedRms).toBeGreaterThan(mutedRms);
      expect(duckedRms).toBeLessThan(preservedRms);
      expect(Math.abs(lessSensitiveDuckedRms - duckedRms)).toBeGreaterThan(0.01);
      expect(lessSensitiveDucked.sha256).not.toBe(ducked.sha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);

  it("returns a canonical command manifest independent of temp paths across equivalent runs", async () => {
    if (!(await hasFfmpeg())) return;
    const dir = await mkdtemp(join(tmpdir(), "assembly-determinism-test-"));
    try {
      const firstFixture = await fixture(join(dir, "one"));
      const secondFixture = await fixture(join(dir, "two"));
      const first = await assembleFinalVideo(firstFixture.manifest, firstFixture.sources);
      const second = await assembleFinalVideo(secondFixture.manifest, secondFixture.sources);

      expect(first.commandManifest).toEqual(second.commandManifest);
      expect(JSON.stringify(first.commandManifest)).not.toContain(dir);
      expect(first.commandManifest.ffmpeg.args).toContain("<output>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90000);
});
