import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ObjectStorageConfigurationError,
  S3ObjectStorage,
  createObjectStorageFromEnv,
} from "@/lib/storage";

class FakeS3Client {
  readonly commands: object[] = [];
  getBody = new Uint8Array();

  async send(command: object): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof GetObjectCommand) {
      return {
        Body: {
          transformToByteArray: async () => this.getBody,
        },
        ContentType: "image/png",
        ContentLength: this.getBody.byteLength,
        Metadata: { source: "managed-generation" },
      };
    }
    return {};
  }
}

const config = {
  endpoint: "http://127.0.0.1:9000",
  region: "us-east-1",
  bucket: "managed-media",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  },
};

const originalEnv = process.env;

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

describe("S3ObjectStorage", () => {
  it("uploads private bytes under the frozen managed-content key and returns integrity metadata", async () => {
    const client = new FakeS3Client();
    const sign = vi.fn();
    const storage = new S3ObjectStorage(config, {
      client: client as unknown as S3Client,
      sign,
    });
    const body = new TextEncoder().encode("png fixture bytes");

    const stored = await storage.put({
      workspaceId: "workspace_1",
      contentRunId: "run_1",
      assetId: "asset_1",
      mediaType: "image",
      extension: "png",
      contentType: "image/png",
      body,
    });

    const expectedKey =
      "managed-content/workspace_1/run_1/images/asset_1.png";
    const expectedSha = createHash("sha256").update(body).digest("hex");
    expect(stored).toEqual({
      bucket: "managed-media",
      key: expectedKey,
      contentType: "image/png",
      bytes: body.byteLength,
      sha256: expectedSha,
    });
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(PutObjectCommand);
    expect((client.commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: "managed-media",
      Key: expectedKey,
      Body: body,
      ContentType: "image/png",
      ContentLength: body.byteLength,
      Metadata: {
        sha256: expectedSha,
        "workspace-id": "workspace_1",
        "content-run-id": "run_1",
        "asset-id": "asset_1",
        source: "managed-generation",
      },
    });
    expect((client.commands[0] as PutObjectCommand).input.ACL).toBeUndefined();
  });

  it("reads object bytes and normalized metadata", async () => {
    const client = new FakeS3Client();
    client.getBody = new TextEncoder().encode("stored bytes");
    const storage = new S3ObjectStorage(config, {
      client: client as unknown as S3Client,
      sign: vi.fn(),
    });

    const result = await storage.get(
      "managed-content/workspace_1/run_1/images/asset_1.png",
    );

    expect(result).toEqual({
      body: client.getBody,
      contentType: "image/png",
      bytes: client.getBody.byteLength,
      metadata: { source: "managed-generation" },
    });
    expect(client.commands[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("deletes the requested private object", async () => {
    const client = new FakeS3Client();
    const storage = new S3ObjectStorage(config, {
      client: client as unknown as S3Client,
      sign: vi.fn(),
    });
    const key = "managed-content/workspace_1/run_1/videos/asset_2.mp4";

    await storage.delete(key);

    expect(client.commands[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((client.commands[0] as DeleteObjectCommand).input).toEqual({
      Bucket: "managed-media",
      Key: key,
    });
  });

  it("signs a short-lived GetObject request", async () => {
    const client = new FakeS3Client();
    const sign = vi.fn().mockResolvedValue("https://signed.example/object");
    const storage = new S3ObjectStorage(config, {
      client: client as unknown as S3Client,
      sign,
    });
    const key = "managed-content/workspace_1/run_1/videos/asset_2.mp4";

    const url = await storage.createSignedReadUrl(key, { expiresIn: 120 });

    expect(url).toBe("https://signed.example/object");
    expect(sign).toHaveBeenCalledOnce();
    const [signedClient, command, options] = sign.mock.calls[0];
    expect(signedClient).toBe(client);
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toEqual({
      Bucket: "managed-media",
      Key: key,
    });
    expect(options).toEqual({ expiresIn: 120 });
  });

  it("rejects unsafe key components before sending a request", async () => {
    const client = new FakeS3Client();
    const storage = new S3ObjectStorage(config, {
      client: client as unknown as S3Client,
      sign: vi.fn(),
    });

    await expect(
      storage.put({
        workspaceId: "../other-workspace",
        contentRunId: "run_1",
        assetId: "asset_1",
        mediaType: "video",
        extension: "mp4",
        contentType: "video/mp4",
        body: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY_COMPONENT" });
    expect(client.commands).toHaveLength(0);
  });
});

describe.skipIf(process.env.RUN_MINIO_SMOKE !== "true")(
  "MinIO object-storage smoke",
  () => {
    it("uploads, privately reads, hashes, and deletes image and video fixtures", async () => {
      const storage = new S3ObjectStorage({
        endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
        region: process.env.S3_REGION ?? "us-east-1",
        bucket: process.env.S3_BUCKET ?? "managed-media",
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
        },
      });
      const fixtures = [
        {
          assetId: "smoke_image",
          mediaType: "image" as const,
          extension: "png",
          contentType: "image/png",
          body: Uint8Array.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
          ]),
        },
        {
          assetId: "smoke_video",
          mediaType: "video" as const,
          extension: "mp4",
          contentType: "video/mp4",
          body: Uint8Array.from([
            0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f,
            0x6d, 1, 2, 3,
          ]),
        },
      ];

      for (const fixture of fixtures) {
        const stored = await storage.put({
          workspaceId: "smoke_workspace",
          contentRunId: "smoke_run",
          ...fixture,
        });
        expect(stored.sha256).toBe(
          createHash("sha256").update(fixture.body).digest("hex"),
        );
        expect(stored.bytes).toBe(fixture.body.byteLength);

        const anonymousUrl = `${process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000"}/${storage.bucket}/${stored.key}`;
        const anonymousResponse = await fetch(anonymousUrl);
        expect(anonymousResponse.status).toBe(403);

        const read = await storage.get(stored.key);
        expect(read.body).toEqual(fixture.body);
        expect(read.contentType).toBe(fixture.contentType);
        await storage.delete(stored.key);
        await expect(storage.get(stored.key)).rejects.toMatchObject({
          name: "NoSuchKey",
        });
      }
    });
  },
);

describe("createObjectStorageFromEnv", () => {
  it("fails with a typed error when required bucket or credentials are missing without logging secrets", () => {
    process.env = {
      ...originalEnv,
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "",
      S3_ACCESS_KEY_ID: "visible-access-key",
      S3_SECRET_ACCESS_KEY: "super-secret-value",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    let thrown: unknown;
    try {
      createObjectStorageFromEnv();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ObjectStorageConfigurationError);
    expect(thrown).toMatchObject({
      code: "OBJECT_STORAGE_CONFIGURATION_ERROR",
      missingFields: ["S3_BUCKET"],
    });
    expect(String(thrown)).not.toContain("super-secret-value");
    expect(String(thrown)).not.toContain("visible-access-key");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("creates a service from complete S3-compatible configuration", () => {
    process.env = {
      ...originalEnv,
      S3_ENDPOINT: "http://minio:9000",
      S3_REGION: "us-east-1",
      S3_BUCKET: "managed-media",
      S3_ACCESS_KEY_ID: "minio-user",
      S3_SECRET_ACCESS_KEY: "minio-password",
      S3_FORCE_PATH_STYLE: "true",
    };

    const storage = createObjectStorageFromEnv();

    expect(storage).toBeInstanceOf(S3ObjectStorage);
    expect(storage.bucket).toBe("managed-media");
  });
});
