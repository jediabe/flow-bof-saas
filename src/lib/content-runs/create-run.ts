import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import {
  compileContentStyle,
  type CompileContentStyleInput,
} from "@/lib/content-styles/compile";
import type { StyleId } from "@/lib/content-styles/types";
import {
  createApexFlowAdapter,
  type ApexFlowAdapter,
  type ApexFlowBoundContext,
} from "@/lib/content-generation/apex-flow-adapter";
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

export interface CreateManagedContentRunInput {
  workspaceId: string;
  productId: string;
  idempotencyKey: string;
  styleId: StyleId;
  compilerInput: CompileContentStyleInput;
  videoModel?: ManagedVideoModel;
}

export interface CreateManagedContentRunDependencies {
  createAdapter?: (context: ApexFlowBoundContext) => ApexFlowAdapter;
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

function managedRequestFingerprint(
  compiled: ReturnType<typeof compileContentStyle>,
  videoModel: ManagedVideoModel | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ compiled, videoModelOverride: videoModel ?? null }))
    .digest("hex");
}

function assertManagedIdempotentReplay(
  existing: RunResult,
  requestFingerprint: string,
): RunResult {
  try {
    const snapshot = JSON.parse(existing.promptSnapshotJson ?? "") as Record<string, unknown>;
    if (snapshot.requestFingerprint === requestFingerprint) return existing;
  } catch {
    // The conflict below owns legacy or malformed snapshots.
  }
  throw new ContentRunCreationError(
    "IDEMPOTENCY_CONFLICT",
    "The idempotency key is already bound to different managed frozen inputs.",
    { field: "idempotencyKey" },
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
      if (
        !flow.imageModelAllowed ||
        (input.videoModel === undefined && !flow.videoModelAllowed)
      ) {
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

/** Create a manifest-driven run after all SaaS-owned preflight checks. */
export async function createManagedContentRun(
  input: CreateManagedContentRunInput,
  dependencies: CreateManagedContentRunDependencies = {},
): Promise<RunResult> {
  const workspaceId = requiredValue(input.workspaceId, "workspaceId");
  const productId = requiredValue(input.productId, "productId");
  const idempotencyKey = requiredValue(input.idempotencyKey, "idempotencyKey");
  if (input.styleId !== input.compilerInput.styleId) {
    throw new ContentRunCreationError(
      "INVALID_REQUEST",
      "Managed style identity must match the compiler input.",
      { field: "styleId" },
    );
  }
  if (
    input.videoModel !== undefined &&
    !(ALLOWED_MANAGED_VIDEO_MODELS as readonly string[]).includes(input.videoModel)
  ) {
    throw new ContentRunCreationError(
      "INVALID_FLOW_MODEL",
      "The explicit video model override is not allowed for managed generation.",
      { field: "videoModel" },
    );
  }
  let compiled: ReturnType<typeof compileContentStyle>;
  try {
    compiled = compileContentStyle(input.compilerInput);
  } catch (cause) {
    throw new ContentRunCreationError(
      "INVALID_PRODUCT_CONTEXT",
      "Compiler input cannot produce an approved managed style manifest.",
      undefined,
      { cause },
    );
  }
  const requestFingerprint = managedRequestFingerprint(compiled, input.videoModel);
  const uniqueWhere = { productId_idempotencyKey: { productId, idempotencyKey } };

  try {
    return await db.$transaction(async (tx) => {
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
      if (existing) return assertManagedIdempotentReplay(existing, requestFingerprint);
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

      const settings = await tx.workspaceSettings.findUnique({
        where: { workspaceId },
        select: { flowEmail: true, flowImageModel: true, flowVideoModel: true },
      });
      const flow = toServerFlowDefaults(settings);
      if (!flow.flowAccountConfigured) {
        throw new ContentRunCreationError(
          "FLOW_ACCOUNT_REQUIRED",
          "Workspace requires a connected Flow account.",
        );
      }
      if (!flow.imageModelAllowed || (input.videoModel === undefined && !flow.videoModelAllowed)) {
        throw new ContentRunCreationError(
          "INVALID_FLOW_MODEL",
          "Workspace Flow model defaults are not allowed for managed generation.",
          { field: !flow.imageModelAllowed ? "flowImageModel" : "flowVideoModel" },
        );
      }
      const market = normalizeMarket(product.market ?? product.batch.market);

      if (compiled.plan.product.name !== product.productName) {
        throw new ContentRunCreationError(
          "INVALID_PRODUCT_CONTEXT",
          "Compiler product identity does not match the approved product.",
          { field: "productName" },
        );
      }

      if (
        compiled.plan.kind === "style2_mof_avatar" &&
        compiled.plan.copy.market !== market.compiler
      ) {
        throw new ContentRunCreationError(
          "INVALID_PRODUCT_CONTEXT",
          "Compiler copy market does not match the approved product market.",
          { field: "market" },
        );
      }
      if (
        compiled.plan.kind === "style1_store_discovery" &&
        input.compilerInput.styleId === "style1"
      ) {
        let approvedPlan;
        try {
          approvedPlan = compileStyle1Plan({
            productName: product.productName,
            market: market.compiler,
            category: product.category ?? "",
            productReferenceImageId: compiled.plan.product.productReferenceImageId,
          });
        } catch (cause) {
          throw new ContentRunCreationError(
            "INVALID_PRODUCT_CONTEXT",
            "Approved product facts cannot compile the requested Style 1 manifest.",
            undefined,
            { cause },
          );
        }
        if (
          compiled.plan.product.market !== market.compiler ||
          compiled.plan.product.category !== approvedPlan.context.category ||
          input.compilerInput.style1Kit.discountPercent !== product.discountPercent
        ) {
          throw new ContentRunCreationError(
            "INVALID_PRODUCT_CONTEXT",
            "Style 1 compiler facts do not match the approved product.",
            { field: "compilerInput" },
          );
        }
      }

      const snapshotReference = (referenceId: string | null, field: string) => {
        if (!referenceId) return null;
        const reference = product.images.find((candidate) => candidate.id === referenceId);
        if (!reference || (!reference.url?.trim() && !reference.pathLocal?.trim())) {
          throw new ContentRunCreationError(
            "INVALID_PRODUCT_CONTEXT",
            `${field} must identify a usable reference owned by the approved product.`,
            { field },
          );
        }
        return {
          id: reference.id,
          role: reference.role,
          url: reference.url,
          pathLocal: reference.pathLocal,
          source: reference.source,
          width: reference.width,
          height: reference.height,
          bytes: reference.bytes,
        };
      };

      const planSlots =
        compiled.plan.kind === "style1_store_discovery"
          ? compiled.plan.promptSlots
          : compiled.plan.steps;
      const compiledReferences =
        compiled.plan.kind === "style2_mof_avatar"
          ? compiled.plan.references
          : {
              characterReferenceId: null,
              garmentReferenceId: null,
              productReferenceId: compiled.plan.product.productReferenceImageId,
            };
      const productReference = snapshotReference(
        compiledReferences.productReferenceId,
        "productReferenceId",
      );
      const garmentReference = snapshotReference(
        compiledReferences.garmentReferenceId,
        "garmentReferenceId",
      );
      const characterReferenceId = compiledReferences.characterReferenceId;
      if (
        compiled.plan.kind === "style2_mof_avatar" &&
        (!characterReferenceId || !characterReferenceId.trim())
      ) {
        throw new ContentRunCreationError(
          "INVALID_PRODUCT_CONTEXT",
          "Style 2 requires a registered character before provider spend.",
          { field: "characterReferenceId" },
        );
      }
      if (compiled.plan.kind === "style2_mof_avatar" && characterReferenceId) {
        try {
          const adapter = (dependencies.createAdapter ?? createApexFlowAdapter)({
            actor: {
              workspaceId,
              actorType: "service",
              actorId: "managed-content-run-create",
            },
            flowEmail: settings?.flowEmail?.trim() ?? "",
          });
          await adapter.getCharacter({ characterReferenceId });
        } catch (cause) {
          throw new ContentRunCreationError(
            "INVALID_PRODUCT_CONTEXT",
            "Style 2 character is not registered to the workspace Flow account.",
            { field: "characterReferenceId" },
            { cause },
          );
        }
      }

      const prompts = Object.fromEntries(
        planSlots.map((slot) => [slot.slotId, slot.prompt]),
      );
      const slots = planSlots.map((slot) => ({
        slot: slot.slotId,
        mediaType: slot.mediaType,
        prompt: slot.prompt,
        promptCompilerId: slot.promptCompilerId,
        generation: {
          aspectRatio: slot.mediaType === "image" ? "9:16" : "portrait",
          durationSeconds: slot.providerRequestDurationSeconds,
          startImageSlot: slot.dependsOnSlotId,
          characterReferenceIds: slot.requiredReferences.includes("avatar")
            ? [characterReferenceId]
            : [],
          referenceAttachmentIds: slot.requiredReferences.flatMap((kind) => {
            if (kind === "product" && productReference) return [productReference.id];
            if (kind === "garment" && garmentReference) return [garmentReference.id];
            return [];
          }),
        },
      }));
      const snapshot = {
        requestFingerprint,
        objective: `create_${compiled.styleId}_piece`,
        style: compiled.styleId,
        specVersion: compiled.version,
        variant: compiled.variant,
        product: {
          id: product.id,
          name: product.productName,
          category: product.category,
          market: market.persisted,
          discountPercent: product.discountPercent,
          discountType: product.discountType,
          references: product.images.map((reference) => ({
            id: reference.id,
            role: reference.role,
            url: reference.url,
            pathLocal: reference.pathLocal,
            source: reference.source,
            width: reference.width,
            height: reference.height,
            bytes: reference.bytes,
          })),
        },
        market: market.persisted,
        modelSnapshot: {
          imageModel: flow.imageModel,
          videoModel: input.videoModel ?? flow.videoModel,
        },
        styleManifest: compiled.manifest,
        prompts,
        slots,
        references: {
          character: characterReferenceId
            ? { id: characterReferenceId, kind: "registered_character" }
            : null,
          product: productReference,
          garment: garmentReference,
        },
        compilerPlan: compiled.plan,
        voiceoverPlan: compiled.voiceover,
        assemblyPolicy: compiled.manifest.assembly,
        policy: MANAGED_STYLE1_POLICY,
      };
      return tx.contentRun.create({
        data: {
          productId,
          idempotencyKey,
          style: compiled.styleId,
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
      if (existing && requestFingerprint) {
        return assertManagedIdempotentReplay(existing, requestFingerprint);
      }
    }
    throw error;
  }
}
