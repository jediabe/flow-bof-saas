import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  ObjectStorage,
  PutManagedObjectInput,
  StoredObjectMetadata,
} from "@/lib/storage";
import {
  GeneratedMediaPersistenceError,
  MAX_GENERATED_IMAGE_BYTES,
  persistGeneratedMedia,
  type MediaPersistenceDb,
  type MediaPersistenceTransaction,
} from "../persist-media";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);
const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00,
]);

function createStorage() {
  const put = vi.fn(async (input: PutManagedObjectInput): Promise<StoredObjectMetadata> => ({
    bucket: "managed-media",
    key: `managed-content/${input.workspaceId}/${input.contentRunId}/${input.mediaType}s/${input.assetId}.${input.extension}`,
    contentType: input.contentType,
    bytes: input.body.byteLength,
    sha256: createHash("sha256").update(input.body).digest("hex"),
  }));
  return {
    bucket: "managed-media",
    put,
    get: vi.fn(),
    delete: vi.fn(),
    createSignedReadUrl: vi.fn(),
  } as unknown as ObjectStorage & { put: typeof put; delete: ReturnType<typeof vi.fn> };
}

function createDb() {
  const tx: MediaPersistenceTransaction = {
    flowGeneratedImage: { create: vi.fn(async ({ data }) => ({ id: data.id, ...data })) },
    flowGeneratedVideo: { create: vi.fn(async ({ data }) => ({ id: data.id, ...data })) },
  };
  const db: MediaPersistenceDb = {
    $transaction: vi.fn(async (work) => work(tx)),
  };
  return { db, tx };
}

describe("persistGeneratedMedia", () => {
  expectTypeOf<PrismaClient>().toMatchTypeOf<MediaPersistenceDb>();

  let storage: ReturnType<typeof createStorage>;
  let database: ReturnType<typeof createDb>;

  beforeEach(() => {
    storage = createStorage();
    database = createDb();
  });

  it("downloads and persists an image under its exact managed-content key", async () => {
    const upstreamUrl = "https://useapi.example/signed/image?expires=soon";
    const fetchMedia = vi.fn(async () =>
      new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
    );

    const result = await persistGeneratedMedia(
      {
        mediaType: "image",
        assetId: "image_asset_1",
        workspaceId: "workspace_1",
        contentRunId: "run_1",
        productId: "product_1",
        sceneLabel: "scene_1_store_image",
        mediaGenerationId: "flow_image_1",
        providerUrl: upstreamUrl,
        prompt: "frozen image prompt",
      },
      { objectStorage: storage, db: database.db, fetchMedia },
    );

    const expectedKey =
      "managed-content/workspace_1/run_1/images/image_asset_1.png";
    const expectedSha = createHash("sha256").update(PNG_BYTES).digest("hex");
    expect(fetchMedia).toHaveBeenCalledWith(upstreamUrl);
    expect(storage.put).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      contentRunId: "run_1",
      assetId: "image_asset_1",
      mediaType: "image",
      extension: "png",
      contentType: "image/png",
      body: PNG_BYTES,
    });
    expect(database.tx.flowGeneratedImage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "image_asset_1",
        productId: "product_1",
        contentRunId: "run_1",
        sceneLabel: "scene_1_store_image",
        mediaGenerationId: "flow_image_1",
        prompt: "frozen image prompt",
        storageBucket: "managed-media",
        storageKey: expectedKey,
        storageContentType: "image/png",
        storageBytes: PNG_BYTES.byteLength,
        storageSha256: expectedSha,
      }),
    });
    const persistedData = vi.mocked(database.tx.flowGeneratedImage.create).mock
      .calls[0][0].data;
    expect(persistedData).not.toHaveProperty("providerUrl");
    expect(persistedData).not.toHaveProperty("url");
    expect(persistedData.storageKey).not.toContain("useapi.example");
    expect(result).toMatchObject({
      mediaType: "image",
      asset: { id: "image_asset_1", contentRunId: "run_1" },
      storage: { key: expectedKey, sha256: expectedSha },
      provenance: {
        mediaGenerationId: "flow_image_1",
        providerUrl: upstreamUrl,
      },
    });
  });

  it("resolves a video by Flow media ID and persists source-image provenance", async () => {
    const upstreamUrl = "https://useapi.example/signed/video?expires=soon";
    const resolveMediaUrl = vi.fn(async () => upstreamUrl);
    const fetchMedia = vi.fn(async () =>
      new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } }),
    );

    const result = await persistGeneratedMedia(
      {
        mediaType: "video",
        assetId: "video_asset_1",
        workspaceId: "workspace_1",
        contentRunId: "run_1",
        productId: "product_1",
        sceneLabel: "scene_1_store",
        mediaGenerationId: "flow_video_1",
        sourceImageId: "image_asset_1",
        imageMediaGenerationId: "flow_image_1",
        prompt: "compiled video prompt",
        creativeDirectionJson: '{"cameraMovement":"minimal_push_in"}',
      },
      {
        objectStorage: storage,
        db: database.db,
        fetchMedia,
        resolveMediaUrl,
      },
    );

    const expectedKey =
      "managed-content/workspace_1/run_1/videos/video_asset_1.mp4";
    const expectedSha = createHash("sha256").update(MP4_BYTES).digest("hex");
    expect(resolveMediaUrl).toHaveBeenCalledWith("flow_video_1");
    expect(fetchMedia).toHaveBeenCalledWith(upstreamUrl);
    expect(storage.put).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace_1",
      contentRunId: "run_1",
      assetId: "video_asset_1",
      mediaType: "video",
      extension: "mp4",
      contentType: "video/mp4",
      body: MP4_BYTES,
    }));
    expect(database.tx.flowGeneratedVideo.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "video_asset_1",
        contentRunId: "run_1",
        mediaGenerationId: "flow_video_1",
        sourceImageId: "image_asset_1",
        imageMediaGenerationId: "flow_image_1",
        prompt: "compiled video prompt",
        creativeDirectionJson: '{"cameraMovement":"minimal_push_in"}',
        storageBucket: "managed-media",
        storageKey: expectedKey,
        storageContentType: "video/mp4",
        storageBytes: MP4_BYTES.byteLength,
        storageSha256: expectedSha,
      }),
    });
    expect(result).toMatchObject({
      mediaType: "video",
      asset: {
        id: "video_asset_1",
        contentRunId: "run_1",
        sourceImageId: "image_asset_1",
      },
      storage: { key: expectedKey, contentType: "video/mp4" },
    });
  });

  it("fails with a resolvable operation error when no provider URL can be obtained", async () => {
    await expect(
      persistGeneratedMedia(
        {
          mediaType: "image",
          assetId: "missing_provider_url",
          workspaceId: "workspace_1",
          contentRunId: "run_1",
          productId: "product_1",
          sceneLabel: "scene_1_store_image",
          mediaGenerationId: "flow_missing_url",
        },
        { objectStorage: storage, db: database.db },
      ),
    ).rejects.toMatchObject({
      code: "MEDIA_URL_RESOLUTION_FAILED",
      stage: "resolve",
    });
    expect(storage.put).not.toHaveBeenCalled();
    expect(database.db.$transaction).not.toHaveBeenCalled();
  });

  it("fails with a download-stage operation error for an upstream HTTP failure", async () => {
    await expect(
      persistGeneratedMedia(
        {
          mediaType: "image",
          assetId: "failed_download",
          workspaceId: "workspace_1",
          contentRunId: "run_1",
          productId: "product_1",
          sceneLabel: "scene_1_store_image",
          mediaGenerationId: "flow_failed_download",
          providerUrl: "https://useapi.example/signed/failed",
        },
        {
          objectStorage: storage,
          db: database.db,
          fetchMedia: vi.fn(async () => new Response(null, { status: 502 })),
        },
      ),
    ).rejects.toMatchObject({
      code: "MEDIA_DOWNLOAD_FAILED",
      stage: "download",
    });
    expect(storage.put).not.toHaveBeenCalled();
    expect(database.db.$transaction).not.toHaveBeenCalled();
  });

  it("does not create an asset row when object upload fails", async () => {
    const storageFailure = new Error("storage unavailable");
    storage.put.mockRejectedValueOnce(storageFailure);

    await expect(
      persistGeneratedMedia(
        {
          mediaType: "image",
          assetId: "image_asset_failed",
          workspaceId: "workspace_1",
          contentRunId: "run_1",
          productId: "product_1",
          sceneLabel: "scene_2_home_image",
          mediaGenerationId: "flow_image_failed",
          providerUrl: "https://useapi.example/signed/image",
        },
        {
          objectStorage: storage,
          db: database.db,
          fetchMedia: vi.fn(async () =>
            new Response(PNG_BYTES, {
              headers: { "content-type": "image/png" },
            }),
          ),
        },
      ),
    ).rejects.toMatchObject({
      code: "OBJECT_UPLOAD_FAILED",
      stage: "storage",
      cause: storageFailure,
    });

    expect(database.db.$transaction).not.toHaveBeenCalled();
    expect(database.tx.flowGeneratedImage.create).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("deletes the uploaded object and fails the operation when the DB transaction fails", async () => {
    const dbFailure = new Error("database write rejected");
    vi.mocked(database.db.$transaction).mockRejectedValueOnce(dbFailure);

    const operation = persistGeneratedMedia(
      {
        mediaType: "image",
        assetId: "image_asset_orphan",
        workspaceId: "workspace_1",
        contentRunId: "run_1",
        productId: "product_1",
        sceneLabel: "scene_2_home_image",
        mediaGenerationId: "flow_image_orphan",
        providerUrl: "https://useapi.example/signed/image",
      },
      {
        objectStorage: storage,
        db: database.db,
        fetchMedia: vi.fn(async () =>
          new Response(PNG_BYTES, {
            headers: { "content-type": "image/png" },
          }),
        ),
      },
    );

    await expect(operation).rejects.toMatchObject({
      name: "GeneratedMediaPersistenceError",
      code: "DB_ASSET_PERSISTENCE_FAILED",
      stage: "database",
      cleanupAttempted: true,
      cleanupSucceeded: true,
      cause: dbFailure,
    } satisfies Partial<GeneratedMediaPersistenceError>);
    expect(storage.delete).toHaveBeenCalledOnce();
    expect(storage.delete).toHaveBeenCalledWith(
      "managed-content/workspace_1/run_1/images/image_asset_orphan.png",
    );
  });

  it("preserves the DB failure when orphan deletion also fails", async () => {
    const dbFailure = new Error("database write rejected");
    vi.mocked(database.db.$transaction).mockRejectedValueOnce(dbFailure);
    storage.delete.mockRejectedValueOnce(new Error("delete unavailable"));

    await expect(
      persistGeneratedMedia(
        {
          mediaType: "image",
          assetId: "image_asset_orphan",
          workspaceId: "workspace_1",
          contentRunId: "run_1",
          productId: "product_1",
          sceneLabel: "scene_2_home_image",
          mediaGenerationId: "flow_image_orphan",
          providerUrl: "https://useapi.example/signed/image",
        },
        {
          objectStorage: storage,
          db: database.db,
          fetchMedia: vi.fn(async () =>
            new Response(PNG_BYTES, {
              headers: { "content-type": "image/png" },
            }),
          ),
        },
      ),
    ).rejects.toMatchObject({
      code: "DB_ASSET_PERSISTENCE_FAILED",
      cause: dbFailure,
      cleanupAttempted: true,
      cleanupSucceeded: false,
    });
    expect(storage.delete).toHaveBeenCalledOnce();
  });

  it("rejects an oversized provider response before buffering or storage", async () => {
    await expect(
      persistGeneratedMedia(
        {
          mediaType: "image",
          assetId: "oversized_image",
          workspaceId: "workspace_1",
          contentRunId: "run_1",
          productId: "product_1",
          sceneLabel: "scene_1_store_image",
          mediaGenerationId: "flow_oversized",
          providerUrl: "https://useapi.example/signed/oversized",
        },
        {
          objectStorage: storage,
          db: database.db,
          fetchMedia: vi.fn(async () =>
            new Response(PNG_BYTES, {
              headers: {
                "content-type": "image/png",
                "content-length": String(MAX_GENERATED_IMAGE_BYTES + 1),
              },
            }),
          ),
        },
      ),
    ).rejects.toMatchObject({
      code: "MEDIA_DOWNLOAD_TOO_LARGE",
      stage: "download",
    });
    expect(storage.put).not.toHaveBeenCalled();
    expect(database.db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "image header with video bytes",
      mediaType: "image" as const,
      contentType: "image/png",
      body: MP4_BYTES,
    },
    {
      label: "video header with image bytes",
      mediaType: "video" as const,
      contentType: "video/mp4",
      body: PNG_BYTES,
    },
  ])("rejects $label before storage or DB persistence", async (fixture) => {
    const common = {
      assetId: "invalid_asset",
      workspaceId: "workspace_1",
      contentRunId: "run_1",
      productId: "product_1",
      sceneLabel: "scene_1_store",
      mediaGenerationId: "flow_invalid",
      providerUrl: "https://useapi.example/signed/invalid",
    };
    const input = fixture.mediaType === "image"
      ? { ...common, mediaType: "image" as const }
      : {
          ...common,
          mediaType: "video" as const,
          sourceImageId: "image_asset_1",
          imageMediaGenerationId: "flow_image_1",
        };

    await expect(
      persistGeneratedMedia(input, {
        objectStorage: storage,
        db: database.db,
        fetchMedia: vi.fn(async () =>
          new Response(fixture.body, {
            headers: { "content-type": fixture.contentType },
          }),
        ),
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_TYPE_INVALID",
      stage: "validation",
      message: `Provider response is not a supported ${fixture.mediaType}`,
    });
    expect(storage.put).not.toHaveBeenCalled();
    expect(database.db.$transaction).not.toHaveBeenCalled();
  });
});
