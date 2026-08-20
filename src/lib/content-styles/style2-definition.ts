import { StyleManifestSchema } from "./schemas";
import type { ManifestAssetSlot, StyleDefinition, StyleManifest, StyleVariant } from "./types";

type Style2Variant = Extract<StyleVariant, "handheld" | "large_countertop" | "worn">;

function style2Slot(
  variant: Style2Variant,
  id: string,
  order: number,
  mediaType: "image" | "video",
  sourceDependency: string | null,
): ManifestAssetSlot {
  const requiredReferences: ManifestAssetSlot["attachmentPolicy"]["requiredReferences"] =
    variant === "worn"
      ? ["avatar", "garment"]
      : mediaType === "image" && ["N2", "N4", "N6"].includes(id)
        ? ["avatar", "product"]
        : ["avatar"];
  return {
    id,
    order,
    mediaType,
    required: true,
    sourceDependency,
    promptCompilerId: `style2.${variant}.${id.toLowerCase()}.v1` as ManifestAssetSlot["promptCompilerId"],
    attachmentPolicy: { requiredReferences, startImageFromSlot: sourceDependency },
    providerRequestDurationSeconds: mediaType === "video" ? 8 : null,
  };
}

function commonManifest(variant: Style2Variant, slots: ManifestAssetSlot[], clipIds: string[]) {
  const durations = variant === "worn" ? [6, 6, 6] : [4, 6, 6, 6];
  return {
    styleId: "style2" as const,
    version: "managed-style2-v1" as const,
    variant,
    slots,
    creativeDirectionProfileId: "style2.locked-avatar-direction.v1" as const,
    voiceover: {
      required: true as const,
      scriptCompilerId: "style2.validated-copy-script.v1" as const,
      validationProfileId: "style2.voiceover-70-75-words.v1" as const,
    },
    assembly: {
      clips: clipIds.map((slotId, order) => ({
        order,
        slotId,
        trimStartSeconds: 0,
        trimEndSeconds: durations[order],
        durationSeconds: durations[order],
        nativeAudioMode: "mute" as const,
      })),
      output: {
        width: 1080,
        height: 1920,
        fps: 30,
        audioMix: { voiceoverGainDb: 0, nativeAudioGainDb: -60, duckingThresholdDb: -24 },
        finalDurationSeconds: durations.reduce((sum, duration) => sum + duration, 0),
      },
    },
    qa: {
      sceneRequired: true as const,
      finalRequired: true as const,
      sceneProfileId: "style2.scene-qa.v1" as const,
      finalProfileId: "managed.final-av-qa.v1" as const,
    },
    finalOutput: {
      required: true as const,
      container: "mp4" as const,
      videoCodec: "h264" as const,
      audioCodec: "aac" as const,
    },
  };
}

export function compileStyle2Manifest(variant: string): StyleManifest {
  if (variant !== "handheld" && variant !== "large_countertop" && variant !== "worn") {
    throw new Error(`Unknown style2 variant: ${variant}`);
  }
  const slots =
    variant === "worn"
      ? [
          style2Slot(variant, "N1", 0, "image", null),
          style2Slot(variant, "N2", 1, "video", "N1"),
          style2Slot(variant, "N3", 2, "image", null),
          style2Slot(variant, "N4", 3, "video", "N3"),
          style2Slot(variant, "N5", 4, "image", null),
          style2Slot(variant, "N6", 5, "video", "N5"),
        ]
      : [
          style2Slot(variant, "N1", 0, "video", null),
          style2Slot(variant, "N2", 1, "image", null),
          style2Slot(variant, "N3", 2, "video", "N2"),
          style2Slot(variant, "N4", 3, "image", null),
          style2Slot(variant, "N5", 4, "video", "N4"),
          style2Slot(variant, "N6", 5, "image", null),
          style2Slot(variant, "N7", 6, "video", "N6"),
        ];
  const clipIds = variant === "worn" ? ["N2", "N4", "N6"] : ["N1", "N3", "N5", "N7"];
  return StyleManifestSchema.parse(commonManifest(variant, slots, clipIds));
}

export const STYLE2_DEFINITION = {
  styleId: "style2",
  version: "managed-style2-v1",
  variants: ["handheld", "large_countertop", "worn"],
  compilerId: "compile-style2-manifest-v1",
  compile: compileStyle2Manifest,
} as const satisfies StyleDefinition;
