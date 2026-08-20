import { createHash } from "node:crypto";

export type VoiceoverProviderName = "elevenlabs";
export type VoiceoverAudioFormat = "mp3" | "wav" | "m4a";

export interface GenerateVoiceoverInput {
  script: string;
  format?: VoiceoverAudioFormat;
}

export interface GenerateVoiceoverResult {
  provider: VoiceoverProviderName;
  voiceId: string;
  modelId: string;
  normalizedScript: string;
  bytes: Uint8Array;
  bytesLength: number;
  sha256: string;
  contentType: string;
}

export interface VoiceoverProvider {
  readonly provider: VoiceoverProviderName;
  generate(input: GenerateVoiceoverInput): Promise<GenerateVoiceoverResult>;
}

export type VoiceoverErrorCode =
  | "CONFIGURATION"
  | "VALIDATION"
  | "TIMEOUT"
  | "PROVIDER_TERMINAL"
  | "CONTENT_TYPE"
  | "SIZE";

export class VoiceoverProviderError extends Error {
  readonly code: VoiceoverErrorCode;
  readonly terminal: boolean;

  constructor(message: string, options: { code: VoiceoverErrorCode; terminal?: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.terminal = options.terminal ?? true;
  }
}

export class VoiceoverConfigurationError extends VoiceoverProviderError {
  constructor(message: string) {
    super(message, { code: "CONFIGURATION" });
  }
}

export class VoiceoverValidationError extends VoiceoverProviderError {
  constructor(message: string) {
    super(message, { code: "VALIDATION" });
  }
}

export class VoiceoverTimeoutError extends VoiceoverProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "TIMEOUT", cause });
  }
}

export class VoiceoverTerminalProviderError extends VoiceoverProviderError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "PROVIDER_TERMINAL", cause });
  }
}

export class VoiceoverContentTypeError extends VoiceoverProviderError {
  constructor(message: string) {
    super(message, { code: "CONTENT_TYPE" });
  }
}

export class VoiceoverSizeError extends VoiceoverProviderError {
  constructor(message: string) {
    super(message, { code: "SIZE" });
  }
}

export function normalizeVoiceoverScript(
  script: string,
  options: { maxCharacters?: number } = {},
): string {
  const maxCharacters = options.maxCharacters ?? 5000;
  const normalized = script.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    throw new VoiceoverValidationError("Voiceover script is empty after normalization.");
  }
  if (normalized.length > maxCharacters) {
    throw new VoiceoverValidationError(
      `Voiceover script has ${normalized.length} characters; maximum is ${maxCharacters}.`,
    );
  }
  return normalized;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
