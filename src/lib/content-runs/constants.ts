/** Frozen vocabulary and deterministic mappings for managed Style 1 V1. */

export const MANAGED_STYLE1_SPEC_VERSION = "managed-style1-v1" as const;

export const CONTENT_SLOTS = [
  "scene_1_store_image",
  "scene_1_store_video",
  "scene_2_home_image",
  "scene_2_home_video",
] as const;

export const IMAGE_SLOTS = [
  "scene_1_store_image",
  "scene_2_home_image",
] as const;

export const VIDEO_SLOTS = [
  "scene_1_store_video",
  "scene_2_home_video",
] as const;

export const ASSET_TYPES = [
  "STORE_IMAGE",
  "STORE_VIDEO",
  "HOME_IMAGE",
  "HOME_VIDEO",
] as const;

export const MEDIA_TYPES = ["image", "video"] as const;

export const PERSISTED_SCENE_LABELS = [
  "scene_1_store_image",
  "scene_1_store",
  "scene_2_home_image",
  "scene_2_home",
] as const;

export const CONTENT_RUN_STATES = [
  "created",
  "generating",
  "qa_running",
  "human_review",
  "ready",
  "failed",
  "cancelled",
] as const;

export const REQUIRED_NEXT_ACTION_TYPES = [
  "GENERATE_IMAGE",
  "RUN_QA",
  "GENERATE_VIDEO",
  "WAIT_FOR_OPERATION",
  "HUMAN_REVIEW",
  "COMPLETE",
  "FAILED",
] as const;

export const OPERATION_KINDS = [
  "image_generation",
  "video_generation",
] as const;

export const OPERATION_STATUSES = [
  "requested",
  "running",
  "succeeded",
  "failed",
] as const;

export const QA_STATUSES = [
  "NOT_QA_CHECKED",
  "QA_RUNNING",
  "APPROVED",
  "REGEN_NEEDED",
  "REGEN_IN_FLIGHT",
  "HUMAN_REVIEW",
  "FAILED",
] as const;

export const QA_DECISIONS = ["APPROVE", "REGENERATE", "HUMAN_REVIEW"] as const;

type ContentSlotValue = (typeof CONTENT_SLOTS)[number];
type ImageSlotValue = (typeof IMAGE_SLOTS)[number];
type SlotDefinitionValue = {
  assetType: (typeof ASSET_TYPES)[number];
  mediaType: (typeof MEDIA_TYPES)[number];
  persistedSceneLabel: (typeof PERSISTED_SCENE_LABELS)[number];
  sourceSlot: ImageSlotValue | null;
};

export const SLOT_DEFINITIONS = {
  scene_1_store_image: {
    assetType: "STORE_IMAGE",
    mediaType: "image",
    persistedSceneLabel: "scene_1_store_image",
    sourceSlot: null,
  },
  scene_1_store_video: {
    assetType: "STORE_VIDEO",
    mediaType: "video",
    persistedSceneLabel: "scene_1_store",
    sourceSlot: "scene_1_store_image",
  },
  scene_2_home_image: {
    assetType: "HOME_IMAGE",
    mediaType: "image",
    persistedSceneLabel: "scene_2_home_image",
    sourceSlot: null,
  },
  scene_2_home_video: {
    assetType: "HOME_VIDEO",
    mediaType: "video",
    persistedSceneLabel: "scene_2_home",
    sourceSlot: "scene_2_home_image",
  },
} as const satisfies Record<ContentSlotValue, SlotDefinitionValue>;

export const ALLOWED_CONTENT_RUN_TRANSITIONS = {
  created: ["generating", "cancelled"],
  generating: ["qa_running", "failed", "cancelled"],
  qa_running: ["generating", "human_review", "ready", "failed", "cancelled"],
  human_review: [],
  ready: [],
  failed: [],
  cancelled: [],
} as const;

export const MANAGED_STYLE1_POLICY = {
  creativeAttemptsPerSlot: 1,
  maxTechnicalRetries: 2,
  maxTransportAttempts: 3,
  activeProviderOperationsPerWorkspace: 1,
  qaRequired: true,
  automaticSemanticRepair: false,
} as const;

export const MANAGED_CONTENT_STORAGE_PREFIX = "managed-content" as const;
export const DEFAULT_FLOW_IMAGE_MODEL = "nano-banana-pro" as const;
export const DEFAULT_FLOW_VIDEO_MODEL = "veo-3.1-lite" as const;
export const FLOW_PROVIDER = "google_flow_useapi" as const;
