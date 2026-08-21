import { describe, expect, it } from "vitest";
import {
  HERMES_CONTENT_TOOL_NAMES,
  HERMES_CONTENT_TOOL_SCHEMAS,
} from "../schemas";

const style1CompilerInput = {
  styleId: "style1" as const,
  version: "managed-style1-v1" as const,
  variant: "store_discovery" as const,
  productReferenceImageId: "image_1",
  style1Kit: {
    productName: "Example product",
    market: "UK" as const,
    category: "Home/Storage",
    copy: {
      part1Options: ["This is an approved opening option with enough words."],
      part2Options: ["This is an approved closing option with enough words."],
      part3Options: ["Approved sale copy"],
    },
    hashtags: ["#AIGC"],
    productDescription: "Example description",
    discountPercent: 20,
    warnings: [],
  },
  chosenPart1: "This is an approved opening option with enough words.",
  chosenPart2: "This is an approved closing option with enough words.",
};

describe("Hermes managed content tool schemas", () => {
  it("exposes only the exact approved tool names", () => {
    expect(HERMES_CONTENT_TOOL_NAMES).toEqual([
      "content_get_product",
      "content_create_run",
      "content_generate_image",
      "content_generate_video",
      "content_run_qa",
      "content_run_final_output",
      "content_get_run",
    ]);
    expect(Object.keys(HERMES_CONTENT_TOOL_SCHEMAS)).toEqual(HERMES_CONTENT_TOOL_NAMES);
  });

  it("accepts a strict Style 1 create command and rejects actor or provider control fields", () => {
    const command = {
      productId: "product_1",
      style: "style1",
      idempotencyKey: "create_1",
      videoModel: "veo-3.1-lite",
      compilerInput: style1CompilerInput,
    };
    expect(HERMES_CONTENT_TOOL_SCHEMAS.content_create_run.parse(command)).toEqual(command);

    for (const forbidden of ["workspaceId", "flowEmail", "apiKey", "status", "qaDecision", "prompt"]) {
      expect(() => HERMES_CONTENT_TOOL_SCHEMAS.content_create_run.parse({
        ...command,
        [forbidden]: "forbidden",
      })).toThrow();
    }
  });

  it("requires style identity to match the strict compiler input", () => {
    expect(() => HERMES_CONTENT_TOOL_SCHEMAS.content_create_run.parse({
      productId: "product_1",
      style: "style2",
      idempotencyKey: "create_1",
      compilerInput: style1CompilerInput,
    })).toThrow(/style/i);
  });

  it("keeps generation, QA, final-output, and read commands action-oriented and strict", () => {
    const accepted = {
      content_get_product: { productId: "product_1" },
      content_generate_image: { contentRunId: "run_1", idempotencyKey: "image_1" },
      content_generate_video: { contentRunId: "run_1", idempotencyKey: "video_1" },
      content_run_qa: { contentRunId: "run_1" },
      content_run_final_output: { contentRunId: "run_1", idempotencyKey: "final_1" },
      content_get_run: { contentRunId: "run_1" },
    } as const;

    for (const [name, input] of Object.entries(accepted)) {
      const schema = HERMES_CONTENT_TOOL_SCHEMAS[name as keyof typeof accepted];
      expect(schema.parse(input)).toEqual(input);
      expect(() => schema.parse({ ...input, workspaceId: "workspace_other" })).toThrow();
      expect(() => schema.parse({ ...input, prompt: "raw provider prompt" })).toThrow();
    }
  });
});
