import { describe, it, expect } from "vitest";
import { canonicalTikTokShopUrl, extractTikTokProductId } from "../tikhub";

// canonicalTikTokShopUrl is the URL normaliser the paste-URL
// importer runs every pasted TikTok URL through. Pins the shape
// so a future edit that breaks the mobile-app deep link (region
// param dropped, path segment renamed) fails loudly here.

describe("canonicalTikTokShopUrl", () => {
  const ID = "1729768316584172043";

  it("builds the canonical GB shape by default", () => {
    expect(canonicalTikTokShopUrl(ID, "uk")).toBe(
      `https://shop.tiktok.com/view/product/${ID}?region=GB&locale=en`,
    );
  });

  it("maps 'us' market → region=US (uppercased)", () => {
    expect(canonicalTikTokShopUrl(ID, "us")).toBe(
      `https://shop.tiktok.com/view/product/${ID}?region=US&locale=en`,
    );
  });

  it("case-insensitive on market", () => {
    expect(canonicalTikTokShopUrl(ID, "US")).toBe(
      `https://shop.tiktok.com/view/product/${ID}?region=US&locale=en`,
    );
    expect(canonicalTikTokShopUrl(ID, "Uk")).toBe(
      `https://shop.tiktok.com/view/product/${ID}?region=GB&locale=en`,
    );
  });

  it("null / empty / unknown market falls back to GB (matches enrichment default)", () => {
    for (const m of [null, undefined, "", "fr", "de"]) {
      expect(canonicalTikTokShopUrl(ID, m)).toBe(
        `https://shop.tiktok.com/view/product/${ID}?region=GB&locale=en`,
      );
    }
  });

  it("returns null on empty / whitespace productId", () => {
    for (const bad of [null, undefined, "", "   ", "\t"]) {
      expect(canonicalTikTokShopUrl(bad, "uk")).toBeNull();
    }
  });

  it("returns null on non-numeric productId (defence)", () => {
    for (const bad of ["abc", "12", "not-an-id", "123-456", "1234567890abcdef1"]) {
      expect(canonicalTikTokShopUrl(bad, "uk")).toBeNull();
    }
  });

  it("accepts a fresh extract → canonicalise round-trip", () => {
    // Every URL shape the extractor handles should round-trip
    // through the canonicaliser.
    for (const src of [
      `https://shop.tiktok.com/view/product/${ID}`,
      `https://www.tiktok.com/shop/gb/pdp/${ID}?source=foo`,
      `https://shop-us.tiktok.com/view/product/${ID}?locale=en`,
      `https://example.test/anything?product_id=${ID}`,
    ]) {
      const extracted = extractTikTokProductId(src);
      expect(extracted).toBe(ID);
      expect(canonicalTikTokShopUrl(extracted, "uk")).toBe(
        `https://shop.tiktok.com/view/product/${ID}?region=GB&locale=en`,
      );
    }
  });
});
