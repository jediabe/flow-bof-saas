import { describe, it, expect } from "vitest";
import {
  QA_SYSTEM_PROMPT_HEADER,
  buildQaSystemPrompt,
  buildQaUserText,
} from "../qa-prompt";
import { RUBRIC } from "../rubric";
import type { VisualQaInput } from "../visual-qa-provider";

function baseInput(overrides: Partial<VisualQaInput> = {}): VisualQaInput {
  return {
    assetType: "STORE_VIDEO",
    sceneLabel: "scene_1_store",
    productName: "Ninja CREAMi Deluxe",
    productCategory: "kitchen",
    market: "uk",
    generationPrompt: "walk to the product and poke it",
    referenceImage: { data: "AAAA", mediaType: "image/jpeg" },
    asset: {
      kind: "video",
      frames: [
        { timestampMs: 0, data: "AAAA", mediaType: "image/jpeg" },
        { timestampMs: 1000, data: "AAAA", mediaType: "image/jpeg" },
        { timestampMs: 2000, data: "AAAA", mediaType: "image/jpeg" },
      ],
    },
    rubric: RUBRIC,
    ...overrides,
  };
}

describe("buildQaSystemPrompt", () => {
  it("starts with the fixed header", () => {
    const out = buildQaSystemPrompt(RUBRIC);
    expect(out.startsWith(QA_SYSTEM_PROMPT_HEADER)).toBe(true);
  });

  it("includes every rubric criterion by name", () => {
    const out = buildQaSystemPrompt(RUBRIC);
    for (const c of RUBRIC) {
      expect(out).toContain(c.name);
      expect(out).toContain(c.summary);
    }
  });

  it("commits to JSON-only output (no markdown fences)", () => {
    const out = buildQaSystemPrompt(RUBRIC);
    // The prompt tells the model to skip fences — pin that so a
    // future edit doesn't silently permit them.
    expect(out).toMatch(/no markdown fences/);
    expect(out).toMatch(/STRUCTURED JSON only/);
  });

  it("tells the model it does not decide state", () => {
    // Design invariant — model observes, engine decides. Any
    // future edit that removes this framing needs to be
    // deliberate.
    const out = buildQaSystemPrompt(RUBRIC);
    expect(out).toMatch(/do NOT decide|deterministic engine/i);
  });
});

describe("buildQaUserText", () => {
  it("includes asset type + scene label + product context", () => {
    const out = buildQaUserText(baseInput());
    expect(out).toContain("STORE_VIDEO");
    expect(out).toContain("scene_1_store");
    expect(out).toContain("Ninja CREAMi Deluxe");
    expect(out).toContain("Category: kitchen");
    expect(out).toContain("Market: UK");
  });

  it("uppercases market", () => {
    const out = buildQaUserText(baseInput({ market: "us" }));
    expect(out).toContain("Market: US");
  });

  it("omits category when not provided", () => {
    const out = buildQaUserText(
      baseInput({ productCategory: undefined }),
    );
    expect(out).not.toContain("Category:");
  });

  it("includes the generation prompt verbatim when provided", () => {
    const out = buildQaUserText(
      baseInput({ generationPrompt: "SPECIFIC PROMPT TEXT" }),
    );
    expect(out).toContain("SPECIFIC PROMPT TEXT");
  });

  it("omits the generation prompt block when not provided", () => {
    const out = buildQaUserText(
      baseInput({ generationPrompt: undefined }),
    );
    expect(out).not.toContain("Generation prompt");
  });

  it("tells the model where the reference image is when present (video)", () => {
    const out = buildQaUserText(baseInput());
    expect(out).toMatch(/FIRST image .* PRODUCT REFERENCE/i);
    expect(out).toMatch(/NEXT 3 images .* FRAMES/i);
  });

  it("tells the model no reference is on file when null", () => {
    const out = buildQaUserText(baseInput({ referenceImage: null }));
    expect(out).toMatch(/No original product reference image/i);
    expect(out).toMatch(/loosely/);
    expect(out).toMatch(/You will receive 3 FRAMES/i);
  });

  it("reports frame timestamps in seconds with 2 decimals", () => {
    const out = buildQaUserText(baseInput());
    expect(out).toContain("0.00s");
    expect(out).toContain("1.00s");
    expect(out).toContain("2.00s");
  });

  it("uses different wording for image assets (no frames)", () => {
    const out = buildQaUserText(
      baseInput({
        assetType: "STORE_IMAGE",
        asset: { kind: "image", image: { data: "AA", mediaType: "image/jpeg" } },
      }),
    );
    expect(out).toMatch(/SECOND image .* GENERATED ASSET/i);
    expect(out).not.toMatch(/FRAMES/);
  });

  it("uses 'image you receive' wording when no reference AND image asset", () => {
    const out = buildQaUserText(
      baseInput({
        referenceImage: null,
        asset: { kind: "image", image: { data: "AA", mediaType: "image/jpeg" } },
      }),
    );
    expect(out).toMatch(/The image you receive is the GENERATED ASSET/);
  });

  it("closes with the JSON-emit instruction", () => {
    const out = buildQaUserText(baseInput());
    expect(out.trim().endsWith("Return the JSON object now. No prose, no markdown.")).toBe(true);
  });
});
