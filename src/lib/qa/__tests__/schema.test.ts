import { describe, it, expect } from "vitest";
import {
  parseVisualQaResult,
  QaCheckSchema,
  QaIssueSchema,
  VisualQaResultSchema,
  type VisualQaResult,
} from "../schema";

// Reusable factory for a well-formed VisualQaResult. Tests use
// `overrides` to break exactly one field at a time, which keeps
// each assertion honest about what it's testing.
function validResult(overrides: Partial<VisualQaResult> = {}): VisualQaResult {
  return {
    overallScore: 90,
    hasHardFailure: false,
    checks: [
      { name: "PRODUCT_PRESENT", passed: true, score: 95 },
      { name: "PRODUCT_FIDELITY", passed: true, score: 92 },
    ],
    issues: [],
    ...overrides,
  };
}

describe("QaCheckSchema", () => {
  it("accepts a minimal valid check", () => {
    expect(
      QaCheckSchema.safeParse({
        name: "PRODUCT_PRESENT",
        passed: true,
        score: 100,
      }).success,
    ).toBe(true);
  });

  it("accepts optional severity/reason/frameTimestampMs", () => {
    expect(
      QaCheckSchema.safeParse({
        name: "HAND_ANATOMY",
        passed: false,
        score: 30,
        severity: "critical",
        reason: "fused fingers",
        frameTimestampMs: 5200,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown criterion name", () => {
    const result = QaCheckSchema.safeParse({
      name: "MADE_UP_CRITERION",
      passed: true,
      score: 100,
    });
    expect(result.success).toBe(false);
  });

  it("rejects score < 0 or > 100", () => {
    expect(
      QaCheckSchema.safeParse({
        name: "PRODUCT_PRESENT",
        passed: true,
        score: -1,
      }).success,
    ).toBe(false);
    expect(
      QaCheckSchema.safeParse({
        name: "PRODUCT_PRESENT",
        passed: true,
        score: 101,
      }).success,
    ).toBe(false);
  });

  it("rejects non-integer scores", () => {
    expect(
      QaCheckSchema.safeParse({
        name: "PRODUCT_PRESENT",
        passed: true,
        score: 85.5,
      }).success,
    ).toBe(false);
  });

  it("rejects negative frameTimestampMs", () => {
    expect(
      QaCheckSchema.safeParse({
        name: "PRODUCT_PRESENT",
        passed: true,
        score: 90,
        frameTimestampMs: -5,
      }).success,
    ).toBe(false);
  });
});

describe("QaIssueSchema", () => {
  it("accepts a minimal valid issue", () => {
    expect(
      QaIssueSchema.safeParse({
        type: "label_warp",
        severity: "major",
        description: "The product label warps at 5.2s.",
      }).success,
    ).toBe(true);
  });

  it("requires description and type to be non-empty", () => {
    expect(
      QaIssueSchema.safeParse({
        type: "",
        severity: "major",
        description: "x",
      }).success,
    ).toBe(false);
    expect(
      QaIssueSchema.safeParse({
        type: "warp",
        severity: "major",
        description: "",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid severity", () => {
    expect(
      QaIssueSchema.safeParse({
        type: "warp",
        severity: "extreme",
        description: "x",
      }).success,
    ).toBe(false);
  });
});

describe("VisualQaResultSchema", () => {
  it("accepts a canonical happy-path result", () => {
    expect(VisualQaResultSchema.safeParse(validResult()).success).toBe(true);
  });

  it("rejects empty checks array (min 1)", () => {
    const bad = VisualQaResultSchema.safeParse({
      overallScore: 90,
      hasHardFailure: false,
      checks: [],
      issues: [],
    });
    expect(bad.success).toBe(false);
  });

  it("accepts empty issues array (no defects is valid)", () => {
    expect(
      VisualQaResultSchema.safeParse(validResult({ issues: [] })).success,
    ).toBe(true);
  });

  it("rejects overallScore out of range", () => {
    expect(
      VisualQaResultSchema.safeParse(validResult({ overallScore: -1 })).success,
    ).toBe(false);
    expect(
      VisualQaResultSchema.safeParse(validResult({ overallScore: 101 })).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    // No overallScore.
    expect(
      VisualQaResultSchema.safeParse({
        hasHardFailure: false,
        checks: [{ name: "PRODUCT_PRESENT", passed: true, score: 100 }],
        issues: [],
      }).success,
    ).toBe(false);
    // No hasHardFailure.
    expect(
      VisualQaResultSchema.safeParse({
        overallScore: 90,
        checks: [{ name: "PRODUCT_PRESENT", passed: true, score: 100 }],
        issues: [],
      }).success,
    ).toBe(false);
  });

  it("tolerates unknown extra fields (does not `.strict()`)", () => {
    // Model may add a confidence / rationale it invented; we
    // strip rather than reject so future additions don't break
    // the pipeline. Behaviour pinned so a future .strict()
    // change is a conscious decision, not a drive-by.
    const withExtras = {
      ...validResult(),
      confidence: 0.87,
      rationale: "The scene looks fine.",
    };
    const parsed = VisualQaResultSchema.safeParse(withExtras);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Extra fields are stripped from the parsed output.
      expect((parsed.data as Record<string, unknown>).confidence).toBeUndefined();
    }
  });
});

describe("parseVisualQaResult", () => {
  it("returns ok:true on a valid object", () => {
    const result = parseVisualQaResult(validResult());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.overallScore).toBe(90);
  });

  it("returns ok:true on a valid JSON string", () => {
    const result = parseVisualQaResult(JSON.stringify(validResult()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.overallScore).toBe(90);
  });

  it("returns ok:false on null", () => {
    const result = parseVisualQaResult(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/null or undefined/);
  });

  it("returns ok:false on undefined", () => {
    const result = parseVisualQaResult(undefined);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false on malformed JSON string without throwing", () => {
    const result = parseVisualQaResult("{overallScore: not-json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not valid JSON/);
  });

  it("returns ok:false with issue detail on schema violation", () => {
    const result = parseVisualQaResult({
      overallScore: 200,
      hasHardFailure: false,
      checks: [{ name: "PRODUCT_PRESENT", passed: true, score: 90 }],
      issues: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/schema validation/);
      expect(result.issues).toBeDefined();
    }
  });

  it("returns ok:false on primitive input (number)", () => {
    expect(parseVisualQaResult(42).ok).toBe(false);
  });

  it("never throws — even on wildly malformed input", () => {
    // Exercise a variety of shapes the model might produce.
    const inputs = [
      "",
      "null",
      "[]",
      "0",
      "false",
      Symbol("qa") as unknown,
      new Date() as unknown,
      { a: { b: { c: {} } } },
    ];
    for (const input of inputs) {
      // The point of this test is the absence of a throw.
      expect(() => parseVisualQaResult(input)).not.toThrow();
    }
  });
});
