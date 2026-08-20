import { StyleManifestSchema } from "./schemas";
import type { ManifestAssetSlot, StyleDefinition, StyleManifest } from "./types";

const slot = (
  id: string,
  order: number,
  mediaType: "image" | "video",
  sourceDependency: string | null,
  promptCompilerId: ManifestAssetSlot["promptCompilerId"],
): ManifestAssetSlot => ({
  id,
  order,
  mediaType,
  required: true,
  sourceDependency,
  promptCompilerId,
  attachmentPolicy: {
    requiredReferences: mediaType === "image" ? ["product"] : [],
    startImageFromSlot: sourceDependency,
  },
  providerRequestDurationSeconds: mediaType === "video" ? 8 : null,
});

export function compileStyle1Manifest(variant: string): StyleManifest {
  if (variant !== "store_discovery") {
    throw new Error(`Unknown style1 variant: ${variant}`);
  }
  return StyleManifestSchema.parse({
    styleId: "style1",
    version: "managed-style1-v1",
    variant,
    slots: [
      slot("scene_1_store_image", 0, "image", null, "style1.store_image.v1"),
      slot(
        "scene_1_store_video",
        1,
        "video",
        "scene_1_store_image",
        "style1.store_video.v1",
      ),
      slot("scene_2_home_image", 2, "image", null, "style1.home_image.v1"),
      slot(
        "scene_2_home_video",
        3,
        "video",
        "scene_2_home_image",
        "style1.home_video.v1",
      ),
    ],
    creativeDirectionProfileId: "style1.bounded-direction.v1",
    voiceover: {
      required: true,
      scriptCompilerId: "style1.elevenlabs-script.v1",
      validationProfileId: "style1.voiceover.v1",
    },
    assembly: {
      clips: [
        {
          order: 0,
          slotId: "scene_1_store_video",
          trimStartSeconds: 0,
          trimEndSeconds: 8,
          durationSeconds: 8,
          nativeAudioMode: "duck",
        },
        {
          order: 1,
          slotId: "scene_2_home_video",
          trimStartSeconds: 0,
          trimEndSeconds: 8,
          durationSeconds: 8,
          nativeAudioMode: "duck",
        },
      ],
      output: {
        width: 1080,
        height: 1920,
        fps: 30,
        audioMix: { voiceoverGainDb: 0, nativeAudioGainDb: -18, duckingThresholdDb: -24 },
        finalDurationSeconds: 16,
      },
    },
    qa: {
      sceneRequired: true,
      finalRequired: true,
      sceneProfileId: "style1.scene-qa.v1",
      finalProfileId: "managed.final-av-qa.v1",
    },
    finalOutput: { required: true, container: "mp4", videoCodec: "h264", audioCodec: "aac" },
  });
}

export const STYLE1_DEFINITION = {
  styleId: "style1",
  version: "managed-style1-v1",
  variants: ["store_discovery"],
  compilerId: "compile-style1-manifest-v1",
  compile: compileStyle1Manifest,
} as const satisfies StyleDefinition;
