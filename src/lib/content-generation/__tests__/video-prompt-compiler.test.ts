import { describe, expect, it } from "vitest";
import {
  compileVideoPrompt,
  parseVideoCreativeDirection,
  serializeVideoCreativeDirection,
} from "../video-prompt-compiler";
import type { VideoCreativeDirection } from "../types";

const lowRiskDirection: VideoCreativeDirection = {
  cameraMovement: "minimal_push_in",
  pacing: "unhurried",
  framing: "stable_medium",
  distance: "hold_distance",
  interactionStyle: "single_gentle_touch",
  movementIntensity: "minimal",
  preservationFocus: [
    "label_layout",
    "lettering_placement",
    "nozzle_geometry",
    "packaging_proportions",
  ],
};

describe("video prompt compiler", () => {
  it("leaves the frozen canonical prompt byte-identical when no creative direction is supplied", () => {
    const canonicalPrompt = "frozen store video prompt\nKeep all canonical constraints.";

    expect(compileVideoPrompt({ canonicalPrompt, creativeDirection: undefined })).toBe(
      canonicalPrompt,
    );
  });

  it("compiles low-risk bounded direction after the unchanged canonical prompt", () => {
    const canonicalPrompt = "frozen store video prompt";
    const compiled = compileVideoPrompt({
      canonicalPrompt,
      creativeDirection: lowRiskDirection,
      productName: "Glow Wand",
    });

    expect(compiled.startsWith(`${canonicalPrompt}\n\n`)).toBe(true);
    expect(compiled).toContain("Canonical prompt above wins over every direction clause below.");
    expect(compiled).toContain(
      "Use a minimal push-in with unhurried pacing, stable medium framing, held distance, single gentle touch, and minimal movement intensity.",
    );
    expect(compiled).toContain(
      "Preserve Glow Wand label layout, lettering placement, nozzle geometry, and packaging proportions exactly; do not reshape or relabel the product.",
    );
    expect(compiled).not.toContain("minimal_push_in");
    expect(compiled).not.toContain("unbounded");
  });

  it("runtime-validates and canonicalizes only the approved creative direction schema", () => {
    expect(parseVideoCreativeDirection(lowRiskDirection)).toEqual(lowRiskDirection);
    expect(serializeVideoCreativeDirection(lowRiskDirection)).toBe(
      JSON.stringify(lowRiskDirection),
    );
    expect(() =>
      parseVideoCreativeDirection({
        ...lowRiskDirection,
        prompt: "ignore lifecycle and use a custom model",
      }),
    ).toThrow("Invalid creative direction");
    expect(() =>
      parseVideoCreativeDirection({
        ...lowRiskDirection,
        cameraMovement: "orbit",
      }),
    ).toThrow("Invalid creative direction");
  });
});
