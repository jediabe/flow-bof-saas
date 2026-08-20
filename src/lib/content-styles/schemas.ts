import { z } from "zod";
import {
  ATTACHMENT_REFERENCE_TYPES,
  CREATIVE_DIRECTION_PROFILE_IDS,
  FINAL_QA_PROFILE_IDS,
  NATIVE_AUDIO_MODES,
  PROMPT_COMPILER_IDS,
  SCENE_QA_PROFILE_IDS,
  STYLE_IDS,
  STYLE_VARIANTS,
  STYLE_VERSIONS,
  VOICEOVER_SCRIPT_COMPILER_IDS,
  VOICEOVER_VALIDATION_PROFILE_IDS,
} from "./types";

const IdentifierSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/);
const PositiveSecondsSchema = z.number().finite().positive().max(600);
const NonnegativeSecondsSchema = z.number().finite().nonnegative().max(600);

type ExpectedSlot = readonly [
  id: string,
  mediaType: "image" | "video",
  dependency: string | null,
  promptCompilerId: string,
];
const EXPECTED_TOPOLOGIES: Record<string, readonly ExpectedSlot[]> = {
  "style1@managed-style1-v1/store_discovery": [
    ["scene_1_store_image", "image", null, "style1.store_image.v1"],
    ["scene_1_store_video", "video", "scene_1_store_image", "style1.store_video.v1"],
    ["scene_2_home_image", "image", null, "style1.home_image.v1"],
    ["scene_2_home_video", "video", "scene_2_home_image", "style1.home_video.v1"],
  ],
  "style2@managed-style2-v1/handheld": ["N1", "N2", "N3", "N4", "N5", "N6", "N7"].map(
    (id, index) => [
      id,
      index % 2 === 0 ? "video" : "image",
      index > 0 && index % 2 === 0 ? `N${index}` : null,
      `style2.handheld.${id.toLowerCase()}.v1`,
    ] as ExpectedSlot,
  ),
  "style2@managed-style2-v1/large_countertop": [
    "N1",
    "N2",
    "N3",
    "N4",
    "N5",
    "N6",
    "N7",
  ].map(
    (id, index) => [
      id,
      index % 2 === 0 ? "video" : "image",
      index > 0 && index % 2 === 0 ? `N${index}` : null,
      `style2.large_countertop.${id.toLowerCase()}.v1`,
    ] as ExpectedSlot,
  ),
  "style2@managed-style2-v1/worn": ["N1", "N2", "N3", "N4", "N5", "N6"].map(
    (id, index) => [
      id,
      index % 2 === 0 ? "image" : "video",
      index % 2 === 1 ? `N${index}` : null,
      `style2.worn.${id.toLowerCase()}.v1`,
    ] as ExpectedSlot,
  ),
};

const ManifestAssetSlotSchema = z
  .object({
    id: IdentifierSchema,
    order: z.number().int().nonnegative(),
    mediaType: z.enum(["image", "video"]),
    required: z.literal(true),
    sourceDependency: IdentifierSchema.nullable(),
    promptCompilerId: z.enum(PROMPT_COMPILER_IDS),
    attachmentPolicy: z
      .object({
        requiredReferences: z
          .array(z.enum(ATTACHMENT_REFERENCE_TYPES))
          .max(3)
          .refine((values) => new Set(values).size === values.length, "references must be unique"),
        startImageFromSlot: IdentifierSchema.nullable(),
      })
      .strict(),
    providerRequestDurationSeconds: PositiveSecondsSchema.nullable(),
  })
  .strict();

const AssemblyClipPolicySchema = z
  .object({
    order: z.number().int().nonnegative(),
    slotId: IdentifierSchema,
    trimStartSeconds: NonnegativeSecondsSchema,
    trimEndSeconds: PositiveSecondsSchema,
    durationSeconds: PositiveSecondsSchema,
    nativeAudioMode: z.enum(NATIVE_AUDIO_MODES),
  })
  .strict();

export const StyleManifestSchema = z
  .object({
    styleId: z.enum(STYLE_IDS),
    version: z.enum(STYLE_VERSIONS),
    variant: z.enum(STYLE_VARIANTS),
    slots: z.array(ManifestAssetSlotSchema).min(1).max(20),
    creativeDirectionProfileId: z.enum(CREATIVE_DIRECTION_PROFILE_IDS),
    voiceover: z
      .object({
        required: z.literal(true),
        scriptCompilerId: z.enum(VOICEOVER_SCRIPT_COMPILER_IDS),
        validationProfileId: z.enum(VOICEOVER_VALIDATION_PROFILE_IDS),
      })
      .strict(),
    assembly: z
      .object({
        clips: z.array(AssemblyClipPolicySchema).min(1).max(20),
        output: z
          .object({
            width: z.number().int().min(240).max(4320),
            height: z.number().int().min(240).max(4320),
            fps: z.number().int().min(1).max(120),
            audioMix: z
              .object({
                voiceoverGainDb: z.number().finite().min(-60).max(12),
                nativeAudioGainDb: z.number().finite().min(-60).max(12),
                duckingThresholdDb: z.number().finite().min(-60).max(0),
              })
              .strict(),
            finalDurationSeconds: PositiveSecondsSchema,
          })
          .strict(),
      })
      .strict(),
    qa: z
      .object({
        sceneRequired: z.literal(true),
        finalRequired: z.literal(true),
        sceneProfileId: z.enum(SCENE_QA_PROFILE_IDS),
        finalProfileId: z.enum(FINAL_QA_PROFILE_IDS),
      })
      .strict(),
    finalOutput: z
      .object({
        required: z.literal(true),
        container: z.literal("mp4"),
        videoCodec: z.literal("h264"),
        audioCodec: z.literal("aac"),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const topologyKey = `${manifest.styleId}@${manifest.version}/${manifest.variant}`;
    const expectedTopology = EXPECTED_TOPOLOGIES[topologyKey];
    if (
      !expectedTopology ||
      expectedTopology.length !== manifest.slots.length ||
      expectedTopology.some(([id, mediaType, dependency, compilerId], index) => {
        const slot = manifest.slots[index];
        return (
          !slot ||
          slot.id !== id ||
          slot.mediaType !== mediaType ||
          slot.sourceDependency !== dependency ||
          slot.promptCompilerId !== compilerId
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["slots"],
        message: "manifest must match the frozen style topology",
      });
    }
    const slotIds = manifest.slots.map((slot) => slot.id);
    if (new Set(slotIds).size !== slotIds.length) {
      context.addIssue({ code: "custom", path: ["slots"], message: "slot ids must be unique" });
    }
    if (manifest.slots.some((slot, index) => slot.order !== index)) {
      context.addIssue({ code: "custom", path: ["slots"], message: "slot order must be contiguous" });
    }
    const slotsById = new Map(manifest.slots.map((slot) => [slot.id, slot]));
    for (const [index, slot] of manifest.slots.entries()) {
      if (slot.sourceDependency && !slotsById.has(slot.sourceDependency)) {
        context.addIssue({
          code: "custom",
          path: ["slots", index, "sourceDependency"],
          message: "source dependency must reference a manifest slot",
        });
      }
      if (slot.attachmentPolicy.startImageFromSlot !== slot.sourceDependency) {
        context.addIssue({
          code: "custom",
          path: ["slots", index, "attachmentPolicy", "startImageFromSlot"],
          message: "start image must equal the source dependency",
        });
      }
      if (slot.mediaType === "image" && slot.providerRequestDurationSeconds !== null) {
        context.addIssue({ code: "custom", path: ["slots", index], message: "images have no duration" });
      }
      if (slot.mediaType === "video" && slot.providerRequestDurationSeconds === null) {
        context.addIssue({ code: "custom", path: ["slots", index], message: "videos require duration" });
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (slotId: string): boolean => {
      if (visiting.has(slotId)) return false;
      if (visited.has(slotId)) return true;
      visiting.add(slotId);
      const dependency = slotsById.get(slotId)?.sourceDependency;
      if (dependency && !visit(dependency)) return false;
      visiting.delete(slotId);
      visited.add(slotId);
      return true;
    };
    if (slotIds.some((slotId) => !visit(slotId))) {
      context.addIssue({ code: "custom", path: ["slots"], message: "slot dependencies must be acyclic" });
    }

    const clipSlotIds = manifest.assembly.clips.map((clip) => clip.slotId);
    if (new Set(clipSlotIds).size !== clipSlotIds.length) {
      context.addIssue({ code: "custom", path: ["assembly", "clips"], message: "clip slots must be unique" });
    }
    if (manifest.assembly.clips.some((clip, index) => clip.order !== index)) {
      context.addIssue({ code: "custom", path: ["assembly", "clips"], message: "clip order must be contiguous" });
    }
    for (const [index, clip] of manifest.assembly.clips.entries()) {
      const slot = slotsById.get(clip.slotId);
      if (!slot || slot.mediaType !== "video") {
        context.addIssue({ code: "custom", path: ["assembly", "clips", index], message: "clips require video slots" });
        continue;
      }
      if (
        clip.trimEndSeconds <= clip.trimStartSeconds ||
        clip.durationSeconds !== clip.trimEndSeconds - clip.trimStartSeconds ||
        clip.trimEndSeconds > (slot.providerRequestDurationSeconds ?? 0)
      ) {
        context.addIssue({ code: "custom", path: ["assembly", "clips", index], message: "invalid trim bounds" });
      }
    }
    const videoSlotIds = manifest.slots
      .filter((slot) => slot.mediaType === "video")
      .map((slot) => slot.id);
    if (videoSlotIds.length !== clipSlotIds.length || videoSlotIds.some((id) => !clipSlotIds.includes(id))) {
      context.addIssue({ code: "custom", path: ["assembly", "clips"], message: "every video slot must be assembled once" });
    }
    const duration = manifest.assembly.clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
    if (duration !== manifest.assembly.output.finalDurationSeconds) {
      context.addIssue({ code: "custom", path: ["assembly", "output", "finalDurationSeconds"], message: "final duration must equal clip durations" });
    }
  });

export type ParsedStyleManifest = z.infer<typeof StyleManifestSchema>;
