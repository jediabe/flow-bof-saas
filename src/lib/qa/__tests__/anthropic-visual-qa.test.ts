import { describe, it, expect } from "vitest";
import { stripJsonFences } from "../providers/anthropic-visual-qa";

// The Anthropic provider integration (message.create, error
// wrapping) is exercised through the orchestrator tests where
// we inject a fake VisualQaProvider. This file pins the pure
// fence-stripping helper — a regression there silently converts
// clean model output into ProviderValidationError so it's worth
// its own suite.

describe("stripJsonFences", () => {
  it("passes plain JSON through unchanged", () => {
    const input = '{"overallScore":90}';
    expect(stripJsonFences(input)).toBe(input);
  });

  it("strips ```json ... ``` fence", () => {
    const input = '```json\n{"overallScore":90}\n```';
    expect(stripJsonFences(input)).toBe('{"overallScore":90}');
  });

  it("strips bare ``` ... ``` fence", () => {
    const input = '```\n{"a":1}\n```';
    expect(stripJsonFences(input)).toBe('{"a":1}');
  });

  it("strips fence with trailing/leading whitespace", () => {
    const input = "  ```json\n  {\"a\":1}\n  ```  ";
    expect(stripJsonFences(input).trim()).toBe('{"a":1}');
  });

  it("extracts JSON block when prose surrounds it", () => {
    const input =
      'Here is my evaluation: {"overallScore":80,"checks":[]} — hope that helps!';
    expect(stripJsonFences(input)).toBe(
      '{"overallScore":80,"checks":[]}',
    );
  });

  it("handles multi-line JSON with prose prefix", () => {
    const input = `I have evaluated the asset.
{
  "overallScore": 70
}`;
    expect(stripJsonFences(input)).toBe(`{
  "overallScore": 70
}`);
  });

  it("returns trimmed input when no fence or braces present (schema layer catches it)", () => {
    // The extractor's job is just to strip common wrappers.
    // Unparseable text is passed through and the Zod validator
    // in the schema layer produces ProviderValidationError.
    expect(stripJsonFences("this is not json at all")).toBe(
      "this is not json at all",
    );
  });

  it("case-insensitive on JSON fence tag", () => {
    const input = '```JSON\n{"a":1}\n```';
    expect(stripJsonFences(input)).toBe('{"a":1}');
  });
});
