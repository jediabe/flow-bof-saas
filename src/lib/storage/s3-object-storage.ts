import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { MANAGED_CONTENT_STORAGE_PREFIX } from "@/lib/content-runs/constants";
import {
  ObjectStorageConfigurationError,
  ObjectStorageError,
  type ObjectStorage,
  type PutManagedObjectInput,
  type ReadObjectResult,
  type SignedReadUrlOptions,
  type StoredObjectMetadata,
} from "./object-storage";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;
const SAFE_KEY_COMPONENT = /^[A-Za-z0-9_-]+$/;
const SAFE_EXTENSION = /^[A-Za-z0-9]+$/;

export interface S3ObjectStorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  forcePathStyle?: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}

type Signer = typeof getSignedUrl;

interface S3ObjectStorageDependencies {
  client?: S3Client;
  sign?: Signer;
}

function assertSafeComponent(label: string, value: string): void {
  if (!SAFE_KEY_COMPONENT.test(value)) {
    throw new ObjectStorageError(
      "INVALID_STORAGE_KEY_COMPONENT",
      `${label} contains characters that are unsafe for managed object keys`,
    );
  }
}

function buildManagedObjectKey(input: PutManagedObjectInput): string {
  assertSafeComponent("workspaceId", input.workspaceId);
  assertSafeComponent("contentRunId", input.contentRunId);
  assertSafeComponent("assetId", input.assetId);

  const extension = input.extension.replace(/^\./, "").toLowerCase();
  if (!SAFE_EXTENSION.test(extension)) {
    throw new ObjectStorageError(
      "INVALID_STORAGE_KEY_COMPONENT",
      "extension contains characters that are unsafe for managed object keys",
    );
  }

  const directory =
    input.mediaType === "image"
      ? "images"
      : input.mediaType === "video"
        ? "videos"
        : input.mediaType === "audio"
          ? "audio"
          : "final";
  return [
    MANAGED_CONTENT_STORAGE_PREFIX,
    input.workspaceId,
    input.contentRunId,
    directory,
    `${input.assetId}.${extension}`,
  ].join("/");
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ObjectStorageError(
    "OBJECT_STORAGE_CONFIGURATION_ERROR",
    "S3_FORCE_PATH_STYLE must be either true or false",
  );
}

export class S3ObjectStorage implements ObjectStorage {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly sign: Signer;

  constructor(
    config: S3ObjectStorageConfig,
    dependencies: S3ObjectStorageDependencies = {},
  ) {
    this.bucket = config.bucket;
    const clientConfig: S3ClientConfig = {
      region: config.region,
      credentials: config.credentials,
      forcePathStyle: config.forcePathStyle ?? false,
    };
    if (config.endpoint) clientConfig.endpoint = config.endpoint;
    this.client = dependencies.client ?? new S3Client(clientConfig);
    this.sign = dependencies.sign ?? getSignedUrl;
  }

  async put(input: PutManagedObjectInput): Promise<StoredObjectMetadata> {
    const key = buildManagedObjectKey(input);
    const bytes = input.body.byteLength;
    const sha256 = createHash("sha256").update(input.body).digest("hex");

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: bytes,
        Metadata: {
          sha256,
          "workspace-id": input.workspaceId,
          "content-run-id": input.contentRunId,
          "asset-id": input.assetId,
          source: "managed-generation",
        },
      }),
    );

    return {
      bucket: this.bucket,
      key,
      contentType: input.contentType,
      bytes,
      sha256,
    };
  }

  async get(key: string): Promise<ReadObjectResult> {
    const output = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!output.Body) {
      throw new ObjectStorageError(
        "OBJECT_STORAGE_EMPTY_BODY",
        "Object storage returned a response without a body",
      );
    }

    const body = await output.Body.transformToByteArray();
    return {
      body,
      contentType: output.ContentType,
      bytes: body.byteLength,
      metadata: output.Metadata ?? {},
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async createSignedReadUrl(
    key: string,
    options: SignedReadUrlOptions = {},
  ): Promise<string> {
    const expiresIn = options.expiresIn ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_SIGNED_URL_TTL_SECONDS) {
      throw new ObjectStorageError(
        "INVALID_SIGNED_URL_EXPIRY",
        `Signed URL expiry must be an integer from 1 to ${MAX_SIGNED_URL_TTL_SECONDS} seconds`,
      );
    }

    return this.sign(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }
}

export function createObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): S3ObjectStorage {
  const required = {
    S3_REGION: env.S3_REGION,
    S3_BUCKET: env.S3_BUCKET,
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  };
  const missingFields = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingFields.length > 0) {
    throw new ObjectStorageConfigurationError(missingFields);
  }

  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT || undefined,
    region: required.S3_REGION!,
    bucket: required.S3_BUCKET!,
    forcePathStyle: parseBoolean(env.S3_FORCE_PATH_STYLE),
    credentials: {
      accessKeyId: required.S3_ACCESS_KEY_ID!,
      secretAccessKey: required.S3_SECRET_ACCESS_KEY!,
      sessionToken: env.S3_SESSION_TOKEN || undefined,
    },
  });
}
