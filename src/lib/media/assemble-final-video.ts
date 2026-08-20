import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { z } from "zod";
import { AssemblyManifestSchema } from "../content-runs/schemas";
import { runFfmpeg, type FfmpegCommandManifest } from "./ffmpeg-runner";
import { probeMedia, type ProbeMediaResult } from "./probe-media";

export type NativeAudioMode = "duck" | "mute" | "preserve";
export type AssemblyManifest = z.infer<typeof AssemblyManifestSchema>;

export interface AssemblySourceMaterial {
  path?: string;
  bytes?: Uint8Array;
}

export interface AssemblyMediaSources {
  sourceRoot?: string;
  assets: Record<string, AssemblySourceMaterial | undefined>;
}

export interface AssemblyCommandManifest {
  ffmpeg: FfmpegCommandManifest;
  filterGraph: string;
  inputs: Array<{ assetId: string; slotId: string; sha256: string; trim?: { start: number; end: number } }>;
  audioModes: NativeAudioMode[];
}

export interface AssembleFinalVideoResult {
  bytes: Uint8Array;
  sha256: string;
  probe: ProbeMediaResult;
  commandManifest: AssemblyCommandManifest;
}

export class AssemblyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

interface MaterializedInput {
  assetId: string;
  slotId: string;
  path: string;
  canonicalPath: string;
}

export async function assembleFinalVideo(manifestInput: AssemblyManifest, sources: AssemblyMediaSources): Promise<AssembleFinalVideoResult> {
  const manifest = validatePersistedManifest(manifestInput);
  const orderedClips = [...manifest.clips].sort((a, b) => a.order - b.order);
  const selectedAssetIds = new Set([...orderedClips.map((clip) => clip.assetId), manifest.audio.assetId]);
  const selectedPathBackedSource = validateSources(sources, selectedAssetIds);
  const workDir = await mkdtemp(join(tmpdir(), "final-assembly-"));
  try {
    const sourceRoot = selectedPathBackedSource ? await realpath(resolve(sources.sourceRoot!)) : undefined;
    const clips: MaterializedInput[] = [];
    for (const clip of orderedClips) {
      clips.push(
        await materializeSource({
          assetId: clip.assetId,
          slotId: clip.slotId,
          expectedSha256: clip.assetSha256,
          source: sources.assets[clip.assetId],
          sourceRoot,
          workDir,
          fallbackName: `${clip.order}-${safeName(clip.slotId)}.mp4`,
          canonicalPath: `<clip:${clip.assetId}>`,
        }),
      );
    }
    const voice = await materializeSource({
      assetId: manifest.audio.assetId,
      slotId: "voiceover",
      expectedSha256: manifest.audio.assetSha256,
      source: sources.assets[manifest.audio.assetId],
      sourceRoot,
      workDir,
      fallbackName: "voiceover",
      canonicalPath: `<audio:${manifest.audio.assetId}>`,
    });

    for (let i = 0; i < orderedClips.length; i++) {
      const probe = await probeMedia(clips[i].path);
      if (!probe.video || !probe.audio) {
        throw new AssemblyValidationError(`Clip ${orderedClips[i].slotId} is missing required video or audio stream.`);
      }
    }
    const voiceProbe = await probeMedia(voice.path, { requireVideo: false });
    if (!voiceProbe.audio) throw new AssemblyValidationError("Voiceover is missing an audio stream.");

    const outPath = join(workDir, "final.mp4");
    const built = buildFfmpegArgs(manifest, clips.map((clip) => clip.path), voice.path, outPath);
    const run = await runFfmpeg({ binary: process.env.FFMPEG_PATH ?? "ffmpeg", args: built.args, timeoutMs: 180_000 });
    const bytes = await readFile(outPath);
    const probe = await probeMedia(outPath);
    validateOutputProbe(manifest, probe);
    return {
      bytes: new Uint8Array(bytes),
      sha256: sha256(bytes),
      probe,
      commandManifest: {
        ffmpeg: canonicalizeCommand(run.command, [...clips, voice], outPath),
        filterGraph: built.filterGraph,
        inputs: [
          ...orderedClips.map((clip) => ({
            assetId: clip.assetId,
            slotId: clip.slotId,
            sha256: clip.assetSha256,
            trim: { start: clip.trimStartSeconds, end: clip.trimEndSeconds },
          })),
          { assetId: manifest.audio.assetId, slotId: "voiceover", sha256: manifest.audio.assetSha256 },
        ],
        audioModes: built.audioModes,
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function validatePersistedManifest(manifest: AssemblyManifest): AssemblyManifest {
  const parsed = AssemblyManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new AssemblyValidationError(`AssemblyManifest validation failed: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  if (parsed.data.output.width !== 1080 || parsed.data.output.height !== 1920) {
    throw new AssemblyValidationError("Final assembly output must be 1080x1920.");
  }
  return parsed.data;
}

function validateSources(sources: AssemblyMediaSources, selectedAssetIds: ReadonlySet<string>): boolean {
  const hasSelectedPathBackedSource = [...selectedAssetIds].some((assetId) => sources.assets[assetId]?.path);
  if (hasSelectedPathBackedSource && !sources.sourceRoot?.trim()) {
    throw new AssemblyValidationError("Assembly path-backed sources require sourceRoot.");
  }
  return hasSelectedPathBackedSource;
}

async function materializeSource(input: {
  assetId: string;
  slotId: string;
  source: AssemblySourceMaterial | undefined;
  expectedSha256: string;
  sourceRoot: string | undefined;
  workDir: string;
  fallbackName: string;
  canonicalPath: string;
}): Promise<MaterializedInput> {
  const { source, assetId, slotId, expectedSha256, sourceRoot, workDir, fallbackName, canonicalPath } = input;
  if (!source) throw new AssemblyValidationError(`Missing source material for asset ${assetId}.`);
  if (source.path && source.bytes) throw new AssemblyValidationError(`Source material for ${assetId} must provide either path or bytes, not both.`);
  let path: string;
  if (source.path) {
    if (!sourceRoot) throw new AssemblyValidationError("Assembly path-backed sources require sourceRoot.");
    const resolvedPath = resolve(source.path);
    if (!isWithin(resolvedPath, sourceRoot)) {
      throw new AssemblyValidationError(`Source path escapes sourceRoot: ${source.path}`);
    }
    path = await realpath(resolvedPath);
    if (!isWithin(path, sourceRoot)) {
      throw new AssemblyValidationError(`Source path escapes sourceRoot: ${source.path}`);
    }
  } else if (source.bytes) {
    await mkdir(workDir, { recursive: true });
    path = join(workDir, basename(fallbackName));
    await writeFile(path, source.bytes);
  } else {
    throw new AssemblyValidationError(`Source material for ${assetId} must provide path or bytes.`);
  }
  const bytes = await readFile(path);
  const actualHash = sha256(bytes);
  if (actualHash !== expectedSha256) {
    throw new AssemblyValidationError(`Source hash mismatch for ${assetId}: expected ${expectedSha256}, got ${actualHash}.`);
  }
  return { assetId, slotId, path, canonicalPath };
}

function buildFfmpegArgs(manifest: AssemblyManifest, clipPaths: string[], voicePath: string, outPath: string): { args: string[]; audioModes: NativeAudioMode[]; filterGraph: string } {
  const args = ["-y", "-loglevel", "error"];
  for (const path of clipPaths) args.push("-i", path);
  args.push("-i", voicePath);

  const orderedClips = [...manifest.clips].sort((a, b) => a.order - b.order);
  const filters: string[] = [];
  const concatRefs: string[] = [];
  const audioModes: NativeAudioMode[] = [];
  const duckIndexes = orderedClips.map((clip, index) => clip.nativeAudioMode === "duck" ? index : -1).filter((index) => index >= 0);
  const voiceInputIndex = clipPaths.length;
  const voiceRaw = duckIndexes.length > 0 ? "voiceMix" : "voiceRaw";
  if (duckIndexes.length > 0) {
    filters.push(`[${voiceInputIndex}:a]asplit=${duckIndexes.length + 1}[voiceMix]${duckIndexes.map((_, index) => `[duckSide${index}]`).join("")}`);
  } else {
    filters.push(`[${voiceInputIndex}:a]anull[voiceRaw]`);
  }

  let duckSideIndex = 0;
  for (let i = 0; i < orderedClips.length; i++) {
    const clip = orderedClips[i];
    const duration = clip.trimEndSeconds - clip.trimStartSeconds;
    filters.push(
      `[${i}:v]trim=start=${num(clip.trimStartSeconds)}:end=${num(clip.trimEndSeconds)},setpts=PTS-STARTPTS,scale=${manifest.output.width}:${manifest.output.height}:force_original_aspect_ratio=decrease,pad=${manifest.output.width}:${manifest.output.height}:(ow-iw)/2:(oh-ih)/2,fps=${num(manifest.output.fps)},setsar=1,format=yuv420p[v${i}]`,
    );
    if (clip.nativeAudioMode === "mute") {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${num(duration)}[a${i}]`);
    } else {
      const nativeLabel = `native${i}`;
      filters.push(
        `[${i}:a]atrim=start=${num(clip.trimStartSeconds)}:end=${num(clip.trimEndSeconds)},asetpts=PTS-STARTPTS,volume=${db(clip.nativeAudioMode === "duck" ? manifest.output.nativeAudioGainDb : 0)}[${nativeLabel}]`,
      );
      if (clip.nativeAudioMode === "duck") {
        const sideLabel = `duckSide${duckSideIndex++}`;
        filters.push(
          `[${nativeLabel}][${sideLabel}]sidechaincompress=threshold=${linear(manifest.output.duckingThresholdDb)}:ratio=8:attack=5:release=250[a${i}]`,
        );
      } else {
        filters.push(`[${nativeLabel}]anull[a${i}]`);
      }
    }
    concatRefs.push(`[v${i}][a${i}]`);
    audioModes.push(clip.nativeAudioMode);
  }
  filters.push(`${concatRefs.join("")}concat=n=${orderedClips.length}:v=1:a=1[vcat][anative]`);
  filters.push(
    `[${voiceRaw}]atrim=duration=${num(manifest.output.expectedDurationSeconds)},asetpts=PTS-STARTPTS,volume=${db(manifest.output.voiceoverGainDb)}[avoice]`,
  );
  filters.push(`[anative][avoice]amix=inputs=2:duration=first:dropout_transition=0,atrim=duration=${num(manifest.output.expectedDurationSeconds)}[aout]`);
  const filterGraph = filters.join(";");
  args.push(
    "-filter_complex",
    filterGraph,
    "-map",
    "[vcat]",
    "-map",
    "[aout]",
    "-t",
    num(manifest.output.expectedDurationSeconds),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    num(manifest.output.fps),
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    outPath,
  );
  return { args, audioModes, filterGraph };
}

function validateOutputProbe(manifest: AssemblyManifest, probe: ProbeMediaResult): void {
  const tolerance = 0.25;
  if (probe.video.width !== manifest.output.width || probe.video.height !== manifest.output.height) {
    throw new AssemblyValidationError(`Final video dimensions ${probe.video.width}x${probe.video.height} do not match manifest.`);
  }
  if (probe.video.codec !== "h264" || probe.video.pixelFormat !== "yuv420p") {
    throw new AssemblyValidationError(`Final video codec/pixel format ${probe.video.codec}/${probe.video.pixelFormat} does not match manifest.`);
  }
  if (probe.video.fps !== undefined && Math.abs(probe.video.fps - manifest.output.fps) > 0.01) {
    throw new AssemblyValidationError(`Final fps ${probe.video.fps} does not match manifest fps ${manifest.output.fps}.`);
  }
  if (probe.audio?.codec !== "aac") throw new AssemblyValidationError("Final video is missing AAC audio.");
  if (Math.abs(probe.durationSeconds - manifest.output.expectedDurationSeconds) > tolerance) {
    throw new AssemblyValidationError(
      `Final duration ${probe.durationSeconds}s is outside tolerance for expected ${manifest.output.expectedDurationSeconds}s.`,
    );
  }
}

function canonicalizeCommand(command: FfmpegCommandManifest, inputs: MaterializedInput[], outPath: string): FfmpegCommandManifest {
  const replacements = new Map<string, string>(inputs.map((input) => [input.path, input.canonicalPath]));
  replacements.set(outPath, "<output>");
  return {
    binary: basename(command.binary),
    args: command.args.map((arg) => replacements.get(arg) ?? arg),
  };
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "_");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function num(value: number): string {
  if (!Number.isFinite(value)) throw new AssemblyValidationError("Non-finite numeric value in assembly manifest.");
  return Number(value.toFixed(6)).toString();
}

function db(value: number): string {
  return `${num(value)}dB`;
}

function linear(dbValue: number): string {
  return num(10 ** (dbValue / 20));
}
