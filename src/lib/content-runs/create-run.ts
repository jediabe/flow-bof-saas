import { db } from "@/lib/db";
import { toServerFlowDefaults } from "@/lib/workspace-settings";
import {
  ALLOWED_MANAGED_VIDEO_MODELS,
  MANAGED_STYLE1_POLICY,
  type ManagedVideoModel,
} from "./constants";
import {
  ContentRunCreationError,
} from "./errors";
import {
  compileStyle1Plan,
  Style1PlanValidationError,
  type Style1Market,
} from "./style1-plan";

export interface CreateStyle1RunInput {
  workspaceId: string;
  productId: string;
  idempotencyKey: string;
  videoModel?: ManagedVideoModel;
}

type RunResult = Awaited<ReturnType<typeof db.contentRun.create>>;

function requiredValue(value: string, field: keyof CreateStyle1RunInput): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ContentRunCreationError(
      "INVALID_REQUEST",
      `${field} is required.`,
      { field },
    );
  }
  return normalized;
}

function normalizeMarket(value: string | null | undefined): {
  persisted: "uk" | "us";
  compiler: Style1Market;
} {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "uk" || normalized === "us") {
    return { persisted: normalized, compiler: normalized.toUpperCase() as Style1Market };
  }
  throw new ContentRunCreationError(
    "INVALID_PRODUCT_CONTEXT",
    "Product market must resolve to UK or US.",
    { field: "market" },
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

/**
 * Validate and freeze one managed Style 1 objective. This service performs no
 * generation/provider work; committing the run is the prerequisite to spend.
 */
export async function createStyle1Run(input: CreateStyle1RunInput): Promise<RunResult> {
  const workspaceId = requiredValue(input.workspaceId, "workspaceId");
  const productId = requiredValue(input.productId, "productId");
  const idempotencyKey = requiredValue(input.idempotencyKey, "idempotencyKey");
  if (
    input.videoModel !== undefined &&
    !(ALLOWED_MANAGED_VIDEO_MODELS as readonly string[]).includes(input.videoModel)
  ) {
    throw new ContentRunCreationError(
      "INVALID_FLOW_MODEL",
      "The explicit video model override is not allowed for managed Style 1.",
      { field: "videoModel" },
    );
  }
  const uniqueWhere = { productId_idempotencyKey: { productId, idempotencyKey } };

  try {
    return await db.$transaction(async (tx) => {
      // Scope the product before consulting product-keyed idempotency so a caller
      // cannot use a guessed product/key pair to retrieve another tenant's run.
      const product = await tx.product.findFirst({
        where: { id: productId, batch: { workspaceId } },
        include: {
          batch: { select: { id: true, workspaceId: true, market: true } },
          images: { orderBy: [{ role: "asc" }, { createdAt: "asc" }] },
        },
      });
      if (!product) {
        throw new ContentRunCreationError(
          "PRODUCT_NOT_FOUND",
          "Product was not found in the authenticated workspace.",
        );
      }

      const existing = await tx.contentRun.findUnique({ where: uniqueWhere });
      if (existing) return existing;

      if (product.deletedAt) {
        throw new ContentRunCreationError(
          "PRODUCT_DELETED",
          "Deleted products are not eligible for managed generation.",
        );
      }
      if (product.reviewStatus !== "approved") {
        throw new ContentRunCreationError(
          "PRODUCT_NOT_APPROVED",
          "Product must be approved before creating a managed run.",
        );
      }

      const primaryReference = product.images.find((image) => image.role === "primary");
      if (!primaryReference || (!primaryReference.url?.trim() && !primaryReference.pathLocal?.trim())) {
        throw new ContentRunCreationError(
          "PRIMARY_REFERENCE_REQUIRED",
          "Product requires a usable primary reference image.",
        );
      }

      const settings = await tx.workspaceSettings.findUnique({
        where: { workspaceId },
        select: {
          flowEmail: true,
          flowImageModel: true,
          flowVideoModel: true,
        },
      });
      const flow = toServerFlowDefaults(settings);
      if (!flow.flowAccountConfigured) {
        throw new ContentRunCreationError(
          "FLOW_ACCOUNT_REQUIRED",
          "Workspace requires a connected Flow account.",
        );
      }
      if (!flow.imageModelAllowed || !flow.videoModelAllowed) {
        const field = !flow.imageModelAllowed ? "flowImageModel" : "flowVideoModel";
        throw new ContentRunCreationError(
          "INVALID_FLOW_MODEL",
          "Workspace Flow model defaults are not allowed for managed Style 1.",
          { field },
        );
      }

      const market = normalizeMarket(product.market ?? product.batch.market);
      let plan;
      try {
        plan = compileStyle1Plan({
          productName: product.productName,
          market: market.compiler,
          category: product.category ?? "",
          productReferenceImageId: primaryReference.id,
        });
      } catch (error) {
        if (error instanceof Style1PlanValidationError) {
          throw new ContentRunCreationError(
            "INVALID_PRODUCT_CONTEXT",
            "Product context cannot compile a managed Style 1 plan.",
            undefined,
            { cause: error },
          );
        }
        throw error;
      }

      const snapshot = {
        objective: "create_style1_piece",
        style: "style1",
        specVersion: plan.specVersion,
        product: {
          id: product.id,
          name: product.productName,
          category: product.category,
          market: market.persisted,
          discountPercent: product.discountPercent,
          discountType: product.discountType,
          primaryReferenceImageId: primaryReference.id,
          references: product.images.map((image) => ({
            id: image.id,
            role: image.role,
            url: image.url,
            pathLocal: image.pathLocal,
            source: image.source,
            width: image.width,
            height: image.height,
            bytes: image.bytes,
          })),
        },
        market: market.persisted,
        discount: {
          percent: product.discountPercent,
          type: product.discountType,
        },
        modelSnapshot: {
          imageModel: flow.imageModel,
          videoModel: input.videoModel ?? flow.videoModel,
        },
        prompts: plan.prompts,
        slots: plan.slots,
        policy: MANAGED_STYLE1_POLICY,
      };

      return tx.contentRun.create({
        data: {
          productId,
          idempotencyKey,
          style: "style1",
          market: market.persisted,
          status: "created",
          promptSnapshotJson: JSON.stringify(snapshot),
          discountPercent: product.discountPercent,
          discountType: product.discountType,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await db.contentRun.findUnique({ where: uniqueWhere });
      if (existing) return existing;
    }
    throw error;
  }
}
