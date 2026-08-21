import { StyleManifestSchema } from "@/lib/content-styles/schemas";
import { projectContentRun } from "@/lib/content-runs/project-run";
import type { ServiceActorContext } from "@/lib/content-runs/types";
import { db } from "@/lib/db";

export class HermesContentQueryError extends Error {
  readonly status = 404;

  constructor(readonly code: "PRODUCT_NOT_FOUND" | "CONTENT_RUN_NOT_FOUND" | "INVALID_FROZEN_RUN", message: string) {
    super(message);
    this.name = "HermesContentQueryError";
  }
}

export async function getApprovedProduct(actor: ServiceActorContext, productId: string) {
  const product = await db.product.findFirst({
    where: {
      id: productId,
      deletedAt: null,
      reviewStatus: "approved",
      batch: { workspaceId: actor.workspaceId },
    },
    select: {
      id: true,
      productName: true,
      category: true,
      market: true,
      batch: { select: { market: true } },
      images: { orderBy: [{ role: "asc" }, { createdAt: "asc" }], select: { id: true } },
    },
  });
  if (!product) {
    throw new HermesContentQueryError(
      "PRODUCT_NOT_FOUND",
      "Approved product was not found in the authenticated workspace.",
    );
  }
  const market = product.market?.trim() || product.batch.market?.trim();
  const category = product.category?.trim();
  if (!market || !category || product.images.length === 0) {
    throw new HermesContentQueryError(
      "PRODUCT_NOT_FOUND",
      "Approved product is missing managed-content context.",
    );
  }
  return {
    id: product.id,
    name: product.productName,
    reviewStatus: "approved" as const,
    market,
    category,
    referenceImageIds: product.images.map((image) => image.id),
  };
}

export async function getGenerationReplayOperation(
  actor: ServiceActorContext,
  contentRunId: string,
  operationId: string,
) {
  return db.contentOperation.findFirst({
    where: {
      id: operationId,
      workspaceId: actor.workspaceId,
      contentRunId,
      status: { in: ["requested", "running"] },
      contentRun: { product: { batch: { workspaceId: actor.workspaceId } } },
    },
    select: {
      id: true,
      workspaceId: true,
      contentRunId: true,
      kind: true,
      sceneLabel: true,
      status: true,
      idempotencyKey: true,
    },
  });
}

export async function getManagedRunView(actor: ServiceActorContext, contentRunId: string) {
  const run = await db.contentRun.findFirst({
    where: { id: contentRunId, product: { batch: { workspaceId: actor.workspaceId } } },
    include: {
      images: { where: { deletedAt: null } },
      videos: { where: { deletedAt: null } },
      operations: { orderBy: { createdAt: "asc" } },
      finalVideo: true,
    },
  });
  if (!run) {
    throw new HermesContentQueryError(
      "CONTENT_RUN_NOT_FOUND",
      "Content run was not found in the authenticated workspace.",
    );
  }
  try {
    const snapshot = JSON.parse(run.promptSnapshotJson ?? "") as Record<string, unknown>;
    const manifest = StyleManifestSchema.parse(snapshot.styleManifest);
    if (manifest.styleId !== run.style) throw new Error("style mismatch");
    return {
      style: { id: manifest.styleId, version: manifest.version, variant: manifest.variant },
      slotMediaTypes: Object.fromEntries(manifest.slots.map((slot) => [slot.id, slot.mediaType])),
      run: projectContentRun({ run, images: run.images, videos: run.videos, operations: run.operations, finalVideo: run.finalVideo }),
    };
  } catch (cause) {
    if (cause instanceof HermesContentQueryError) throw cause;
    throw new HermesContentQueryError(
      "INVALID_FROZEN_RUN",
      "Content run does not contain a valid frozen managed style manifest.",
    );
  }
}
