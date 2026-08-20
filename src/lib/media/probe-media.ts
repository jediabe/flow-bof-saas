import { runFfmpeg } from "./ffmpeg-runner";

export interface ProbeMediaResult {
  durationSeconds: number;
  video: {
    codec: string;
    width: number;
    height: number;
    pixelFormat?: string;
    fps?: number;
  };
  audio?: {
    codec: string;
    sampleRate?: number;
    channels?: number;
  };
  formatName?: string;
}

export interface ProbeMediaOptions {
  ffprobePath?: string;
  timeoutMs?: number;
  requireVideo?: boolean;
}

interface FfprobeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
  }>;
  format?: { duration?: string; format_name?: string };
}

export async function probeMedia(path: string, options: ProbeMediaOptions = {}): Promise<ProbeMediaResult> {
  const ffprobePath = options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const result = await runFfmpeg({
    binary: ffprobePath,
    args: ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(result.stdout) as FfprobeJson;
  } catch (err) {
    throw new Error(`ffprobe returned malformed JSON for ${path}.`, { cause: err });
  }

  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const requireVideo = options.requireVideo ?? true;
  if (requireVideo && (!videoStream?.codec_name || !videoStream.width || !videoStream.height)) {
    throw new Error(`ffprobe found no complete video stream for ${path}.`);
  }
  const durationSeconds = Number.parseFloat(parsed.format?.duration ?? "");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe returned invalid duration for ${path}: ${parsed.format?.duration ?? "<missing>"}.`);
  }
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds,
    video: videoStream?.codec_name && videoStream.width && videoStream.height
      ? {
          codec: videoStream.codec_name,
          width: videoStream.width,
          height: videoStream.height,
          pixelFormat: videoStream.pix_fmt,
          fps: parseRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
        }
      : undefined as never,
    audio: audioStream?.codec_name
      ? {
          codec: audioStream.codec_name,
          sampleRate: audioStream.sample_rate ? Number.parseInt(audioStream.sample_rate, 10) : undefined,
          channels: audioStream.channels,
        }
      : undefined,
    formatName: parsed.format?.format_name,
  };
}

function parseRate(rate?: string): number | undefined {
  if (!rate || rate === "0/0") return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
  const direct = Number(rate);
  return Number.isFinite(direct) ? direct : undefined;
}
