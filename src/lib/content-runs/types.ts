import type {
  ASSET_TYPES,
  CONTENT_RUN_STATES,
  CONTENT_SLOTS,
  IMAGE_SLOTS,
  MEDIA_TYPES,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  PERSISTED_SCENE_LABELS,
  QA_DECISIONS,
  QA_STATUSES,
  REQUIRED_NEXT_ACTION_TYPES,
  VIDEO_SLOTS,
} from "./constants";

export type ContentSlot = (typeof CONTENT_SLOTS)[number];
export type ImageSlot = (typeof IMAGE_SLOTS)[number];
export type VideoSlot = (typeof VIDEO_SLOTS)[number];
export type AssetType = (typeof ASSET_TYPES)[number];
export type MediaType = (typeof MEDIA_TYPES)[number];
export type PersistedSceneLabel = (typeof PERSISTED_SCENE_LABELS)[number];
export type ContentRunState = (typeof CONTENT_RUN_STATES)[number];
export type RequiredNextActionType = (typeof REQUIRED_NEXT_ACTION_TYPES)[number];
export type OperationKind = (typeof OPERATION_KINDS)[number];
export type OperationStatus = (typeof OPERATION_STATUSES)[number];
export type QaStatus = (typeof QA_STATUSES)[number];
export type QaDecision = (typeof QA_DECISIONS)[number];

export type RequiredNextAction =
  | { type: "GENERATE_IMAGE"; slot: ImageSlot }
  | { type: "RUN_QA"; slot: ContentSlot; assetId: string }
  | { type: "GENERATE_VIDEO"; slot: VideoSlot; sourceAssetId: string }
  | { type: "WAIT_FOR_OPERATION"; operationId: string }
  | { type: "HUMAN_REVIEW"; reason: string }
  | { type: "COMPLETE" }
  | { type: "FAILED"; reason: string };

export interface SlotDefinition {
  assetType: AssetType;
  mediaType: MediaType;
  persistedSceneLabel: PersistedSceneLabel;
  sourceSlot: ImageSlot | null;
}

export interface ManagedAssetAttempt {
  assetId: string;
  attempt: number;
  qaStatus: QaStatus;
  selected: boolean;
  previewUrl?: string;
  latestQa?: {
    decision: QaDecision;
    score: number;
    summary?: string;
  };
}

export interface ManagedSlotRecord {
  slot: ContentSlot;
  assetType: AssetType;
  selectedAssetId?: string;
  attempts: ManagedAssetAttempt[];
}

export interface ActiveContentOperation {
  id: string;
  kind: OperationKind;
  status: Extract<OperationStatus, "requested" | "running">;
  slot: ContentSlot;
  providerJobId?: string;
}

export interface ContentRunProjection {
  id: string;
  productId: string;
  objective: string;
  status: ContentRunState;
  specVersion: string;
  modelSnapshot: {
    imageModel: string;
    videoModel: string;
  };
  slots: [ManagedSlotRecord, ManagedSlotRecord, ManagedSlotRecord, ManagedSlotRecord];
  activeOperation?: ActiveContentOperation;
  requiredNextAction: RequiredNextAction;
  terminalReason?: string;
}

export interface ServiceActorContext {
  workspaceId: string;
  actorType: "service";
  actorId: string;
}
