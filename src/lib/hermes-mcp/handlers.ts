import { createManagedContentRun } from "@/lib/content-runs/create-run";
import type {
  ImageSlot,
  ManagedManifestSlot,
  ManifestAwareContentRunProjection,
  RequiredNextAction,
  ServiceActorContext,
  VideoSlot,
} from "@/lib/content-runs/types";
import { runManagedQa } from "@/lib/content-runs/run-managed-qa";
import { generateManagedImage } from "@/lib/content-generation/generate-image";
import { generateManagedVideo } from "@/lib/content-generation/generate-video";
import { runFinalOutput } from "@/lib/final-output/run-final-output";
import { SLOT_DEFINITIONS } from "@/lib/content-runs/constants";
import { HERMES_CONTENT_TOOL_SCHEMAS, type ContentCreateRunInput } from "./schemas";
import { getApprovedProduct, getGenerationReplayOperation, getManagedRunView } from "./queries";

export interface ManagedRunView {
  style: {
    id: "style1" | "style2";
    version: "managed-style1-v1" | "managed-style2-v1";
    variant: "store_discovery" | "handheld" | "large_countertop" | "worn";
  };
  slotMediaTypes: Record<string, "image" | "video">;
  run: ManifestAwareContentRunProjection;
}

export class HermesContentActionError extends Error {
  constructor(readonly code: "ACTION_NOT_READY" | "INVALID_FROZEN_RUN", message: string) {
    super(message);
    this.name = "HermesContentActionError";
  }
}

type Dependencies = {
  getProduct: typeof getApprovedProduct;
  getRun: (actor: ServiceActorContext, contentRunId: string) => Promise<ManagedRunView>;
  getGenerationReplayOperation: typeof getGenerationReplayOperation;
  createRun: typeof createManagedContentRun;
  generateImage: typeof generateManagedImage;
  generateVideo: typeof generateManagedVideo;
  runQa: typeof runManagedQa;
  runFinalOutput: typeof runFinalOutput;
};

type DependencyOverrides = Partial<Dependencies>;

function requireAction<T extends RequiredNextAction["type"]>(
  view: ManagedRunView,
  type: T,
): Extract<RequiredNextAction, { type: T }> {
  const action = view.run.requiredNextAction;
  if (action.type !== type) {
    throw new HermesContentActionError(
      "ACTION_NOT_READY",
      `Persisted next action is ${action.type}, not ${type}.`,
    );
  }
  return action as Extract<RequiredNextAction, { type: T }>;
}

function persistedSceneLabel(slot: string): string {
  if (slot in SLOT_DEFINITIONS) {
    return SLOT_DEFINITIONS[slot as keyof typeof SLOT_DEFINITIONS].persistedSceneLabel;
  }
  return slot;
}

async function requireGenerationAction(
  actor: ServiceActorContext,
  dependencies: Dependencies,
  view: ManagedRunView,
  input: { contentRunId: string; idempotencyKey: string },
  expected: {
    action: "GENERATE_IMAGE" | "GENERATE_VIDEO";
    kind: "image_generation" | "video_generation";
    mediaType: "image" | "video";
    allowWaitReplay: boolean;
  },
) {
  const action = view.run.requiredNextAction;
  if (action.type === expected.action) return action;
  if (action.type !== "WAIT_FOR_OPERATION") {
    throw new HermesContentActionError(
      "ACTION_NOT_READY",
      `Persisted next action is ${action.type}, not ${expected.action}.`,
    );
  }
  if (!expected.allowWaitReplay) {
    throw new HermesContentActionError(
      "ACTION_NOT_READY",
      `${expected.mediaType} generation cannot safely replay while its synchronous operation is in flight.`,
    );
  }

  const active = view.run.activeOperation;
  if (
    view.run.status !== "generating" ||
    !active ||
    active.id !== action.operationId ||
    active.kind !== expected.kind ||
    view.slotMediaTypes[active.slot] !== expected.mediaType
  ) {
    throw new HermesContentActionError(
      "ACTION_NOT_READY",
      `Persisted WAIT operation is not the active ${expected.mediaType} generation command.`,
    );
  }

  const operation = await dependencies.getGenerationReplayOperation(
    actor,
    input.contentRunId,
    action.operationId,
  );
  if (
    !operation ||
    operation.workspaceId !== actor.workspaceId ||
    operation.contentRunId !== input.contentRunId ||
    operation.kind !== expected.kind ||
    !["requested", "running"].includes(operation.status) ||
    operation.sceneLabel !== persistedSceneLabel(active.slot) ||
    operation.idempotencyKey !== input.idempotencyKey
  ) {
    throw new HermesContentActionError(
      "ACTION_NOT_READY",
      `Persisted WAIT operation does not match the stable ${expected.mediaType} generation command.`,
    );
  }
  return { type: expected.action, slot: active.slot } as Extract<
    RequiredNextAction,
    { type: "GENERATE_IMAGE" | "GENERATE_VIDEO" }
  >;
}

export function createHermesContentHandlers(
  actor: ServiceActorContext,
  overrides: DependencyOverrides = {},
) {
  const dependencies: Dependencies = {
    getProduct: overrides.getProduct ?? getApprovedProduct,
    getRun: overrides.getRun ?? getManagedRunView,
    getGenerationReplayOperation: overrides.getGenerationReplayOperation ?? getGenerationReplayOperation,
    createRun: overrides.createRun ?? createManagedContentRun,
    generateImage: overrides.generateImage ?? generateManagedImage,
    generateVideo: overrides.generateVideo ?? generateManagedVideo,
    runQa: overrides.runQa ?? runManagedQa,
    runFinalOutput: overrides.runFinalOutput ?? runFinalOutput,
  };

  return {
    async content_get_product(raw: unknown) {
      const input = HERMES_CONTENT_TOOL_SCHEMAS.content_get_product.parse(raw);
      return dependencies.getProduct(actor, input.productId);
    },

    async content_create_run(raw: unknown) {
      const input: ContentCreateRunInput = HERMES_CONTENT_TOOL_SCHEMAS.content_create_run.parse(raw);
      const created = await dependencies.createRun({
        workspaceId: actor.workspaceId,
        productId: input.productId,
        idempotencyKey: input.idempotencyKey,
        styleId: input.style,
        compilerInput: input.compilerInput,
        ...(input.videoModel ? { videoModel: input.videoModel } : {}),
      });
      const view = await dependencies.getRun(actor, created.id);
      return { runId: created.id, style: view.style, nextAction: view.run.requiredNextAction };
    },

    async content_generate_image(raw: unknown) {
      const input = HERMES_CONTENT_TOOL_SCHEMAS.content_generate_image.parse(raw);
      const view = await dependencies.getRun(actor, input.contentRunId);
      const action = await requireGenerationAction(actor, dependencies, view, input, {
        action: "GENERATE_IMAGE",
        kind: "image_generation",
        mediaType: "image",
        allowWaitReplay: false,
      });
      return dependencies.generateImage(actor, {
        ...input,
        slot: action.slot as ImageSlot | ManagedManifestSlot,
      });
    },

    async content_generate_video(raw: unknown) {
      const input = HERMES_CONTENT_TOOL_SCHEMAS.content_generate_video.parse(raw);
      const view = await dependencies.getRun(actor, input.contentRunId);
      const action = await requireGenerationAction(actor, dependencies, view, input, {
        action: "GENERATE_VIDEO",
        kind: "video_generation",
        mediaType: "video",
        allowWaitReplay: true,
      });
      return dependencies.generateVideo(actor, {
        contentRunId: input.contentRunId,
        idempotencyKey: input.idempotencyKey,
        slot: action.slot as VideoSlot | ManagedManifestSlot,
        ...(input.creativeDirection ? { creativeDirection: input.creativeDirection } : {}),
      });
    },

    async content_run_qa(raw: unknown) {
      const input = HERMES_CONTENT_TOOL_SCHEMAS.content_run_qa.parse(raw);
      const view = await dependencies.getRun(actor, input.contentRunId);
      const action = requireAction(view, "RUN_QA");
      const assetKind = view.slotMediaTypes[action.slot];
      if (!assetKind) {
        throw new HermesContentActionError(
          "INVALID_FROZEN_RUN",
          "Frozen style manifest does not define the QA slot media type.",
        );
      }
      return dependencies.runQa(actor, {
        contentRunId: input.contentRunId,
        assetId: action.assetId,
        assetKind,
      });
    },

    async content_run_final_output(raw: unknown) {
      const input = HERMES_CONTENT_TOOL_SCHEMAS.content_run_final_output.parse(raw);
      const view = await dependencies.getRun(actor, input.contentRunId);
      const action = view.run.requiredNextAction;
      if (action.type === "WAIT_FOR_OPERATION") {
        return { action: "WAIT" as const, operationId: action.operationId };
      }
      if (action.type === "COMPLETE") return { action: "READY" as const };
      if (action.type === "HUMAN_REVIEW") {
        return { action: "HUMAN_REVIEW" as const, reason: action.reason };
      }
      if (action.type === "FAILED") return { action: "FAILED" as const, reason: action.reason };
      if (!(["GENERATE_VOICEOVER", "ASSEMBLE_FINAL", "RUN_FINAL_QA"] as const).includes(
        action.type as "GENERATE_VOICEOVER" | "ASSEMBLE_FINAL" | "RUN_FINAL_QA",
      )) {
        throw new HermesContentActionError(
          "ACTION_NOT_READY",
          `Persisted next action ${action.type} is not a final-output phase.`,
        );
      }
      const result = await dependencies.runFinalOutput(actor, {
        contentRunId: input.contentRunId,
        idempotencyRoot: input.idempotencyKey,
      });
      const terminalAction = result.status === "ready"
        ? "READY"
        : result.status === "human_review"
          ? "HUMAN_REVIEW"
          : result.status === "failed"
            ? "FAILED"
            : null;
      return { action: terminalAction ?? action.type, ...result };
    },

    async content_get_run(raw: unknown) {
      const input = HERMES_CONTENT_TOOL_SCHEMAS.content_get_run.parse(raw);
      return dependencies.getRun(actor, input.contentRunId);
    },
  };
}

export type HermesContentHandlers = ReturnType<typeof createHermesContentHandlers>;
