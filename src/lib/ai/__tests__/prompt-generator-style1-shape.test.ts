import { describe, it, expect } from "vitest";
import { normaliseAiOutput } from "../prompt-generator";
import type { ProductPromptInput } from "../types";

// Regression tests for the "generated before Style 1" false-negative.
//
// Symptom operators saw: some product cards showed the red banner
//   "This product was generated before Style 1. Regenerate the
//    batch on the desktop to get the full Style 1 kit …"
// even though the batch WAS a Style-1 run.
//
// Root cause: the shape detector in normaliseAiOutput demanded
//   typeof r.productName === "string"  &&  typeof r.category === "string"
// at the TOP LEVEL of the LLM response. When the model emitted
// product_name (snake_case) or omitted category — both of which
// normaliseStyle1Output itself already tolerates via fallbacks —
// the detector fell through to the legacy path and left
// output.style1KitJson unset. Product.style1Kit then stayed null
// and parseStyle1Kit later returned null, triggering the banner.
//
// These tests pin the tolerant detection so future edits to the
// shape check don't silently re-narrow it.

const INPUT: ProductPromptInput = {
  productName: "Sample Product",
  originalTitle: "Sample Product",
  category: "beauty",
  retailerName: null,
  tiktokUrl: null,
  referenceImageUrl: null,
  market: "uk",
  discountPercent: null,
  discountType: null,
};

function style1Response(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    productName: "Sample Product",
    category: "beauty",
    copy: {
      part1Options: ["hook a", "hook b", "hook c", "hook d", "hook e"],
      part2Options: ["mid a", "mid b", "mid c", "mid d", "mid e"],
      part3Options: ["cta a", "cta b", "cta c", "cta d", "cta e"],
    },
    hashtags: ["#one", "#two"],
    ...overrides,
  };
}

describe("normaliseAiOutput — Style 1 shape detection", () => {
  it("recognises the canonical productName + category + copy shape", () => {
    const out = normaliseAiOutput(style1Response(), INPUT);
    expect(out.style1KitJson).toBeTruthy();
  });

  it("REGRESSION: recognises Style 1 even when top-level uses product_name (snake_case)", () => {
    // This was the bug. Model emitted product_name; the detector
    // required productName; response fell through to the legacy
    // path and style1KitJson stayed unset.
    const out = normaliseAiOutput(
      {
        product_name: "Sample Product",
        category: "beauty",
        copy: {
          part1Options: ["hook a", "hook b", "hook c", "hook d", "hook e"],
        },
      },
      INPUT,
    );
    expect(out.style1KitJson).toBeTruthy();
  });

  it("REGRESSION: recognises Style 1 when category is missing (falls back to input.category)", () => {
    const r = style1Response();
    delete r.category;
    const out = normaliseAiOutput(r, INPUT);
    expect(out.style1KitJson).toBeTruthy();
  });

  it("REGRESSION: recognises Style 1 via copy.part1Options even without productName at top level", () => {
    // Response has no top-level productName / product_name at all,
    // but the copy container carries part1Options. The load-bearing
    // signal is the copy array; normaliseStyle1Output falls back
    // to input.productName for the name field.
    const out = normaliseAiOutput(
      {
        copy: {
          part1Options: ["hook a"],
        },
      },
      INPUT,
    );
    expect(out.style1KitJson).toBeTruthy();
  });

  it("also accepts copy.part1_options (snake_case) as the load-bearing signal", () => {
    const out = normaliseAiOutput(
      {
        productName: "Sample Product",
        category: "beauty",
        copy: {
          part1_options: ["hook a"],
        },
      },
      INPUT,
    );
    expect(out.style1KitJson).toBeTruthy();
  });

  it("does NOT misclassify a genuinely legacy response as Style 1", () => {
    // Legacy shape carries image_prompt and hook_variants — no
    // copy container. Should still land on the legacy path.
    const out = normaliseAiOutput(
      {
        image_prompt: "old-style scene prompt",
        hook_variants: [
          { label: "v1", text: "old hook 1" },
          { label: "v2", text: "old hook 2" },
        ],
      },
      INPUT,
    );
    expect(out.style1KitJson).toBeUndefined();
    expect(out.imagePrompt).toBe("old-style scene prompt");
    expect(out.hookVariants?.length).toBe(2);
  });

  it("Style 1 with copy but empty part1Options AND top-level names still gets Style 1 dispatch (belt-and-braces branch), then rejects during normalisation", () => {
    // If a model emits copy: {} plus productName at top level, the
    // detector's belt-and-braces branch (hasStyle1TopLevel) takes
    // Style 1 dispatch — but normaliseStyle1Output throws because
    // part1Options is empty. That throw is the RIGHT behaviour:
    // callers catch and surface it as aiPromptError on the row,
    // which the operator sees as "regenerate this product". Better
    // than silently dropping to the legacy path.
    expect(() =>
      normaliseAiOutput(
        {
          productName: "Sample Product",
          category: "beauty",
          copy: {}, // empty
        },
        INPUT,
      ),
    ).toThrow(/part1Options/i);
  });
});
