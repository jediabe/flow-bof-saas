import { z } from "zod";
import type { Severity } from "./types";
import type { FinalMediaValidationResult } from "./final-media-validation";

export type FinalRubricCriterionName =
  | "VISUAL_CONTINUITY"
  | "BLACK_OR_FROZEN_FRAMES"
  | "CLIP_BOUNDARIES_AND_ORDER"
  | "VOICEOVER_NATIVE_AUDIO_BALANCE"
  | "AUDIBLE_NARRATION"
  | "AUDIO_CLIPPING_OR_SILENCE"
  | "OUTPUT_SUITABILITY";

export interface FinalRubricCriterion {
  name: FinalRubricCriterionName;
  summary: string;
  evidence: "sampled_frames" | "deterministic_audio" | "combined";
  hardFailureCategory: "always" | "if_major" | "never";
}

export const FINAL_RUBRIC: readonly FinalRubricCriterion[] = [
  {
    name: "VISUAL_CONTINUITY",
    summary: "Visual identity, product state, lighting, and motion remain coherent across the assembled output.",
    evidence: "sampled_frames",
    hardFailureCategory: "if_major",
  },
  {
    name: "BLACK_OR_FROZEN_FRAMES",
    summary: "No black, blank, duplicated-frozen, or otherwise unusable frame sequences are visible.",
    evidence: "sampled_frames",
    hardFailureCategory: "always",
  },
  {
    name: "CLIP_BOUNDARIES_AND_ORDER",
    summary: "Clip boundaries are clean and the sampled sequence follows the exact expected clip order.",
    evidence: "combined",
    hardFailureCategory: "always",
  },
  {
    name: "VOICEOVER_NATIVE_AUDIO_BALANCE",
    summary: "Voiceover is foregrounded while native clip audio remains appropriately ducked or muted.",
    evidence: "deterministic_audio",
    hardFailureCategory: "if_major",
  },
  {
    name: "AUDIBLE_NARRATION",
    summary: "The final audio stream contains audible narration throughout the intended narration span.",
    evidence: "deterministic_audio",
    hardFailureCategory: "always",
  },
  {
    name: "AUDIO_CLIPPING_OR_SILENCE",
    summary: "The injected FFmpeg analysis reports no clipping or excessive leading or trailing silence.",
    evidence: "deterministic_audio",
    hardFailureCategory: "always",
  },
  {
    name: "OUTPUT_SUITABILITY",
    summary: "The complete portrait output is coherent, legible, and suitable for manual TikTok upload.",
    evidence: "combined",
    hardFailureCategory: "never",
  },
] as const;

export interface FinalQaCheck {
  name: FinalRubricCriterionName;
  passed: boolean;
  score: number;
  severity?: Severity;
  reason?: string;
  frameTimestampMs?: number;
}

export interface FinalQaIssue {
  type: string;
  severity: Severity;
  description: string;
  frameTimestampMs?: number;
}

export interface FinalVisualQaResult {
  overallScore: number;
  hasHardFailure: boolean;
  checks: readonly FinalQaCheck[];
  issues: readonly FinalQaIssue[];
}

const FinalCriterionNameSchema = z.enum(FINAL_RUBRIC.map((criterion) => criterion.name));
const FinalSeveritySchema = z.enum(["soft", "major", "critical"]);

export const FinalVisualQaResultSchema = z
  .object({
    overallScore: z.number().int().min(0).max(100),
    hasHardFailure: z.boolean(),
    checks: z
      .array(
        z
          .object({
            name: FinalCriterionNameSchema,
            passed: z.boolean(),
            score: z.number().int().min(0).max(100),
            severity: FinalSeveritySchema.optional(),
            reason: z.string().min(1).optional(),
            frameTimestampMs: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .length(FINAL_RUBRIC.length),
    issues: z.array(
      z
        .object({
          type: z.string().min(1),
          severity: FinalSeveritySchema,
          description: z.string().min(1),
          frameTimestampMs: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((result, context) => {
    const names = result.checks.map((check) => check.name);
    if (new Set(names).size !== FINAL_RUBRIC.length) {
      context.addIssue({
        code: "custom",
        path: ["checks"],
        message: "checks must contain every final rubric criterion exactly once",
      });
    }
  });

/** Provider-neutral result persisted by later lifecycle integration. */
export interface FinalQaEvaluation {
  decision: "APPROVE" | "HUMAN_REVIEW" | "FAILED";
  score: number | null;
  verdict: string;
  deterministic: FinalMediaValidationResult;
  visual: FinalVisualQaResult | null;
  providerModel?: string;
  elapsedMs?: number;
}

export interface FinalQaDecisionInput {
  deterministic: FinalMediaValidationResult;
  visual: FinalVisualQaResult | null;
  failure?: string;
  providerModel?: string;
  elapsedMs?: number;
  approveScoreThreshold?: number;
}

export function decideFinalQa(input: FinalQaDecisionInput): FinalQaEvaluation {
  const diagnostics = {
    ...(input.providerModel ? { providerModel: input.providerModel } : {}),
    ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
  };
  if (input.failure || !input.visual) {
    return {
      decision: "FAILED",
      score: null,
      verdict: `Final QA infrastructure failure: ${input.failure ?? "no visual result"}`,
      deterministic: input.deterministic,
      visual: null,
      ...diagnostics,
    };
  }
  const parsedVisual = FinalVisualQaResultSchema.safeParse(input.visual);
  if (!parsedVisual.success) {
    return {
      decision: "FAILED",
      score: null,
      verdict: "Final QA infrastructure failure: malformed sampled-frame result",
      deterministic: input.deterministic,
      visual: null,
      ...diagnostics,
    };
  }
  const visual = parsedVisual.data;
  if (!input.deterministic.passed) {
    const codes = input.deterministic.failures.map((failure) => failure.code).join(", ");
    return {
      decision: "HUMAN_REVIEW",
      score: visual.overallScore,
      verdict: `Deterministic final-media gates failed: ${codes}.`,
      deterministic: input.deterministic,
      visual,
      ...diagnostics,
    };
  }

  const blockingCheck = visual.checks.some((check) => {
    if (check.passed) return false;
    if (check.severity === "critical") return true;
    const criterion = FINAL_RUBRIC.find((candidate) => candidate.name === check.name);
    if (!criterion) return true;
    if (criterion.hardFailureCategory === "always") return true;
    if (criterion.hardFailureCategory === "if_major") {
      return check.severity === undefined || check.severity === "major";
    }
    return check.severity === "major";
  });
  const threshold = input.approveScoreThreshold ?? 80;
  const approved = visual.overallScore >= threshold && !visual.hasHardFailure && !blockingCheck;
  return {
    decision: approved ? "APPROVE" : "HUMAN_REVIEW",
    score: visual.overallScore,
    verdict: approved
      ? "Final deterministic and sampled-frame QA approved."
      : "Final sampled-frame QA requires human review.",
    deterministic: input.deterministic,
    visual,
    ...diagnostics,
  };
}
