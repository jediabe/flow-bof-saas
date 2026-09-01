import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceoverConfigurationError,
  VoiceoverContentTypeError,
  VoiceoverProviderError,
  VoiceoverSizeError,
  VoiceoverTimeoutError,
  normalizeVoiceoverScript,
} from "../provider";
import { createElevenLabsVoiceoverProvider } from "../elevenlabs-provider";

const TEST_API_KEY = ["test", "api", "key"].join("-");
const EMPTY_API_KEY = "";
const audioBytes = new Uint8Array([1, 2, 3, 4]);

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function response(init: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}): Response {
  const bytes = init.bytes ?? audioBytes;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers: new Headers(init.headers ?? { "content-type": "audio/mpeg" }),
    body: init.body === undefined ? new Response(exactArrayBuffer(bytes)).body : init.body,
    arrayBuffer: init.arrayBuffer ?? (async () => exactArrayBuffer(bytes)),
    text: async () => "provider body containing should-not-leak",
  } as Response;
}

describe("normalizeVoiceoverScript", () => {
  it("normalizes whitespace while preserving spoken punctuation", () => {
    expect(normalizeVoiceoverScript("  Save\n\n  more…   today!  ")).toBe("Save more… today!");
  });

  it("rejects empty or overlong scripts before provider spend", () => {
    expect(() => normalizeVoiceoverScript("   ")).toThrow(VoiceoverProviderError);
    expect(() => normalizeVoiceoverScript("x".repeat(5001), { maxCharacters: 5000 })).toThrow(
      VoiceoverProviderError,
    );
  });
});

describe("ElevenLabsVoiceoverProvider", () => {
  it("posts the normalized script once with frozen voice/model/settings and returns bytes metadata", async () => {
    const fetch = vi.fn(async () => response({ headers: { "content-type": "audio/mpeg", "content-length": "4" } }));
    const provider = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice-123",
      modelId: "eleven_turbo_v2_5",
      voiceSettings: { stability: 0.4, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
      fetch,
      timeoutMs: 1000,
      maxBytes: 16,
    });

    const result = await provider.generate({ script: "  Hello\nworld  ", format: "mp3" });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-123");
    expect(request.method).toBe("POST");
    expect(request.headers["xi-api-key"]).toBe(TEST_API_KEY);
    expect(JSON.parse(request.body)).toMatchObject({
      text: "Hello world",
      model_id: "eleven_turbo_v2_5",
      voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
    });
    expect(result).toMatchObject({
      provider: "elevenlabs",
      voiceId: "voice-123",
      modelId: "eleven_turbo_v2_5",
      contentType: "audio/mpeg",
      bytesLength: 4,
      normalizedScript: "Hello world",
    });
    expect(result.sha256).toHaveLength(64);
    expect([...result.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("fails closed without making a provider call when credentials or script are invalid", async () => {
    expect(() =>
      createElevenLabsVoiceoverProvider({ apiKey: EMPTY_API_KEY, voiceId: "voice", modelId: "model", fetch: vi.fn() }),
    ).toThrow(VoiceoverConfigurationError);

    const fetch = vi.fn();
    const provider = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      fetch,
    });
    await expect(provider.generate({ script: " " })).rejects.toBeInstanceOf(VoiceoverProviderError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats ambiguous provider failures as terminal and never retries duplicate TTS calls", async () => {
    const fetch = vi.fn(async () => response({ ok: false, status: 500, statusText: "Server Error" }));
    const provider = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      fetch,
    });

    await expect(provider.generate({ script: "Spend once only" })).rejects.toThrow(/terminal/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(provider.generate({ script: "Spend once only" })).rejects.not.toThrow(TEST_API_KEY);
  });

  it("rejects non-audio, oversized, or empty responses", async () => {
    const nonAudio = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      fetch: vi.fn(async () => response({ headers: { "content-type": "application/json" } })),
    });
    await expect(nonAudio.generate({ script: "hello" })).rejects.toBeInstanceOf(VoiceoverContentTypeError);

    const tooLarge = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      maxBytes: 3,
      fetch: vi.fn(async () => response({ headers: { "content-type": "audio/mpeg", "content-length": "4" } })),
    });
    await expect(tooLarge.generate({ script: "hello" })).rejects.toBeInstanceOf(VoiceoverSizeError);

    const empty = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      fetch: vi.fn(async () => response({ headers: { "content-type": "audio/mpeg" }, bytes: new Uint8Array() })),
    });
    await expect(empty.generate({ script: "hello" })).rejects.toBeInstanceOf(VoiceoverSizeError);
  });

  it("keeps timeout active while reading a stalled response body", async () => {
    const stalled = new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Intentionally never enqueue or close.
        },
      }),
      { headers: { "content-type": "audio/mpeg" } },
    );
    const provider = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      timeoutMs: 25,
      fetch: vi.fn(async () => stalled),
    });

    const outcome = await Promise.race([
      provider.generate({ script: "hello" }).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 150)),
    ]);

    expect(outcome).toBeInstanceOf(VoiceoverTimeoutError);
  });

  it("cancels chunked/no-length bodies as soon as the byte cap is crossed", async () => {
    let chunksRead = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(new Uint8Array([chunksRead, chunksRead]));
        if (chunksRead >= 4) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      maxBytes: 3,
      fetch: vi.fn(async () => new Response(stream, { headers: { "content-type": "audio/mpeg" } })),
    });

    await expect(provider.generate({ script: "hello" })).rejects.toBeInstanceOf(VoiceoverSizeError);
    expect(chunksRead).toBeLessThan(4);
    expect(cancelled).toBe(true);
  });

  it("does not leak configured credentials through message, cause graph, or inspection when fetch throws", async () => {
    const provider = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      fetch: vi.fn(async () => {
        throw new Error(`transport failed with ${TEST_API_KEY}`);
      }),
    });

    let error: Error & { cause?: unknown };
    try {
      await provider.generate({ script: "hello" });
      throw new Error("Expected ElevenLabs fetch failure");
    } catch (err) {
      error = err as Error & { cause?: unknown };
    }

    expect(error).toBeInstanceOf(VoiceoverProviderError);
    expect(error.message).not.toContain(TEST_API_KEY);
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(TEST_API_KEY);
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(TEST_API_KEY);
  });

  it("fails closed when a successful audio response has no stream body without using arrayBuffer", async () => {
    const arrayBuffer = vi.fn(async () => {
      throw new Error("arrayBuffer must not be used for ElevenLabs audio");
    });
    const provider = createElevenLabsVoiceoverProvider({
      apiKey: TEST_API_KEY,
      voiceId: "voice",
      modelId: "model",
      fetch: vi.fn(async () => response({ body: null, arrayBuffer })),
    });

    await expect(provider.generate({ script: "hello" })).rejects.toBeInstanceOf(VoiceoverSizeError);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("cleans up per-read abort listeners across many chunked reads", async () => {
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 75) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(new Uint8Array([produced]));
      },
    });
    const listenerBalance = new Map<EventListenerOrEventListenerObject, number>();
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener").mockImplementation(function (this: AbortSignal, type, listener, options) {
      if (type === "abort" && listener) listenerBalance.set(listener, (listenerBalance.get(listener) ?? 0) + 1);
      return EventTarget.prototype.addEventListener.call(this, type, listener, options);
    });
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener").mockImplementation(function (this: AbortSignal, type, listener, options) {
      if (type === "abort" && listener) listenerBalance.set(listener, (listenerBalance.get(listener) ?? 0) - 1);
      return EventTarget.prototype.removeEventListener.call(this, type, listener, options);
    });
    try {
      const provider = createElevenLabsVoiceoverProvider({
        apiKey: TEST_API_KEY,
        voiceId: "voice",
        modelId: "model",
        maxBytes: 1000,
        fetch: vi.fn(async () => response({ body: stream })),
      });

      const result = await provider.generate({ script: "hello" });

      expect(result.bytesLength).toBe(75);
      expect([...listenerBalance.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
      expect(add).toHaveBeenCalled();
      expect(remove).toHaveBeenCalled();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it("rejects non-positive timeout and byte limits during configuration", () => {
    expect(() => createElevenLabsVoiceoverProvider({ apiKey: TEST_API_KEY, voiceId: "voice", modelId: "model", timeoutMs: 0 })).toThrow(
      VoiceoverConfigurationError,
    );
    expect(() => createElevenLabsVoiceoverProvider({ apiKey: TEST_API_KEY, voiceId: "voice", modelId: "model", maxBytes: 0 })).toThrow(
      VoiceoverConfigurationError,
    );
  });
});
