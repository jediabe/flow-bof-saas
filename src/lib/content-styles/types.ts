export const STYLE_IDS = ["style1", "style2"] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export const STYLE_VERSIONS = ["managed-style1-v1", "managed-style2-v1"] as const;
export type StyleVersion = (typeof STYLE_VERSIONS)[number];

export const STYLE_VARIANTS = ["store_discovery", "handheld", "large_countertop", "worn"] as const;
export type StyleVariant = (typeof STYLE_VARIANTS)[number];

export const PROMPT_COMPILER_IDS = [
  "style1.store_image.v1",
  "style1.store_video.v1",
  "style1.home_image.v1",
  "style1.home_video.v1",
  "style2.handheld.n1.v1",
  "style2.handheld.n2.v1",
  "style2.handheld.n3.v1",
  "style2.handheld.n4.v1",
  "style2.handheld.n5.v1",
  "style2.handheld.n6.v1",
  "style2.handheld.n7.v1",
  "style2.large_countertop.n1.v1",
  "style2.large_countertop.n2.v1",
  "style2.large_countertop.n3.v1",
  "style2.large_countertop.n4.v1",
  "style2.large_countertop.n5.v1",
  "style2.large_countertop.n6.v1",
  "style2.large_countertop.n7.v1",
  "style2.worn.n1.v1",
  "style2.worn.n2.v1",
  "style2.worn.n3.v1",
  "style2.worn.n4.v1",
  "style2.worn.n5.v1",
  "style2.worn.n6.v1",
] as const;
export type PromptCompilerId = (typeof PROMPT_COMPILER_IDS)[number];

export const CREATIVE_DIRECTION_PROFILE_IDS = [
  "style1.bounded-direction.v1",
  "style2.locked-avatar-direction.v1",
] as const;
export const VOICEOVER_SCRIPT_COMPILER_IDS = [
  "style1.elevenlabs-script.v1",
  "style2.validated-copy-script.v1",
] as const;
export const VOICEOVER_VALIDATION_PROFILE_IDS = [
  "style1.voiceover.v1",
  "style2.voiceover-70-75-words.v1",
] as const;
export const SCENE_QA_PROFILE_IDS = ["style1.scene-qa.v1", "style2.scene-qa.v1"] as const;
export const FINAL_QA_PROFILE_IDS = ["managed.final-av-qa.v1"] as const;
export const ATTACHMENT_REFERENCE_TYPES = ["product", "avatar", "garment"] as const;
export const NATIVE_AUDIO_MODES = ["duck", "mute", "preserve"] as const;

export interface ManifestAssetSlot {
  id: string;
  order: number;
  mediaType: "image" | "video";
  required: true;
  sourceDependency: string | null;
  promptCompilerId: PromptCompilerId;
  attachmentPolicy: {
    requiredReferences: Array<(typeof ATTACHMENT_REFERENCE_TYPES)[number]>;
    startImageFromSlot: string | null;
  };
  providerRequestDurationSeconds: number | null;
}

export interface StyleManifest {
  styleId: StyleId;
  version: StyleVersion;
  variant: StyleVariant;
  slots: ManifestAssetSlot[];
  creativeDirectionProfileId: (typeof CREATIVE_DIRECTION_PROFILE_IDS)[number];
  voiceover: {
    required: true;
    scriptCompilerId: (typeof VOICEOVER_SCRIPT_COMPILER_IDS)[number];
    validationProfileId: (typeof VOICEOVER_VALIDATION_PROFILE_IDS)[number];
  };
  assembly: {
    clips: Array<{
      order: number;
      slotId: string;
      trimStartSeconds: number;
      trimEndSeconds: number;
      durationSeconds: number;
      nativeAudioMode: (typeof NATIVE_AUDIO_MODES)[number];
    }>;
    output: {
      width: number;
      height: number;
      fps: number;
      audioMix: {
        voiceoverGainDb: number;
        nativeAudioGainDb: number;
        duckingThresholdDb: number;
      };
      finalDurationSeconds: number;
    };
  };
  qa: {
    sceneRequired: true;
    finalRequired: true;
    sceneProfileId: (typeof SCENE_QA_PROFILE_IDS)[number];
    finalProfileId: (typeof FINAL_QA_PROFILE_IDS)[number];
  };
  finalOutput: {
    required: true;
    container: "mp4";
    videoCodec: "h264";
    audioCodec: "aac";
  };
}

export interface StyleDefinition {
  readonly styleId: StyleId;
  readonly version: StyleVersion;
  readonly variants: readonly StyleVariant[];
  readonly compilerId: "compile-style1-manifest-v1" | "compile-style2-manifest-v1";
  compile(variant: string): StyleManifest;
}
