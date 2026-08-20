import type {
  ASSET_TYPES,
  CONTENT_RUN_STATES,
  CONTENT_SLOTS,
  FINAL_VIDEO_STATUSES,
  IMAGE_SLOTS,
  MEDIA_TYPES,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  PERSISTED_SCENE_LABELS,
  QA_DECISIONS,
  QA_STATUSES,
  REQUIRED_NEXT_ACTION_TYPES,
  SLOT_DEFINITIONS,
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
export type ManagedManifestSlot = "N1" | "N2" | "N3" | "N4" | "N5" | "N6" | "N7";

export type RequiredNextAction =
  | { type: "GENERATE_IMAGE"; slot: ImageSlot | ManagedManifestSlot }
  | { type: "RUN_QA"; slot: ContentSlot | ManagedManifestSlot; assetId: string }
  | { type: "GENERATE_VIDEO"; slot: VideoSlot; sourceAssetId: string }
  | { type: "GENERATE_VIDEO"; slot: ManagedManifestSlot; sourceAssetId?: string }
  | { type: "GENERATE_VOICEOVER" }
  | { type: "ASSEMBLE_FINAL"; finalVideoId: string }
  | { type: "RUN_FINAL_QA"; finalVideoId: string }
  | { type: "WAIT_FOR_OPERATION"; operationId: string }
  | { type: "HUMAN_REVIEW"; reason: string }
  | { type: "COMPLETE" }
  | { type: "FAILED"; reason: string };

export type LegacyStyle1RequiredNextAction =
  | { type: "GENERATE_IMAGE"; slot: ImageSlot }
  | { type: "RUN_QA"; slot: ContentSlot; assetId: string }
  | { type: "GENERATE_VIDEO"; slot: VideoSlot; sourceAssetId: string }
  | { type: "WAIT_FOR_OPERATION"; operationId: string }
  | { type: "HUMAN_REVIEW"; reason: string }
  | { type: "COMPLETE" }
  | { type: "FAILED"; reason: string };

export type FinalOutputRequiredNextAction =
  | { type: "GENERATE_VOICEOVER" }
  | { type: "ASSEMBLE_FINAL"; finalVideoId: string }
  | { type: "RUN_FINAL_QA"; finalVideoId: string };

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

export interface ManagedSlotRecord<TSlot extends ContentSlot = ContentSlot> {
  slot: TSlot;
  assetType: (typeof SLOT_DEFINITIONS)[TSlot]["assetType"];
  selectedAssetId?: string;
  attempts: ManagedAssetAttempt[];
}

export interface ManifestManagedSlotRecord {
  slot: ManagedManifestSlot;
  assetType: ManagedManifestSlot;
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

export interface ManifestAwareActiveContentOperation
  extends Omit<ActiveContentOperation, "slot"> {
  slot: ContentSlot | ManagedManifestSlot;
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
  slots: [
    ManagedSlotRecord<"scene_1_store_image">,
    ManagedSlotRecord<"scene_1_store_video">,
    ManagedSlotRecord<"scene_2_home_image">,
    ManagedSlotRecord<"scene_2_home_video">,
  ];
  activeOperation?: ActiveContentOperation;
  requiredNextAction: LegacyStyle1RequiredNextAction;
  terminalReason?: string;
}

export interface ManifestAwareContentRunProjection
  extends Omit<
    ContentRunProjection,
    "slots" | "activeOperation" | "requiredNextAction"
  > {
  slots: Array<ManagedSlotRecord | ManifestManagedSlotRecord>;
  activeOperation?: ManifestAwareActiveContentOperation;
  requiredNextAction: RequiredNextAction;
}

export interface ServiceActorContext {
  workspaceId: string;
  actorType: "service";
  actorId: string;
}

export type FinalVideoStatus = (typeof FINAL_VIDEO_STATUSES)[number];

export interface PersistedMediaAsset {
  bucket: string;
  key: string;
  contentType: string;
  bytes: number;
  sha256: string;
  durationSeconds: number;
}

export interface AssemblyManifest {
  version: "assembly-manifest-v1";
  clips: Array<{
    order: number;
    slotId: string;
    assetId: string;
    assetSha256: string;
    approvalStatus: "APPROVED";
    trimStartSeconds: number;
    trimEndSeconds: number;
    durationSeconds: number;
    nativeAudioMode: "duck" | "mute" | "preserve";
  }>;
  audio: { assetId: string; assetSha256: string; durationSeconds: number };
  output: {
    width: number;
    height: number;
    fps: number;
    voiceoverGainDb: number;
    nativeAudioGainDb: number;
    duckingThresholdDb: number;
    expectedDurationSeconds: number;
  };
  ffmpegVersion: string;
}

export interface FinalVideoAsset {
  id: string;
  contentRunId: string;
  attempt: number;
  status: FinalVideoStatus;
  voiceover: {
    script: string;
    provider: "elevenlabs";
    voiceId: string;
    model: string;
  } | null;
  audioAsset: PersistedMediaAsset | null;
  assemblyManifest: AssemblyManifest | null;
  finalMp4: (PersistedMediaAsset & {
    contentType: "video/mp4";
    width: number;
    height: number;
    videoCodec: string;
    audioCodec: string;
  }) | null;
  mediaValidation: { passed: boolean; validatedAt: string } | null;
  finalQa: {
    status: "NOT_QA_CHECKED" | "QA_RUNNING" | "APPROVED" | "HUMAN_REVIEW" | "FAILED";
    score: number | null;
    verdict: string | null;
    evaluatedAt: string | null;
  } | null;
}

export interface FinalReadyInvariant {
  requiredSourceAssetsApproved: boolean;
  voiceoverPersisted: boolean;
  finalMp4Persisted: boolean;
  deterministicMediaValidationPassed: boolean;
  finalAudiovisualQaApproved: boolean;
}
