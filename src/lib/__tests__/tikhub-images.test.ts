import { describe, it, expect } from "vitest";

// Access the internal pluckImageUrls via a same-file test —
// tikhub.ts doesn't export it (it's called from
// getShopProductDetailEnriched), and we'd rather test the
// exact behavior than reach through the enrichment shape
// indirection. Use `any` for the dynamic import + prop access
// since this is the module's own internal.
async function loadPluck(): Promise<
  (d: Record<string, unknown>, pm?: Record<string, unknown> | null) => string[]
> {
  const mod = await import("../tikhub");
  const anyMod = mod as unknown as {
    __test_pluckImageUrls?: (...args: unknown[]) => string[];
  };
  if (anyMod.__test_pluckImageUrls) {
    return anyMod.__test_pluckImageUrls as (
      d: Record<string, unknown>,
      pm?: Record<string, unknown> | null,
    ) => string[];
  }
  throw new Error(
    "tikhub.ts must export __test_pluckImageUrls for these tests to reach the internal pluckImageUrls helper.",
  );
}

const HERO_1 = "https://p16.tiktokcdn.com/hero1.jpeg";
const HERO_2 = "https://p16.tiktokcdn.com/hero2.jpeg";
const HERO_3 = "https://p16.tiktokcdn.com/hero3.jpeg";
const SKU_1 = "https://p16.tiktokcdn.com/sku_black.jpeg";
const DESC_1 = "https://p16.tiktokcdn.com/desc_measurements.jpeg";
const DESC_2 = "https://p16.tiktokcdn.com/desc_slim.jpeg";
const DESC_3 = "https://p16.tiktokcdn.com/desc_stretch.jpeg";

describe("pluckImageUrls — main-card priority (July 2026 fix)", () => {
  it("puts product_model.images (main carousel) FIRST", async () => {
    const pluck = await loadPluck();
    const productModel = {
      images: [
        { url_list: [HERO_1] },
        { url_list: [HERO_2] },
      ],
    };
    const response = {
      product_model: productModel,
      description: {
        rich_content: [
          { image: { url_list: [DESC_1] } },
          { image: { url_list: [DESC_2] } },
        ],
      },
    };
    const out = pluck(response, productModel);
    // Hero images from product_model.images come FIRST.
    expect(out.indexOf(HERO_1)).toBeLessThan(out.indexOf(DESC_1));
    expect(out.indexOf(HERO_2)).toBeLessThan(out.indexOf(DESC_1));
  });

  it("includes BOTH main carousel + description infographics in one gallery", async () => {
    const pluck = await loadPluck();
    const productModel = { images: [{ url_list: [HERO_1] }] };
    const response = {
      product_model: productModel,
      description: {
        rich_content: [
          { image: { url_list: [DESC_1] } },
          { image: { url_list: [DESC_2] } },
        ],
      },
    };
    const out = pluck(response, productModel);
    // The operator wanted BOTH — main card + description panels.
    expect(out).toContain(HERO_1);
    expect(out).toContain(DESC_1);
    expect(out).toContain(DESC_2);
  });

  it("dedupes across pass 0 / pass 1 / pass 2 (main card appears once)", async () => {
    const pluck = await loadPluck();
    const productModel = { images: [{ url_list: [HERO_1] }] };
    const response = {
      product_model: productModel,
      // The same hero also lives in a variant SKU block —
      // shouldn't duplicate.
      sku_info: { image_url: HERO_1 },
    };
    const out = pluck(response, productModel);
    const count = out.filter((u) => u === HERO_1).length;
    expect(count).toBe(1);
  });

  it("uses alt product-model keys — image_list / main_images / gallery_images", async () => {
    const pluck = await loadPluck();
    for (const key of ["image_list", "main_images", "gallery_images"]) {
      const productModel = {
        [key]: [{ url_list: [HERO_1] }, { url_list: [HERO_2] }],
      };
      const response = { product_model: productModel };
      const out = pluck(response, productModel);
      expect(out[0]).toBe(HERO_1);
      expect(out[1]).toBe(HERO_2);
    }
  });

  it("still works when productModel arg is omitted (falls back to findProductModel)", async () => {
    const pluck = await loadPluck();
    // productModel embedded at data.product_model — findProductModel
    // should locate it and pass 0 still runs.
    const response = {
      data: {
        product_model: {
          product_id: "1729",
          name: "Test",
          images: [{ url_list: [HERO_1] }],
        },
      },
      description: {
        rich_content: [{ image: { url_list: [DESC_1] } }],
      },
    };
    const out = pluck(response);
    expect(out[0]).toBe(HERO_1);
    expect(out).toContain(DESC_1);
  });

  it("respects the 16-image cap", async () => {
    const pluck = await loadPluck();
    const many = Array.from({ length: 30 }, (_, i) => ({
      url_list: [`https://p16.tiktokcdn.com/hero${i}.jpeg`],
    }));
    const productModel = { images: many };
    const response = { product_model: productModel };
    const out = pluck(response, productModel);
    expect(out.length).toBe(16);
  });

  it("regression: pass 2 runs even when pass 1 already found >=4 items (was the bug — description panels got suppressed)", async () => {
    const pluck = await loadPluck();
    const productModel = {
      images: [
        { url_list: [HERO_1] },
        { url_list: [HERO_2] },
        { url_list: [HERO_3] },
      ],
      // Simulate the "adjacent to product" content that used to
      // trigger the >=4 threshold and suppress pass 2.
      sku_info: { images: [{ url_list: [SKU_1] }] },
    };
    const response = {
      product_model: productModel,
      description: {
        rich_content: [
          { image: { url_list: [DESC_1] } },
          { image: { url_list: [DESC_2] } },
          { image: { url_list: [DESC_3] } },
        ],
      },
    };
    const out = pluck(response, productModel);
    // Pre-fix behavior: pass 1 finds hero + sku = 4, threshold
    // met, pass 2 skipped, DESC_* absent.
    // Post-fix: all three DESC_* present after the heroes/sku.
    expect(out).toContain(DESC_1);
    expect(out).toContain(DESC_2);
    expect(out).toContain(DESC_3);
    // And heroes still lead.
    expect(out[0]).toBe(HERO_1);
  });
});
