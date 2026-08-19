import {
  CONTENT_SLOTS,
  QA_STATUSES,
  SLOT_DEFINITIONS,
} from "./constants";
import type {
  ActiveContentOperation,
  ContentRunProjection,
  ContentRunState,
  ContentSlot,
  ManagedAssetAttempt,
  ManagedSlotRecord,
  OperationKind,
  OperationStatus,
  QaDecision,
  QaStatus,
  RequiredNextAction,
} from "./types";

export class ContentRunProjectionError extends Error {
  readonly code = "INVALID_CONTENT_RUN_PROJECTION" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContentRunProjectionError";
  }
}

interface ProjectableAsset {
  id: string;
  contentRunId: string | null;
  sceneLabel: string;
  attemptNumber: number;
  qaStatus: string;
  qaScore: number | null;
  qaVerdictJson: string | null;
  previewUrl?: string;
}

interface ProjectableOperation {
  id: string;
  contentRunId: string;
  kind: string;
  sceneLabel: string;
  status: string;
  providerJobId?: string | null;
  errorJson?: string | null;
}

export interface ProjectContentRunInput {
  run: {
    id: string;
    productId: string;
    status: string;
    promptSnapshotJson: string | null;
  };
  images: ProjectableAsset[];
  videos: ProjectableAsset[];
  /** Operations should be supplied oldest-to-newest. */
  operations: ProjectableOperation[];
}

interface FrozenRunSnapshot {
  objective: string;
  specVersion: string;
  imageModel: string;
  videoModel: string;
}

const CONTENT_RUN_STATE_SET = new Set<string>([
  "created",
  "generating",
  "qa_running",
  "human_review",
  "ready",
  "failed",
  "cancelled",
] satisfies ContentRunState[]);
const QA_STATUS_SET = new Set<string>(QA_STATUSES);
const ACTIVE_OPERATION_STATUSES = new Set(["requested", "running"]);

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseSnapshot(snapshotJson: string | null): FrozenRunSnapshot {
  if (!snapshotJson) {
    throw new ContentRunProjectionError("ContentRun has no frozen prompt snapshot.");
  }

  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(snapshotJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("snapshot must be an object");
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new ContentRunProjectionError("ContentRun prompt snapshot is invalid JSON.");
  }

  const models =
    raw.modelSnapshot && typeof raw.modelSnapshot === "object"
      ? (raw.modelSnapshot as Record<string, unknown>)
      : raw.models && typeof raw.models === "object"
        ? (raw.models as Record<string, unknown>)
        : raw;
  const objective = readNonEmptyString(raw.objective);
  const specVersion = readNonEmptyString(raw.specVersion);
  const imageModel =
    readNonEmptyString(models.imageModel) ?? readNonEmptyString(models.image);
  const videoModel =
    readNonEmptyString(models.videoModel) ?? readNonEmptyString(models.video);

  if (!objective || !specVersion || !imageModel || !videoModel) {
    throw new ContentRunProjectionError(
      "ContentRun prompt snapshot is missing objective, specVersion, or frozen models.",
    );
  }
  return { objective, specVersion, imageModel, videoModel };
}

function parseQaStatus(value: string): QaStatus {
  return QA_STATUS_SET.has(value) ? (value as QaStatus) : "FAILED";
}

function parseLatestQa(asset: ProjectableAsset): ManagedAssetAttempt["latestQa"] {
  if (!asset.qaVerdictJson) return undefined;
  try {
    const raw = JSON.parse(asset.qaVerdictJson) as Record<string, unknown>;
    const score = raw.overallScore ?? raw.score ?? asset.qaScore;
    const decisionByStatus: Partial<Record<QaStatus, QaDecision>> = {
      APPROVED: "APPROVE",
      REGEN_NEEDED: "REGENERATE",
      REGEN_IN_FLIGHT: "REGENERATE",
      HUMAN_REVIEW: "HUMAN_REVIEW",
    };
    const statusDecision = decisionByStatus[parseQaStatus(asset.qaStatus)];
    const persistedDecision =
      raw.decision === "APPROVE" ||
      raw.decision === "REGENERATE" ||
      raw.decision === "HUMAN_REVIEW"
        ? raw.decision
        : undefined;
    const decision = persistedDecision ?? statusDecision;
    if (decision && typeof score === "number") {
      return {
        decision,
        score,
        ...(readNonEmptyString(raw.summary) ? { summary: raw.summary as string } : {}),
      };
    }
  } catch {
    // The projection remains available even when legacy verdict JSON is malformed.
  }
  return undefined;
}

function assetsForSlot(
  runId: string,
  slot: ContentSlot,
  input: ProjectContentRunInput,
): ProjectableAsset[] {
  const definition = SLOT_DEFINITIONS[slot];
  const source = definition.mediaType === "image" ? input.images : input.videos;
  return source
    .filter(
      (asset) =>
        asset.contentRunId === runId && asset.sceneLabel === definition.persistedSceneLabel,
    )
    .sort((left, right) =>
      left.attemptNumber === right.attemptNumber
        ? left.id.localeCompare(right.id)
        : left.attemptNumber - right.attemptNumber,
    );
}

function buildSlot<TSlot extends ContentSlot>(
  runId: string,
  slot: TSlot,
  input: ProjectContentRunInput,
): ManagedSlotRecord<TSlot> {
  const assets = assetsForSlot(runId, slot, input);
  const current = assets.at(-1);
  return {
    slot,
    assetType: SLOT_DEFINITIONS[slot].assetType,
    ...(current ? { selectedAssetId: current.id } : {}),
    attempts: assets.map((asset) => {
      const latestQa = parseLatestQa(asset);
      return {
        assetId: asset.id,
        attempt: asset.attemptNumber,
        qaStatus: parseQaStatus(asset.qaStatus),
        selected: asset.id === current?.id,
        ...(asset.previewUrl ? { previewUrl: asset.previewUrl } : {}),
        ...(latestQa ? { latestQa } : {}),
      };
    }),
  };
}

function slotCurrentAttempt(slot: ManagedSlotRecord): ManagedAssetAttempt | undefined {
  return slot.attempts.find((attempt) => attempt.selected);
}

function slotFromSceneLabel(sceneLabel: string): ContentSlot | undefined {
  return CONTENT_SLOTS.find(
    (slot) => SLOT_DEFINITIONS[slot].persistedSceneLabel === sceneLabel,
  );
}

function normalizeTerminalReason(errorJson: string | null | undefined): string {
  if (!errorJson) {
    return JSON.stringify({ code: "OPERATION_FAILED" });
  }
  try {
    const parsed: unknown = JSON.parse(errorJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const code =
        typeof record.code === "string" && /^[A-Z0-9_]{1,100}$/.test(record.code)
          ? record.code
          : "OPERATION_FAILED";
      return JSON.stringify({
        code,
        ...(typeof record.retryable === "boolean"
          ? { retryable: record.retryable }
          : {}),
      });
    }
  } catch {
    // Never expose unstructured provider errors through the public projection.
  }
  return JSON.stringify({ code: "OPERATION_FAILED" });
}

function deriveProjectionStateAndAction(input: {
  persistedStatus: ContentRunState;
  slots: ContentRunProjection["slots"];
  operations: ProjectableOperation[];
}): {
  status: ContentRunState;
  action: RequiredNextAction;
  activeOperation?: ActiveContentOperation;
  terminalReason?: string;
} {
  const currentAttempts = input.slots.map(slotCurrentAttempt);
  const allApproved = currentAttempts.every(
    (attempt) => attempt?.qaStatus === "APPROVED",
  );

  if (input.persistedStatus === "human_review") {
    const reason = "Run requires human review.";
    return { status: "human_review", action: { type: "HUMAN_REVIEW", reason } };
  }
  if (input.persistedStatus === "failed" || input.persistedStatus === "cancelled") {
    const reason = JSON.stringify({
      code: input.persistedStatus === "cancelled" ? "RUN_CANCELLED" : "RUN_FAILED",
    });
    return {
      status: input.persistedStatus,
      action: { type: "FAILED", reason },
      terminalReason: reason,
    };
  }
  if (input.persistedStatus === "ready") {
    if (allApproved) {
      return { status: "ready", action: { type: "COMPLETE" } };
    }
    const reason = JSON.stringify({ code: "READY_WITHOUT_FOUR_APPROVED_SLOTS" });
    return { status: "failed", action: { type: "FAILED", reason }, terminalReason: reason };
  }

  const invalidOperation = input.operations.find(
    (operation) =>
      !["image_generation", "video_generation"].includes(operation.kind) ||
      !["requested", "running", "succeeded", "failed"].includes(operation.status),
  );
  if (invalidOperation) {
    const reason = JSON.stringify({
      code: "INVALID_OPERATION_RECORD",
      operationId: invalidOperation.id,
    });
    return { status: "failed", action: { type: "FAILED", reason }, terminalReason: reason };
  }

  const managedOperations = input.operations;
  const failedOperation = [...managedOperations]
    .reverse()
    .find((operation) => operation.status === "failed");
  if (failedOperation) {
    const reason = normalizeTerminalReason(failedOperation.errorJson);
    return {
      status: "failed",
      action: { type: "FAILED", reason },
      terminalReason: reason,
    };
  }

  const activeOperation = [...managedOperations]
    .reverse()
    .find((operation) => ACTIVE_OPERATION_STATUSES.has(operation.status));
  if (activeOperation) {
    const slot = slotFromSceneLabel(activeOperation.sceneLabel);
    if (!slot) {
      const reason = JSON.stringify({
        code: "INVALID_OPERATION_SLOT",
        operationId: activeOperation.id,
      });
      return { status: "failed", action: { type: "FAILED", reason }, terminalReason: reason };
    }
    const projectedOperation: ActiveContentOperation = {
      id: activeOperation.id,
      kind: activeOperation.kind as OperationKind,
      status: activeOperation.status as Extract<OperationStatus, "requested" | "running">,
      slot,
      ...(activeOperation.providerJobId
        ? { providerJobId: activeOperation.providerJobId }
        : {}),
    };
    return {
      status: "generating",
      action: { type: "WAIT_FOR_OPERATION", operationId: activeOperation.id },
      activeOperation: projectedOperation,
    };
  }

  const negative = currentAttempts.find(
    (attempt) =>
      attempt &&
      ["REGEN_NEEDED", "REGEN_IN_FLIGHT", "HUMAN_REVIEW"].includes(attempt.qaStatus),
  );
  if (negative) {
    const reason = `Asset ${negative.assetId} requires human review after QA status ${negative.qaStatus}.`;
    return { status: "human_review", action: { type: "HUMAN_REVIEW", reason } };
  }

  const failedAsset = currentAttempts.find((attempt) => attempt?.qaStatus === "FAILED");
  if (failedAsset) {
    const reason = JSON.stringify({ code: "QA_FAILED", assetId: failedAsset.assetId });
    return { status: "failed", action: { type: "FAILED", reason }, terminalReason: reason };
  }

  // Mandatory QA dominates generation ordering: even an unexpected out-of-order
  // persisted managed asset must block every dependent generation action.
  for (let index = 0; index < input.slots.length; index += 1) {
    const attempt = currentAttempts[index];
    if (
      attempt?.qaStatus === "NOT_QA_CHECKED" ||
      attempt?.qaStatus === "QA_RUNNING"
    ) {
      return {
        status: "qa_running",
        action: {
          type: "RUN_QA",
          slot: input.slots[index].slot,
          assetId: attempt.assetId,
        },
      };
    }
  }

  if (allApproved) {
    return { status: "ready", action: { type: "COMPLETE" } };
  }

  for (let index = 0; index < input.slots.length; index += 1) {
    const slot = input.slots[index];
    const current = currentAttempts[index];
    if (!current) {
      const definition = SLOT_DEFINITIONS[slot.slot];
      if (definition.mediaType === "image") {
        return {
          status: "generating",
          action: { type: "GENERATE_IMAGE", slot: slot.slot as "scene_1_store_image" | "scene_2_home_image" },
        };
      }
      const sourceIndex = CONTENT_SLOTS.indexOf(definition.sourceSlot!);
      const source = currentAttempts[sourceIndex];
      if (source?.qaStatus === "APPROVED") {
        return {
          status: "generating",
          action: {
            type: "GENERATE_VIDEO",
            slot: slot.slot as "scene_1_store_video" | "scene_2_home_video",
            sourceAssetId: source.assetId,
          },
        };
      }
    }
  }

  const reason = JSON.stringify({ code: "UNPROJECTABLE_RUN_STATE" });
  return { status: "failed", action: { type: "FAILED", reason }, terminalReason: reason };
}

export function projectContentRun(input: ProjectContentRunInput): ContentRunProjection {
  const snapshot = parseSnapshot(input.run.promptSnapshotJson);
  if (!CONTENT_RUN_STATE_SET.has(input.run.status)) {
    throw new ContentRunProjectionError(`Unknown ContentRun status: ${input.run.status}.`);
  }

  const slots: ContentRunProjection["slots"] = [
    buildSlot(input.run.id, "scene_1_store_image", input),
    buildSlot(input.run.id, "scene_1_store_video", input),
    buildSlot(input.run.id, "scene_2_home_image", input),
    buildSlot(input.run.id, "scene_2_home_video", input),
  ];
  const operations = input.operations.filter(
    (operation) => operation.contentRunId === input.run.id,
  );
  const derived = deriveProjectionStateAndAction({
    persistedStatus: input.run.status as ContentRunState,
    slots,
    operations,
  });

  return {
    id: input.run.id,
    productId: input.run.productId,
    objective: snapshot.objective,
    status:
      input.run.status === "created" && derived.status === "generating"
        ? "created"
        : derived.status,
    specVersion: snapshot.specVersion,
    modelSnapshot: {
      imageModel: snapshot.imageModel,
      videoModel: snapshot.videoModel,
    },
    slots,
    ...(derived.activeOperation ? { activeOperation: derived.activeOperation } : {}),
    requiredNextAction: derived.action,
    ...(derived.terminalReason ? { terminalReason: derived.terminalReason } : {}),
  };
}
