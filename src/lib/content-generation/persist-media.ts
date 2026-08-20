import { randomUUID } from "node:crypto";
import type { ObjectStorage, StoredObjectMetadata } from "@/lib/storage";

export interface MediaAssetCreateDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export interface MediaPersistenceTransaction {
  flowGeneratedImage: MediaAssetCreateDelegate;
  flowGeneratedVideo: MediaAssetCreateDelegate;
}

export interface MediaPersistenceDb {
  $transaction<T>(
    work: (tx: MediaPersistenceTransaction) => Promise<T>,
  ): Promise<T>;
}

interface CommonPersistMediaInput {
  assetId?: string;
  workspaceId: string;
  contentRunId: string;
  productId: string;
  sceneLabel: string;
  mediaGenerationId: string;
  providerUrl?: string;
  prompt?: string | null;
  notes?: string | null;
  attemptNumber?: number;
}

export interface PersistImageInput extends CommonPersistMediaInput {
  mediaType: "image";
}

export interface PersistVideoInput extends CommonPersistMediaInput {
  mediaType: "video";
  sourceImageId: string;
  imageMediaGenerationId: string;
  creativeDirectionJson?: string | null;
}

export type PersistGeneratedMediaInput = PersistImageInput | PersistVideoInput;

export interface PersistGeneratedMediaDependencies {
  objectStorage: ObjectStorage;
  db: MediaPersistenceDb;
  fetchMedia?: (url: string) => Promise<Response>;
  resolveMediaUrl?: (mediaGenerationId: string) => Promise<string>;
  createAssetId?: () => string;
}

export interface PersistedGeneratedMedia {
  mediaType: "image" | "video";
  asset: unknown;
  storage: StoredObjectMetadata;
  /** Transient provider provenance for the owning operation audit record. */
  provenance: {
    mediaGenerationId: string;
    providerUrl: string;
  };
}

export type MediaPersistenceStage =
  | "resolve"
  | "download"
  | "validation"
  | "storage"
  | "database";

export class GeneratedMediaPersistenceError extends Error {
  readonly code: string;
  readonly stage: MediaPersistenceStage;
  readonly cleanupAttempted: boolean;
  readonly cleanupSucceeded: boolean;

  constructor(input: {
    code: string;
    message: string;
    stage: MediaPersistenceStage;
    cause?: unknown;
    cleanupAttempted?: boolean;
    cleanupSucceeded?: boolean;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "GeneratedMediaPersistenceError";
    this.code = input.code;
    this.stage = input.stage;
    this.cleanupAttempted = input.cleanupAttempted ?? false;
    this.cleanupSucceeded = input.cleanupSucceeded ?? false;
  }
}

export const MAX_GENERATED_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_GENERATED_VIDEO_BYTES = 256 * 1024 * 1024;

const IMAGE_TYPES = {
  "image/png": { extension: "png", matches: isPng },
  "image/jpeg": { extension: "jpg", matches: isJpeg },
  "image/webp": { extension: "webp", matches: isWebp },
  "image/gif": { extension: "gif", matches: isGif },
} as const;

const VIDEO_TYPES = {
  "video/mp4": { extension: "mp4", matches: isIsoBaseMedia },
  "video/quicktime": { extension: "mov", matches: isIsoBaseMedia },
  "video/webm": { extension: "webm", matches: isWebm },
} as const;

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
}

function isGif(bytes: Uint8Array): boolean {
  const header = ascii(bytes, 0, 6);
  return header === "GIF87a" || header === "GIF89a";
}

function isIsoBaseMedia(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && ascii(bytes, 4, 8) === "ftyp";
}

function isWebm(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function normalizeContentType(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function getMaximumBytes(mediaType: "image" | "video"): number {
  return mediaType === "image"
    ? MAX_GENERATED_IMAGE_BYTES
    : MAX_GENERATED_VIDEO_BYTES;
}

function assertContentLengthWithinLimit(
  response: Response,
  mediaType: "image" | "video",
): void {
  const rawContentLength = response.headers.get("content-length");
  if (rawContentLength === null) {
    return;
  }

  const contentLength = Number(rawContentLength);
  if (
    Number.isFinite(contentLength) &&
    contentLength > getMaximumBytes(mediaType)
  ) {
    throw new GeneratedMediaPersistenceError({
      code: "MEDIA_DOWNLOAD_TOO_LARGE",
      message: `Provider ${mediaType} exceeds the managed download size limit`,
      stage: "download",
    });
  }
}

function validateMedia(
  mediaType: "image" | "video",
  contentType: string,
  bytes: Uint8Array,
): { extension: string; matches(bytes: Uint8Array): boolean } {
  const descriptors: Record<
    string,
    { extension: string; matches(bytes: Uint8Array): boolean }
  > = mediaType === "image" ? IMAGE_TYPES : VIDEO_TYPES;
  const descriptor = descriptors[contentType];
  if (!descriptor || !descriptor.matches(bytes)) {
    throw new GeneratedMediaPersistenceError({
      code: "MEDIA_TYPE_INVALID",
      message: `Provider response is not a supported ${mediaType}`,
      stage: "validation",
    });
  }
  return descriptor;
}

async function resolveProviderUrl(
  input: PersistGeneratedMediaInput,
  dependencies: PersistGeneratedMediaDependencies,
): Promise<string> {
  if (input.providerUrl) {
    return input.providerUrl;
  }

  try {
    const providerUrl = await dependencies.resolveMediaUrl?.(
      input.mediaGenerationId,
    );
    if (providerUrl) {
      return providerUrl;
    }
  } catch (cause) {
    throw new GeneratedMediaPersistenceError({
      code: "MEDIA_URL_RESOLUTION_FAILED",
      message: "Provider media URL resolution failed",
      stage: "resolve",
      cause,
    });
  }

  throw new GeneratedMediaPersistenceError({
    code: "MEDIA_URL_RESOLUTION_FAILED",
    message: "A provider URL or media URL resolver is required",
    stage: "resolve",
  });
}

async function downloadProviderMedia(
  providerUrl: string,
  dependencies: PersistGeneratedMediaDependencies,
): Promise<Response> {
  let response: Response;
  try {
    response = await (dependencies.fetchMedia ?? fetch)(providerUrl);
  } catch (cause) {
    throw new GeneratedMediaPersistenceError({
      code: "MEDIA_DOWNLOAD_FAILED",
      message: "Provider media download failed",
      stage: "download",
      cause,
    });
  }

  if (!response.ok) {
    throw new GeneratedMediaPersistenceError({
      code: "MEDIA_DOWNLOAD_FAILED",
      message: `Provider media download failed with HTTP ${response.status}`,
      stage: "download",
    });
  }
  return response;
}

export async function persistGeneratedMedia(
  input: PersistGeneratedMediaInput,
  dependencies: PersistGeneratedMediaDependencies,
): Promise<PersistedGeneratedMedia> {
  const assetId = input.assetId ?? dependencies.createAssetId?.() ?? randomUUID();
  const providerUrl = await resolveProviderUrl(input, dependencies);
  const response = await downloadProviderMedia(providerUrl, dependencies);
  assertContentLengthWithinLimit(response, input.mediaType);
  const contentType = normalizeContentType(response);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > getMaximumBytes(input.mediaType)) {
    throw new GeneratedMediaPersistenceError({
      code: "MEDIA_DOWNLOAD_TOO_LARGE",
      message: `Provider ${input.mediaType} exceeds the managed download size limit`,
      stage: "download",
    });
  }
  const descriptor = validateMedia(input.mediaType, contentType, body);
  let storage: StoredObjectMetadata;
  try {
    storage = await dependencies.objectStorage.put({
      workspaceId: input.workspaceId,
      contentRunId: input.contentRunId,
      assetId,
      mediaType: input.mediaType,
      extension: descriptor.extension,
      contentType,
      body,
    });
  } catch (cause) {
    throw new GeneratedMediaPersistenceError({
      code: "OBJECT_UPLOAD_FAILED",
      message: "Generated media could not be uploaded to managed object storage",
      stage: "storage",
      cause,
    });
  }

  const commonData = {
    id: assetId,
    productId: input.productId,
    contentRunId: input.contentRunId,
    sceneLabel: input.sceneLabel,
    mediaGenerationId: input.mediaGenerationId,
    prompt: input.prompt ?? null,
    notes: input.notes ?? null,
    attemptNumber: input.attemptNumber ?? 1,
    storageBucket: storage.bucket,
    storageKey: storage.key,
    storageContentType: storage.contentType,
    storageBytes: storage.bytes,
    storageSha256: storage.sha256,
  };
  let asset: unknown;
  try {
    asset = await dependencies.db.$transaction((tx) =>
      input.mediaType === "image"
        ? tx.flowGeneratedImage.create({ data: commonData })
        : tx.flowGeneratedVideo.create({
            data: {
              ...commonData,
              sourceImageId: input.sourceImageId,
              imageMediaGenerationId: input.imageMediaGenerationId,
              creativeDirectionJson: input.creativeDirectionJson ?? null,
            },
          }),
    );
  } catch (cause) {
    let cleanupSucceeded = false;
    try {
      await dependencies.objectStorage.delete(storage.key);
      cleanupSucceeded = true;
    } catch {
      // Best-effort compensation: preserve the DB failure as the operation cause.
    }
    throw new GeneratedMediaPersistenceError({
      code: "DB_ASSET_PERSISTENCE_FAILED",
      message: "Generated media upload succeeded but asset persistence failed",
      stage: "database",
      cause,
      cleanupAttempted: true,
      cleanupSucceeded,
    });
  }

  return {
    mediaType: input.mediaType,
    asset,
    storage,
    provenance: {
      mediaGenerationId: input.mediaGenerationId,
      providerUrl,
    },
  };
}
