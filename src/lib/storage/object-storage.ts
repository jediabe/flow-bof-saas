export type ManagedMediaType = "image" | "video" | "audio" | "final_video";

export interface PutManagedObjectInput {
  workspaceId: string;
  contentRunId: string;
  assetId: string;
  mediaType: ManagedMediaType;
  extension: string;
  contentType: string;
  body: Uint8Array;
}

export interface StoredObjectMetadata {
  bucket: string;
  key: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface ReadObjectResult {
  body: Uint8Array;
  contentType: string | undefined;
  bytes: number;
  metadata: Record<string, string>;
}

export interface SignedReadUrlOptions {
  expiresIn?: number;
}

export interface ObjectStorage {
  readonly bucket: string;
  put(input: PutManagedObjectInput): Promise<StoredObjectMetadata>;
  get(key: string): Promise<ReadObjectResult>;
  delete(key: string): Promise<void>;
  createSignedReadUrl(
    key: string,
    options?: SignedReadUrlOptions,
  ): Promise<string>;
}

export class ObjectStorageError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObjectStorageError";
    this.code = code;
  }
}

export class ObjectStorageConfigurationError extends ObjectStorageError {
  readonly missingFields: readonly string[];

  constructor(missingFields: readonly string[]) {
    super(
      "OBJECT_STORAGE_CONFIGURATION_ERROR",
      `Object storage configuration is incomplete; missing: ${missingFields.join(", ")}`,
    );
    this.name = "ObjectStorageConfigurationError";
    this.missingFields = [...missingFields];
  }
}
