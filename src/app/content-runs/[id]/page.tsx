import Link from "next/link";
import { notFound } from "next/navigation";
import RunTimeline, { type OperationView } from "@/components/content-runs/RunTimeline";
import FinalOutputCard from "@/components/content-runs/FinalOutputCard";
import type {
  AssetAttemptView,
  AssetSlotView,
  AssetStorageView,
  QaHistoryEntry,
} from "@/components/content-runs/AssetSlotCard";
import { db } from "@/lib/db";
import { MANAGED_CONTENT_STORAGE_PREFIX } from "@/lib/content-runs/constants";
import { loadFinalOutputCard } from "@/lib/content-runs/final-output-card";
import { projectContentRun } from "@/lib/content-runs/project-run";
import {
  createObjectStorageFromEnv,
  type ObjectStorage,
} from "@/lib/storage";
import { getCurrentWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

interface PersistedQaAttempt {
  id: string;
  decision: string;
  overallScore: number;
  hasHardFailure: boolean;
  rubricVersion: string;
  providerModel: string;
  createdAt: Date;
}

interface PersistedAsset {
  id: string;
  contentRunId: string | null;
  sceneLabel: string;
  attemptNumber: number;
  qaStatus: string;
  qaScore: number | null;
  qaVerdictJson: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  storageContentType: string | null;
  storageBytes: number | null;
  storageSha256: string | null;
  qaAttempts: PersistedQaAttempt[];
}

function qaHistory(attempts: PersistedQaAttempt[]): QaHistoryEntry[] {
  return attempts.map((attempt) => ({
    id: attempt.id,
    decision: attempt.decision,
    score: attempt.overallScore,
    hasHardFailure: attempt.hasHardFailure,
    rubricVersion: attempt.rubricVersion,
    providerModel: attempt.providerModel,
    createdAt: attempt.createdAt.toISOString(),
  }));
}

function errorCode(errorJson: string | null): string | undefined {
  if (!errorJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(errorJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const code = (parsed as Record<string, unknown>).code;
      if (typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code)) return code;
    }
  } catch {
    // Provider payloads are deliberately not exposed by this page.
  }
  return "OPERATION_FAILED";
}

async function storageView(
  asset: PersistedAsset,
  objectStorage: ObjectStorage | null,
  scope: { workspaceId: string; contentRunId: string },
): Promise<AssetStorageView> {
  const bucket = asset.storageBucket;
  const key = asset.storageKey;
  const contentType = asset.storageContentType;
  const bytes = asset.storageBytes;
  const sha256 = asset.storageSha256;

  if (!bucket || !key || !contentType || bytes === null || !sha256) {
    return { state: "legacy" };
  }
  const expectedPrefix = `${MANAGED_CONTENT_STORAGE_PREFIX}/${scope.workspaceId}/${scope.contentRunId}/`;
  if (
    !objectStorage ||
    bucket !== objectStorage.bucket ||
    !key.startsWith(expectedPrefix)
  ) {
    return { state: "unavailable" };
  }

  try {
    const url = await objectStorage.createSignedReadUrl(key);
    return {
      state: "available",
      url,
      contentType,
      bytes,
      sha256,
    };
  } catch {
    return { state: "unavailable" };
  }
}

function objectStorageOrNull(): ObjectStorage | null {
  try {
    return createObjectStorageFromEnv();
  } catch {
    return null;
  }
}

export default async function ContentRunDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { workspace } = await getCurrentWorkspace();
  const run = await db.contentRun.findFirst({
    where: {
      id,
      product: { batch: { workspaceId: workspace.id } },
    },
    select: {
      id: true,
      productId: true,
      status: true,
      promptSnapshotJson: true,
      product: { select: { productName: true } },
      operations: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          contentRunId: true,
          kind: true,
          sceneLabel: true,
          status: true,
          providerJobId: true,
          errorJson: true,
          createdAt: true,
          completedAt: true,
        },
      },
      images: {
        where: { deletedAt: null },
        orderBy: [{ attemptNumber: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          contentRunId: true,
          sceneLabel: true,
          attemptNumber: true,
          qaStatus: true,
          qaScore: true,
          qaVerdictJson: true,
          storageBucket: true,
          storageKey: true,
          storageContentType: true,
          storageBytes: true,
          storageSha256: true,
          qaAttempts: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              decision: true,
              overallScore: true,
              hasHardFailure: true,
              rubricVersion: true,
              providerModel: true,
              createdAt: true,
            },
          },
        },
      },
      videos: {
        where: { deletedAt: null },
        orderBy: [{ attemptNumber: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          contentRunId: true,
          sceneLabel: true,
          attemptNumber: true,
          qaStatus: true,
          qaScore: true,
          qaVerdictJson: true,
          storageBucket: true,
          storageKey: true,
          storageContentType: true,
          storageBytes: true,
          storageSha256: true,
          qaAttempts: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              decision: true,
              overallScore: true,
              hasHardFailure: true,
              rubricVersion: true,
              providerModel: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });

  if (!run) notFound();

  const projection = projectContentRun({
    run: {
      id: run.id,
      productId: run.productId,
      status: run.status,
      promptSnapshotJson: run.promptSnapshotJson,
    },
    images: run.images,
    videos: run.videos,
    operations: run.operations,
  });

  const assets = new Map<string, PersistedAsset>();
  for (const asset of run.images) assets.set(asset.id, asset);
  for (const asset of run.videos) assets.set(asset.id, asset);
  const objectStorage = objectStorageOrNull();
  const finalOutput = await loadFinalOutputCard(
    { workspaceId: workspace.id, contentRunId: run.id },
    { prisma: db, storage: objectStorage },
  );

  const slots: AssetSlotView[] = await Promise.all(
    projection.slots.map(async (slot): Promise<AssetSlotView> => ({
      slot: slot.slot,
      assetType: slot.assetType,
      ...(slot.selectedAssetId ? { selectedAssetId: slot.selectedAssetId } : {}),
      attempts: await Promise.all(
        slot.attempts.map(async (attempt): Promise<AssetAttemptView> => {
          const asset = assets.get(attempt.assetId);
          if (!asset) {
            return {
              assetId: attempt.assetId,
              attempt: attempt.attempt,
              qaStatus: attempt.qaStatus,
              selected: attempt.selected,
              mediaType: slot.assetType.endsWith("IMAGE") ? "image" : "video",
              storage: { state: "unavailable" },
              qaHistory: [],
            };
          }
          return {
            assetId: attempt.assetId,
            attempt: attempt.attempt,
            qaStatus: attempt.qaStatus,
            selected: attempt.selected,
            mediaType: slot.assetType.endsWith("IMAGE") ? "image" : "video",
            storage: await storageView(asset, objectStorage, {
              workspaceId: workspace.id,
              contentRunId: run.id,
            }),
            qaHistory: qaHistory(asset.qaAttempts),
          };
        }),
      ),
    })),
  );

  const operations: OperationView[] = run.operations.map((operation) => ({
    id: operation.id,
    kind: operation.kind,
    sceneLabel: operation.sceneLabel,
    status: operation.status,
    createdAt: operation.createdAt.toISOString(),
    ...(operation.completedAt ? { completedAt: operation.completedAt.toISOString() } : {}),
    ...(errorCode(operation.errorJson) ? { errorCode: errorCode(operation.errorJson) } : {}),
  }));

  return (
    <div className="space-y-6">
      <header>
        <Link href="/dashboard" className="text-xs text-muted hover:text-text">
          ← Dashboard
        </Link>
        <h1 className="h-page mt-1">Content run timeline</h1>
        <p className="mt-2 text-sm text-muted">
          Authoritative, read-only state for {run.product.productName}.
        </p>
      </header>

      <FinalOutputCard view={finalOutput} />

      <RunTimeline
        projection={projection}
        productName={run.product.productName}
        slots={slots}
        operations={operations}
      />
    </div>
  );
}
