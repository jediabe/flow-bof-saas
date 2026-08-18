import { describe, it, expect } from "vitest";
import {
  RUBRIC,
  computeHasHardFailure,
  findRubricCriterion,
  isHardFailure,
} from "../rubric";
import type { RubricCriterionName } from "../types";

describe("RUBRIC data", () => {
  it("has exactly 10 criteria", () => {
    expect(RUBRIC).toHaveLength(10);
  });

  it("has unique criterion names", () => {
    const names = RUBRIC.map((c) => c.name);
    expect(new Set(names).size).toBe(RUBRIC.length);
  });

  it("categorises 'always' hard failures correctly", () => {
    // Product presence and stability are the two show-stopper
    // criteria — always hard-fail.
    const alwaysNames = RUBRIC.filter((c) => c.hardFailureCategory === "always")
      .map((c) => c.name)
      .sort();
    expect(alwaysNames).toEqual(["PRODUCT_PRESENT", "PRODUCT_STABILITY"]);
  });

  it("categorises 'never' hard failures correctly (soft-quality-only)", () => {
    const neverNames = RUBRIC.filter((c) => c.hardFailureCategory === "never")
      .map((c) => c.name)
      .sort();
    expect(neverNames).toEqual([
      "MOTION_REALISM",
      "PHONE_FOOTAGE_REALISM",
      "SCENE_APPROPRIATENESS",
    ]);
  });
});

describe("findRubricCriterion", () => {
  it("returns the criterion by name", () => {
    expect(findRubricCriterion("PRODUCT_PRESENT")?.name).toBe("PRODUCT_PRESENT");
  });
  it("returns undefined for unknown name", () => {
    expect(findRubricCriterion("NOT_A_CRITERION")).toBeUndefined();
  });
});

describe("isHardFailure", () => {
  it("returns false for passed checks", () => {
    expect(
      isHardFailure({ name: "PRODUCT_PRESENT", passed: true }),
    ).toBe(false);
  });

  it("returns false for unknown criterion names", () => {
    expect(
      isHardFailure({ name: "UNKNOWN", passed: false, severity: "critical" }),
    ).toBe(false);
  });

  it("returns true when an 'always' criterion fails at any severity", () => {
    for (const sev of ["soft", "major", "critical"] as const) {
      expect(
        isHardFailure({ name: "PRODUCT_PRESENT", passed: false, severity: sev }),
      ).toBe(true);
    }
  });

  it("returns true when 'always' criterion fails with no severity", () => {
    expect(
      isHardFailure({ name: "PRODUCT_STABILITY", passed: false }),
    ).toBe(true);
  });

  it("returns true for 'if_major' at severity major or critical", () => {
    expect(
      isHardFailure({ name: "LABEL_INTEGRITY", passed: false, severity: "major" }),
    ).toBe(true);
    expect(
      isHardFailure({
        name: "HAND_ANATOMY",
        passed: false,
        severity: "critical",
      }),
    ).toBe(true);
  });

  it("returns false for 'if_major' at severity soft", () => {
    expect(
      isHardFailure({
        name: "LABEL_INTEGRITY",
        passed: false,
        severity: "soft",
      }),
    ).toBe(false);
  });

  it("treats missing severity on 'if_major' as major (conservative)", () => {
    expect(
      isHardFailure({ name: "TEXT_INTEGRITY", passed: false }),
    ).toBe(true);
  });

  it("never returns true for 'never' criteria", () => {
    const neverCriteria: RubricCriterionName[] = [
      "SCENE_APPROPRIATENESS",
      "PHONE_FOOTAGE_REALISM",
      "MOTION_REALISM",
    ];
    for (const name of neverCriteria) {
      for (const sev of ["soft", "major", "critical"] as const) {
        expect(
          isHardFailure({ name, passed: false, severity: sev }),
        ).toBe(false);
      }
    }
  });
});

describe("computeHasHardFailure", () => {
  it("returns false on all-passing checks", () => {
    expect(
      computeHasHardFailure([
        { name: "PRODUCT_PRESENT", passed: true },
        { name: "PRODUCT_STABILITY", passed: true },
      ]),
    ).toBe(false);
  });

  it("returns true on any 'always' criterion failing", () => {
    expect(
      computeHasHardFailure([
        { name: "PRODUCT_PRESENT", passed: false, severity: "soft" },
        { name: "PRODUCT_STABILITY", passed: true },
      ]),
    ).toBe(true);
  });

  it("returns true when a 'never' criterion fails at severity critical", () => {
    // Critical severity always hard-fails, regardless of the
    // criterion's own hardFailureCategory. This is the "trust
    // the stricter signal" rule.
    expect(
      computeHasHardFailure([
        {
          name: "SCENE_APPROPRIATENESS",
          passed: false,
          severity: "critical",
        },
      ]),
    ).toBe(true);
  });

  it("returns false when 'never' criteria fail at severity <= major", () => {
    expect(
      computeHasHardFailure([
        { name: "SCENE_APPROPRIATENESS", passed: false, severity: "major" },
        { name: "PHONE_FOOTAGE_REALISM", passed: false, severity: "soft" },
      ]),
    ).toBe(false);
  });

  it("returns true on 'if_major' at severity major", () => {
    expect(
      computeHasHardFailure([
        { name: "LABEL_INTEGRITY", passed: false, severity: "major" },
      ]),
    ).toBe(true);
  });

  it("returns false when only soft 'if_major' failures", () => {
    expect(
      computeHasHardFailure([
        { name: "LABEL_INTEGRITY", passed: false, severity: "soft" },
        { name: "HAND_ANATOMY", passed: false, severity: "soft" },
      ]),
    ).toBe(false);
  });

  it("handles empty checks array", () => {
    expect(computeHasHardFailure([])).toBe(false);
  });
});
