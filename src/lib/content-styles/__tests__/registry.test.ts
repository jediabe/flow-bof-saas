import { describe, expect, it } from "vitest";
import { STYLE_REGISTRY, compileStyleManifest, getStyleDefinition } from "../registry";
import { StyleManifestSchema } from "../schemas";

describe("managed style registry", () => {
  it("registers exactly Style 1 and Style 2 and fails closed for Style 3", () => {
    expect(Object.keys(STYLE_REGISTRY)).toEqual(["style1", "style2"]);
    expect(getStyleDefinition("style1", "managed-style1-v1").styleId).toBe("style1");
    expect(getStyleDefinition("style2", "managed-style2-v1").styleId).toBe("style2");
    expect(() => getStyleDefinition("style3", "managed-style3-v1")).toThrow(
      /Unknown managed style definition/,
    );
  });

  it.each([
    {
      styleId: "style1",
      version: "managed-style1-v1",
      variant: "store_discovery",
      slots: [
        ["scene_1_store_image", "image", null],
        ["scene_1_store_video", "video", "scene_1_store_image"],
        ["scene_2_home_image", "image", null],
        ["scene_2_home_video", "video", "scene_2_home_image"],
      ],
      clips: [
        ["scene_1_store_video", 0, 8, 8],
        ["scene_2_home_video", 0, 8, 8],
      ],
      duration: 16,
    },
    {
      styleId: "style2",
      version: "managed-style2-v1",
      variant: "handheld",
      slots: [
        ["N1", "video", null],
        ["N2", "image", null],
        ["N3", "video", "N2"],
        ["N4", "image", null],
        ["N5", "video", "N4"],
        ["N6", "image", null],
        ["N7", "video", "N6"],
      ],
      clips: [
        ["N1", 0, 4, 4],
        ["N3", 0, 6, 6],
        ["N5", 0, 6, 6],
        ["N7", 0, 6, 6],
      ],
      duration: 22,
    },
    {
      styleId: "style2",
      version: "managed-style2-v1",
      variant: "large_countertop",
      slots: [
        ["N1", "video", null],
        ["N2", "image", null],
        ["N3", "video", "N2"],
        ["N4", "image", null],
        ["N5", "video", "N4"],
        ["N6", "image", null],
        ["N7", "video", "N6"],
      ],
      clips: [
        ["N1", 0, 4, 4],
        ["N3", 0, 6, 6],
        ["N5", 0, 6, 6],
        ["N7", 0, 6, 6],
      ],
      duration: 22,
    },
    {
      styleId: "style2",
      version: "managed-style2-v1",
      variant: "worn",
      slots: [
        ["N1", "image", null],
        ["N2", "video", "N1"],
        ["N3", "image", null],
        ["N4", "video", "N3"],
        ["N5", "image", null],
        ["N6", "video", "N5"],
      ],
      clips: [
        ["N2", 0, 6, 6],
        ["N4", 0, 6, 6],
        ["N6", 0, 6, 6],
      ],
      duration: 18,
    },
  ] as const)("compiles exact $styleId $variant topology and round-trips", (expected) => {
    const manifest = compileStyleManifest(expected.styleId, expected.version, expected.variant);

    expect(manifest.slots.map((slot) => [slot.id, slot.mediaType, slot.sourceDependency])).toEqual(
      expected.slots,
    );
    expect(
      manifest.assembly.clips.map((clip) => [
        clip.slotId,
        clip.trimStartSeconds,
        clip.trimEndSeconds,
        clip.durationSeconds,
      ]),
    ).toEqual(expected.clips);
    expect(manifest.assembly.output.finalDurationSeconds).toBe(expected.duration);
    expect(manifest.slots.filter((slot) => slot.mediaType === "video")).toSatisfy(
      (slots: Array<{ providerRequestDurationSeconds: number | null }>) =>
      expected.styleId === "style2"
        ? slots.every((slot) => slot.providerRequestDurationSeconds === 8)
        : true,
    );
    expect(StyleManifestSchema.parse(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it("fails closed for unknown versions and variants", () => {
    expect(() => compileStyleManifest("style1", "managed-style1-v2", "store_discovery")).toThrow();
    expect(() => compileStyleManifest("style2", "managed-style2-v1", "unknown")).toThrow();
  });
});
