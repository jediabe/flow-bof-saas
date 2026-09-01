import type { FinalRubricCriterion } from "./final-rubric";

export interface FinalQaPromptInput {
  productName: string;
  market: string;
  expectedClipOrder: readonly string[];
  frameTimestampsMs: readonly number[];
  deterministicSummary: string;
}

export function buildFinalQaSystemPrompt(rubric: readonly FinalRubricCriterion[]): string {
  const criteria = rubric
    .map((criterion) => `- ${criterion.name}: ${criterion.summary} Evidence: ${criterion.evidence}.`)
    .join("\n");
  return `You are a QA evaluator for a final assembled output intended for TikTok Shop.
Evaluate only the supplied final-output evidence. Report observations; do not choose lifecycle transitions.
Return exactly one JSON object using the same score/check/issue concepts as the visual QA schema: overallScore, hasHardFailure, checks, and issues. Emit one check for every exact criterion name.
Do not propose regeneration or other repair actions. Do not infer speech words.

Final-output rubric:\n${criteria}`;
}

export function buildFinalQaUserText(input: FinalQaPromptInput): string {
  return [
    `Product: ${input.productName}`,
    `Market: ${input.market.toUpperCase()}`,
    `Expected clip order: ${input.expectedClipOrder.join(" -> ")}`,
    `Sampled final-frame timestamps: ${input.frameTimestampsMs.map((value) => `${value}ms`).join(", ")}`,
    `Injected deterministic media analysis: ${input.deterministicSummary}`,
    "Use the sampled frames for visual criteria and the injected analysis for audio criteria.",
    "Return structured JSON only.",
  ].join("\n");
}
