import type { PrismaClient } from "@prisma/client";
import { MANAGED_CONTENT_STORAGE_PREFIX } from "./constants";
import type { ObjectStorage } from "@/lib/storage";

interface FinalOutputScope {
  workspaceId: string;
  contentRunId: string;
}

interface FinalOutputCardDependencies {
  prisma: Pick<PrismaClient, "finalVideoAsset">;
  storage: Pick<ObjectStorage, "bucket" | "createSignedReadUrl"> | null;
}

interface FinalOutputCardBase {
  id: string;
  status: string;
  qaStatus: string;
  qaScore: number | null;
}

export type FinalOutputCardView =
  | { state: "none" }
  | (FinalOutputCardBase & { state: "legacy" })
  | (FinalOutputCardBase & { state: "unavailable"; bytes: number; sha256: string })
  | (FinalOutputCardBase & {
      state: "available";
      bytes: number;
      sha256: string;
      url: string;
    });

export async function loadFinalOutputCard(
  scope: FinalOutputScope,
  dependencies: FinalOutputCardDependencies,
): Promise<FinalOutputCardView> {
  const asset = await dependencies.prisma.finalVideoAsset.findFirst({
    where: {
      contentRunId: scope.contentRunId,
      contentRun: { product: { batch: { workspaceId: scope.workspaceId } } },
    },
    select: {
      id: true,
      status: true,
      finalQaStatus: true,
      finalQaScore: true,
      mediaValidationPassed: true,
      finalStorageBucket: true,
      finalStorageKey: true,
      finalContentType: true,
      finalBytes: true,
      finalSha256: true,
    },
  });
  if (!asset) return { state: "none" };

  const base: FinalOutputCardBase = {
    id: asset.id,
    status: asset.status,
    qaStatus: asset.finalQaStatus,
    qaScore: asset.finalQaScore,
  };
  const bucket = asset.finalStorageBucket;
  const key = asset.finalStorageKey;
  const contentType = asset.finalContentType;
  const bytes = asset.finalBytes;
  const sha256 = asset.finalSha256;
  if (!bucket || !key || !contentType || bytes === null || !sha256) {
    return { state: "legacy", ...base };
  }

  const expectedKey = `${MANAGED_CONTENT_STORAGE_PREFIX}/${scope.workspaceId}/${scope.contentRunId}/final/${asset.id}.mp4`;
  const validFence =
    asset.status === "APPROVED" &&
    asset.finalQaStatus === "APPROVED" &&
    asset.mediaValidationPassed === true &&
    dependencies.storage !== null &&
    bucket === dependencies.storage.bucket &&
    key === expectedKey &&
    contentType === "video/mp4" &&
    Number.isInteger(bytes) &&
    bytes > 0 &&
    /^[a-f0-9]{64}$/.test(sha256);
  if (!validFence) {
    return { state: "unavailable", ...base, bytes, sha256 };
  }

  try {
    const url = await dependencies.storage!.createSignedReadUrl(key);
    return { state: "available", ...base, bytes, sha256, url };
  } catch {
    return { state: "unavailable", ...base, bytes, sha256 };
  }
}
