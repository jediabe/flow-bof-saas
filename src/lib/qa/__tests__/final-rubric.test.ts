import { describe, expect, it } from "vitest";
import {
  FINAL_RUBRIC,
  decideFinalQa,
  type FinalVisualQaResult,
} from "../final-rubric";
import {
  buildFinalQaSystemPrompt,
  buildFinalQaUserText,
} from "../final-qa-prompt";

function visualResult(overrides: Partial<FinalVisualQaResult> = {}): FinalVisualQaResult {
  return {
    overallScore: 92,
    hasHardFailure: false,
    checks: FINAL_RUBRIC.map((criterion) => ({
      name: criterion.name,
      passed: true,
      score: 92,
    })),
    issues: [],
    ...overrides,
  };
}

const deterministicPass = { passed: true as const, failures: [] };

describe("final output rubric", () => {
  it("contains the exact final audiovisual criteria without extending the scene rubric", () => {
    expect(FINAL_RUBRIC.map((criterion) => criterion.name)).toEqual([
      "VISUAL_CONTINUITY",
      "BLACK_OR_FROZEN_FRAMES",
      "CLIP_BOUNDARIES_AND_ORDER",
      "VOICEOVER_NATIVE_AUDIO_BALANCE",
      "AUDIBLE_NARRATION",
      "AUDIO_CLIPPING_OR_SILENCE",
      "OUTPUT_SUITABILITY",
    ]);
  });

  it("builds a final-only prompt with ordered sampled-frame and deterministic-analysis context", () => {
    const system = buildFinalQaSystemPrompt(FINAL_RUBRIC);
    const user = buildFinalQaUserText({
      productName: "Widget",
      market: "uk",
      expectedClipOrder: ["hook", "demo"],
      frameTimestampsMs: [0, 4000, 9990],
      deterministicSummary: "MP4/H.264/AAC media gates passed; silence and clipping analysis passed.",
    });
    for (const criterion of FINAL_RUBRIC) expect(system).toContain(criterion.name);
    expect(system).toContain("final assembled output");
    expect(user).toContain("hook -> demo");
    expect(user).toContain("0ms, 4000ms, 9990ms");
    expect(user).toContain("silence and clipping analysis passed");
    expect(user).not.toContain("transcript");
    expect(user).not.toContain("captions");
    expect(user).not.toContain("music");
    expect(user).not.toContain("repair");
  });
});

describe("final QA policy fixtures", () => {
  it("APPROVEs only when deterministic gates pass and sampled-frame QA approves", () => {
    expect(decideFinalQa({ deterministic: deterministicPass, visual: visualResult() })).toMatchObject({
      decision: "APPROVE",
      score: 92,
    });
  });

  it("routes deterministic failure to HUMAN_REVIEW and never approves a high visual score", () => {
    const evaluation = decideFinalQa({
      deterministic: {
        passed: false,
        failures: [{ code: "AUDIO_CLIPPING", message: "Clipping detected." }],
      },
      visual: visualResult({ overallScore: 100 }),
    });
    expect(evaluation.decision).toBe("HUMAN_REVIEW");
    expect(evaluation.verdict).toContain("AUDIO_CLIPPING");
  });

  it("routes a visual rejection to HUMAN_REVIEW without regeneration", () => {
    const result = visualResult({
      overallScore: 70,
      checks: FINAL_RUBRIC.map((criterion, index) => ({
        name: criterion.name,
        passed: index !== 0,
        score: index === 0 ? 40 : 90,
        ...(index === 0 ? { severity: "major" as const, reason: "Continuity break." } : {}),
      })),
    });
    expect(decideFinalQa({ deterministic: deterministicPass, visual: result })).toMatchObject({
      decision: "HUMAN_REVIEW",
      score: 70,
    });
  });

  it("cross-checks rubric hard failures locally instead of trusting a model false", () => {
    const result = visualResult({
      overallScore: 99,
      hasHardFailure: false,
      checks: FINAL_RUBRIC.map((criterion) => ({
        name: criterion.name,
        passed: criterion.name !== "BLACK_OR_FROZEN_FRAMES",
        score: criterion.name === "BLACK_OR_FROZEN_FRAMES" ? 20 : 99,
        ...(criterion.name === "BLACK_OR_FROZEN_FRAMES"
          ? { severity: "soft" as const, reason: "Frozen sequence." }
          : {}),
      })),
    });
    expect(decideFinalQa({ deterministic: deterministicPass, visual: result }).decision).toBe(
      "HUMAN_REVIEW",
    );
  });

  it("maps malformed or incomplete sampled-frame output to FAILED", () => {
    const malformed = visualResult({ checks: visualResult().checks.slice(1) });
    expect(decideFinalQa({ deterministic: deterministicPass, visual: malformed })).toMatchObject({
      decision: "FAILED",
      score: null,
    });
  });

  it("maps provider or pipeline failure to FAILED", () => {
    expect(
      decideFinalQa({ deterministic: deterministicPass, visual: null, failure: "provider timeout" }),
    ).toEqual({
      decision: "FAILED",
      score: null,
      verdict: "Final QA infrastructure failure: provider timeout",
      deterministic: deterministicPass,
      visual: null,
    });
  });
});
