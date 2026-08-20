import {
  normalizeVoiceoverScript,
  sha256Bytes,
  VoiceoverConfigurationError,
  VoiceoverContentTypeError,
  VoiceoverSizeError,
  VoiceoverTerminalProviderError,
  VoiceoverTimeoutError,
  type GenerateVoiceoverInput,
  type GenerateVoiceoverResult,
  type VoiceoverProvider,
} from "./provider";

export interface ElevenLabsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}

export interface ElevenLabsVoiceoverProviderConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  voiceSettings?: ElevenLabsVoiceSettings;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export function createElevenLabsVoiceoverProvider(config: ElevenLabsVoiceoverProviderConfig): VoiceoverProvider {
  return new ElevenLabsVoiceoverProvider(config);
}

class ElevenLabsVoiceoverProvider implements VoiceoverProvider {
  readonly provider = "elevenlabs" as const;
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly voiceSettings: ElevenLabsVoiceSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly baseUrl: string;

  constructor(config: ElevenLabsVoiceoverProviderConfig) {
    if (!config.apiKey?.trim()) throw new VoiceoverConfigurationError("ElevenLabs API key is required.");
    if (!config.voiceId?.trim()) throw new VoiceoverConfigurationError("ElevenLabs voiceId is required.");
    if (!config.modelId?.trim()) throw new VoiceoverConfigurationError("ElevenLabs modelId is required.");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new VoiceoverConfigurationError("ElevenLabs timeoutMs must be positive.");
    }
    if (!Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
      throw new VoiceoverConfigurationError("ElevenLabs maxBytes must be positive.");
    }
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId;
    this.modelId = config.modelId;
    this.voiceSettings = Object.freeze({ ...(config.voiceSettings ?? {}) });
    this.fetchImpl = config.fetch ?? fetch;
    this.baseUrl = config.baseUrl ?? "https://api.elevenlabs.io/v1";
  }

  async generate(input: GenerateVoiceoverInput): Promise<GenerateVoiceoverResult> {
    const normalizedScript = normalizeVoiceoverScript(input.script);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/text-to-speech/${encodeURIComponent(this.voiceId)}`, {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "content-type": "application/json",
          accept: acceptedContentType(input.format),
        },
        body: JSON.stringify({
          text: normalizedScript,
          model_id: this.modelId,
          voice_settings: this.voiceSettings,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new VoiceoverTerminalProviderError(
          `ElevenLabs voiceover request failed terminally with HTTP ${resp.status} ${resp.statusText}. No automatic duplicate TTS call was attempted.`,
        );
      }

      const contentType = resp.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
      if (!contentType.startsWith("audio/")) {
        throw new VoiceoverContentTypeError(`ElevenLabs returned non-audio content-type: ${contentType || "<missing>"}.`);
      }
      const contentLength = Number.parseInt(resp.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(contentLength) && contentLength > this.maxBytes) {
        throw new VoiceoverSizeError(`ElevenLabs audio content-length ${contentLength} exceeds maximum ${this.maxBytes}.`);
      }

      const bytes = await readBodyBounded(resp, this.maxBytes, controller.signal);
      if (bytes.byteLength === 0) {
        throw new VoiceoverSizeError("ElevenLabs returned empty audio bytes.");
      }

      return {
        provider: "elevenlabs",
        voiceId: this.voiceId,
        modelId: this.modelId,
        normalizedScript,
        bytes,
        bytesLength: bytes.byteLength,
        sha256: sha256Bytes(bytes),
        contentType,
      };
    } catch (err) {
      if (err instanceof VoiceoverContentTypeError || err instanceof VoiceoverSizeError || err instanceof VoiceoverTerminalProviderError) throw err;
      if ((err as Error).name === "AbortError" || controller.signal.aborted) {
        throw new VoiceoverTimeoutError(`ElevenLabs voiceover request timed out after ${this.timeoutMs}ms.`);
      }
      throw new VoiceoverTerminalProviderError(
        "ElevenLabs voiceover request failed terminally before a response. No automatic duplicate TTS call was attempted.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBodyBounded(resp: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!resp.body) {
    throw new VoiceoverSizeError("ElevenLabs audio response did not provide a streamable body for bounded reads.");
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const read = await readChunkWithAbort(reader, signal);
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new VoiceoverSizeError(`ElevenLabs audio bytes exceeded maximum ${maxBytes}.`);
      }
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readChunkWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function acceptedContentType(format: GenerateVoiceoverInput["format"]): string {
  switch (format) {
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "mp3":
    default:
      return "audio/mpeg";
  }
}
