import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  fetchImageAsBase64,
} from "../fetch-image";

// Build a minimal `Response`-shaped object without pulling in
// undici's real Response — the module only reads `ok`, `status`,
// `statusText`, `headers.get()`, and `arrayBuffer()`.
function stubResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  body?: ArrayBuffer;
}): Response {
  const headers = new Headers();
  if (opts.contentType !== null && opts.contentType !== undefined) {
    headers.set("content-type", opts.contentType);
  }
  const body = opts.body ?? new ArrayBuffer(4);
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers,
    arrayBuffer: async () => body,
  } as unknown as Response;
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("fetchImageAsBase64 — happy paths", () => {
  it("returns base64 + mediaType for a jpeg", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({ contentType: "image/jpeg", body: bytes.buffer }),
      ),
    );
    const out = await fetchImageAsBase64("https://example.com/x.jpg");
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.data).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("passes through image/png / image/webp / image/gif", async () => {
    for (const mt of ["image/png", "image/webp", "image/gif"] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          stubResponse({ contentType: mt, body: new ArrayBuffer(8) }),
        ),
      );
      const out = await fetchImageAsBase64("https://example.com/x");
      expect(out.mediaType).toBe(mt);
    }
  });

  it("strips ;charset= parameter from Content-Type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({
          contentType: "image/png; charset=binary",
          body: new ArrayBuffer(4),
        }),
      ),
    );
    const out = await fetchImageAsBase64("https://example.com/x.png");
    expect(out.mediaType).toBe("image/png");
  });

  it("Content-Type is matched case-insensitively", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({ contentType: "IMAGE/JPEG", body: new ArrayBuffer(4) }),
      ),
    );
    const out = await fetchImageAsBase64("https://example.com/x.jpg");
    expect(out.mediaType).toBe("image/jpeg");
  });
});

describe("fetchImageAsBase64 — content-type coercion", () => {
  // Behavior preserved from the ip-risk-ai.ts original: an image/*
  // that's not in Anthropic's accepted set (e.g. image/svg+xml,
  // image/heic) is coerced to image/jpeg in the RETURN VALUE.
  // The bytes are still whatever was fetched; only the label
  // changes. Downstream Anthropic tolerance handles it.
  it("coerces image/svg+xml to image/jpeg in the return label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({ contentType: "image/svg+xml", body: new ArrayBuffer(8) }),
      ),
    );
    const out = await fetchImageAsBase64("https://example.com/x.svg");
    expect(out.mediaType).toBe("image/jpeg");
  });

  it("coerces image/heic to image/jpeg", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({ contentType: "image/heic", body: new ArrayBuffer(8) }),
      ),
    );
    const out = await fetchImageAsBase64("https://example.com/x.heic");
    expect(out.mediaType).toBe("image/jpeg");
  });
});

describe("fetchImageAsBase64 — error paths", () => {
  it("throws on non-2xx HTTP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({ ok: false, status: 404, statusText: "Not Found" }),
      ),
    );
    await expect(fetchImageAsBase64("https://example.com/nope")).rejects.toThrow(
      /HTTP 404 Not Found/,
    );
  });

  it("throws on missing content-type header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(stubResponse({ contentType: null })),
    );
    await expect(fetchImageAsBase64("https://example.com/x")).rejects.toThrow(
      /non-image content-type/,
    );
  });

  it("throws on non-image content-type (text/html)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(stubResponse({ contentType: "text/html" })),
    );
    await expect(fetchImageAsBase64("https://example.com/x")).rejects.toThrow(
      /non-image content-type: text\/html/,
    );
  });

  it("throws on empty content-type ('')", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(stubResponse({ contentType: "" })),
    );
    await expect(fetchImageAsBase64("https://example.com/x")).rejects.toThrow(
      /non-image content-type: \?/,
    );
  });

  it("throws when body exceeds MAX_IMAGE_BYTES (8 MiB)", async () => {
    // Just over the cap.
    const oversized = new ArrayBuffer(MAX_IMAGE_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({ contentType: "image/jpeg", body: oversized }),
      ),
    );
    await expect(fetchImageAsBase64("https://example.com/big.jpg")).rejects.toThrow(
      /Image too large/,
    );
  });

  it("accepts a body exactly at MAX_IMAGE_BYTES", async () => {
    // The cap is inclusive: exactly-at is fine, only strictly-over is rejected.
    // Pinning the boundary so a future >= flip is deliberate.
    const atCap = new ArrayBuffer(MAX_IMAGE_BYTES);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        stubResponse({ contentType: "image/jpeg", body: atCap }),
      ),
    );
    const out = await fetchImageAsBase64("https://example.com/edge.jpg");
    expect(out.mediaType).toBe("image/jpeg");
  });

  it("propagates fetch() throws (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ENOTFOUND example.invalid")),
    );
    await expect(fetchImageAsBase64("https://example.invalid/x")).rejects.toThrow(
      /ENOTFOUND/,
    );
  });
});
