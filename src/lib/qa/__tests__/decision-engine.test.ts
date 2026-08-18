import { describe, it, expect } from "vitest";
import { decide } from "../decision-engine";
import { DEFAULT_QA_CONFIG } from "../config";
import type { VisualQaResult } from "../schema";

// Factory: build a QA result with sensible defaults so each
// test can vary only the field under scrutiny.
function result(overrides: Partial<VisualQaResult> = {}): VisualQaResult {
  return {
    overallScore: 90,
    hasHardFailure: false,
    checks: [
      { name: "PRODUCT_PRESENT", passed: true, score: 95 },
      { name: "PRODUCT_STABILITY", passed: true, score: 95 },
      { name: "LABEL_INTEGRITY", passed: true, score: 90 },
    ],
    issues: [],
    ...overrides,
  };
}

describe("decide — malformed / missing input", () => {
  it("routes null result to HUMAN_REVIEW without throwing", () => {
    const out = decide({ result: null, attemptNumber: 1 });
    expect(out.decision).toBe("HUMAN_REVIEW");
    expect(out.reason).toMatch(/no parseable result/i);
    expect(out.attemptsExhausted).toBe(false);
  });
});

describe("decide — APPROVE path", () => {
  it("approves a clean high-score result with zero issues", () => {
    const out = decide({ result: result(), attemptNumber: 1 });
    expect(out.decision).toBe("APPROVE");
    expect(out.triggeringIssues).toHaveLength(0);
  });

  it("approves exactly at APPROVE_SCORE_THRESHOLD (80)", () => {
    const out = decide({
      result: result({ overallScore: DEFAULT_QA_CONFIG.APPROVE_SCORE_THRESHOLD }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("APPROVE");
  });

  it("approves with soft issues present", () => {
    const out = decide({
      result: result({
        issues: [
          {
            type: "slightly_dim",
            severity: "soft",
            description: "Room lighting is a touch flat.",
          },
        ],
      }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("APPROVE");
  });

  it("does NOT approve when a major issue is present even at high score", () => {
    const out = decide({
      result: result({
        overallScore: 92,
        issues: [
          {
            type: "warp",
            severity: "major",
            description: "Label warps briefly at 3s.",
          },
        ],
      }),
      attemptNumber: 1,
    });
    expect(out.decision).not.toBe("APPROVE");
    expect(out.decision).toBe("HUMAN_REVIEW");
    expect(out.triggeringIssues).toHaveLength(1);
  });
});

describe("decide — hard failure → REGENERATE", () => {
  it("regenerates when model-reported hasHardFailure is true", () => {
    const out = decide({
      result: result({ overallScore: 88, hasHardFailure: true }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("REGENERATE");
    expect(out.reason).toMatch(/hard failure/i);
    expect(out.attemptsExhausted).toBe(false);
  });

  it("regenerates when a critical issue is reported", () => {
    const out = decide({
      result: result({
        overallScore: 82,
        issues: [
          {
            type: "product_missing",
            severity: "critical",
            description: "Product is absent from every frame.",
          },
        ],
      }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("REGENERATE");
    expect(out.triggeringIssues).toHaveLength(1);
    expect(out.triggeringIssues[0]?.severity).toBe("critical");
  });

  it("locally computes a hard failure even if the model missed it", () => {
    // Model says overall score 95 and hasHardFailure=false — but
    // PRODUCT_STABILITY (always-hard) is marked failed. Engine
    // should trust the stricter local computation.
    const out = decide({
      result: result({
        overallScore: 95,
        hasHardFailure: false,
        checks: [
          { name: "PRODUCT_PRESENT", passed: true, score: 100 },
          {
            name: "PRODUCT_STABILITY",
            passed: false,
            score: 20,
            severity: "soft",
          },
        ],
      }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("REGENERATE");
  });

  it("synthesises triggering issues from failed checks when the issues array is empty", () => {
    const out = decide({
      result: result({
        overallScore: 70,
        hasHardFailure: true,
        checks: [
          {
            name: "PRODUCT_PRESENT",
            passed: false,
            score: 10,
            severity: "critical",
            reason: "Product not visible.",
          },
        ],
        issues: [],
      }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("REGENERATE");
    expect(out.triggeringIssues.length).toBeGreaterThan(0);
    expect(out.triggeringIssues[0]?.type).toBe("PRODUCT_PRESENT");
  });
});

describe("decide — low score → REGENERATE", () => {
  it("regenerates at score 30 with no explicit hard failure flag", () => {
    const out = decide({
      result: result({ overallScore: 30 }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("REGENERATE");
    expect(out.reason).toMatch(/< 60/);
  });

  it("regenerates strictly below REGEN_SCORE_THRESHOLD (score 59)", () => {
    const out = decide({
      result: result({
        overallScore: DEFAULT_QA_CONFIG.REGEN_SCORE_THRESHOLD - 1,
      }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("REGENERATE");
  });
});

describe("decide — ambiguous band → HUMAN_REVIEW", () => {
  it("routes exactly-at REGEN_SCORE_THRESHOLD (60) to HUMAN_REVIEW (asymmetric boundary)", () => {
    const out = decide({
      result: result({
        overallScore: DEFAULT_QA_CONFIG.REGEN_SCORE_THRESHOLD,
      }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("HUMAN_REVIEW");
  });

  it("routes the middle band (score 70) to HUMAN_REVIEW", () => {
    const out = decide({
      result: result({ overallScore: 70 }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("HUMAN_REVIEW");
    expect(out.reason).toMatch(/ambiguous band/);
  });

  it("routes score 79 (just below approve threshold) to HUMAN_REVIEW", () => {
    const out = decide({
      result: result({
        overallScore: DEFAULT_QA_CONFIG.APPROVE_SCORE_THRESHOLD - 1,
      }),
      attemptNumber: 1,
    });
    expect(out.decision).toBe("HUMAN_REVIEW");
  });
});

describe("decide — max-attempts guard", () => {
  it("downgrades REGENERATE to HUMAN_REVIEW at MAX_REPAIR_ATTEMPTS", () => {
    const out = decide({
      result: result({ overallScore: 20 }),
      attemptNumber: DEFAULT_QA_CONFIG.MAX_REPAIR_ATTEMPTS,
    });
    expect(out.decision).toBe("HUMAN_REVIEW");
    expect(out.attemptsExhausted).toBe(true);
    expect(out.reason).toMatch(/Attempts exhausted/);
  });

  it("downgrades hard-failure REGENERATE at MAX_REPAIR_ATTEMPTS", () => {
    const out = decide({
      result: result({ overallScore: 40, hasHardFailure: true }),
      attemptNumber: 3,
    });
    expect(out.decision).toBe("HUMAN_REVIEW");
    expect(out.attemptsExhausted).toBe(true);
  });

  it("allows REGENERATE at attempt just below the ceiling (attempt 2 with MAX=3)", () => {
    const out = decide({
      result: result({ overallScore: 30 }),
      attemptNumber: DEFAULT_QA_CONFIG.MAX_REPAIR_ATTEMPTS - 1,
    });
    expect(out.decision).toBe("REGENERATE");
    expect(out.attemptsExhausted).toBe(false);
  });

  it("does NOT downgrade APPROVE at max attempts (guard only touches REGENERATE)", () => {
    const out = decide({
      result: result({ overallScore: 95 }),
      attemptNumber: DEFAULT_QA_CONFIG.MAX_REPAIR_ATTEMPTS,
    });
    expect(out.decision).toBe("APPROVE");
    expect(out.attemptsExhausted).toBe(false);
  });

  it("does NOT downgrade HUMAN_REVIEW at max attempts (already terminal)", () => {
    const out = decide({
      result: result({ overallScore: 70 }),
      attemptNumber: DEFAULT_QA_CONFIG.MAX_REPAIR_ATTEMPTS,
    });
    expect(out.decision).toBe("HUMAN_REVIEW");
    expect(out.attemptsExhausted).toBe(false);
  });
});

describe("decide — config overrides", () => {
  it("respects a tighter APPROVE_SCORE_THRESHOLD", () => {
    const out = decide({
      result: result({ overallScore: 85 }),
      attemptNumber: 1,
      config: { APPROVE_SCORE_THRESHOLD: 90 },
    });
    // 85 is now below the override threshold → not APPROVE.
    expect(out.decision).toBe("HUMAN_REVIEW");
  });

  it("respects a looser MAX_REPAIR_ATTEMPTS", () => {
    const out = decide({
      result: result({ overallScore: 30 }),
      attemptNumber: 3,
      config: { MAX_REPAIR_ATTEMPTS: 5 },
    });
    expect(out.decision).toBe("REGENERATE");
    expect(out.attemptsExhausted).toBe(false);
  });

  it("does not mutate the caller's config object", () => {
    const overrides = { APPROVE_SCORE_THRESHOLD: 95 };
    decide({ result: result(), attemptNumber: 1, config: overrides });
    expect(overrides).toEqual({ APPROVE_SCORE_THRESHOLD: 95 });
  });
});

describe("decide — output shape", () => {
  it("always populates a non-empty reason string", () => {
    const scenarios: Array<{ result: VisualQaResult | null; attempt: number }> = [
      { result: null, attempt: 1 },
      { result: result(), attempt: 1 },
      { result: result({ overallScore: 30 }), attempt: 1 },
      { result: result({ overallScore: 70 }), attempt: 1 },
      { result: result({ hasHardFailure: true }), attempt: 1 },
      { result: result({ hasHardFailure: true }), attempt: 3 },
    ];
    for (const s of scenarios) {
      const out = decide({ result: s.result, attemptNumber: s.attempt });
      expect(out.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns APPROVE with empty triggeringIssues", () => {
    const out = decide({ result: result(), attemptNumber: 1 });
    expect(out.decision).toBe("APPROVE");
    expect(out.triggeringIssues).toHaveLength(0);
  });
});
