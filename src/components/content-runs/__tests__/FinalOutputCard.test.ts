import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import FinalOutputCard from "../FinalOutputCard";

describe("FinalOutputCard", () => {
  it("renders a playable and downloadable MP4 only for an available persisted asset", () => {
    const html = renderToStaticMarkup(createElement(FinalOutputCard, { view: {
      state: "available",
      id: "final_1",
      status: "APPROVED",
      qaStatus: "APPROVED",
      qaScore: 94,
      bytes: 123456,
      sha256: "a".repeat(64),
      url: "https://signed.example/final.mp4",
    } }));

    expect(html).toContain("Final Output");
    expect(html).toContain("Score 94");
    expect(html).toContain("123,456 bytes");
    expect(html).toContain("aaaaaaaaaaaa…");
    expect(html).toContain("<video");
    expect(html).toContain("Download MP4");
    expect(html).toContain('download="final-output-final_1.mp4"');
  });

  it.each([
    { state: "none" as const },
    { state: "legacy" as const, id: "final_1", status: "READY", qaStatus: "APPROVED", qaScore: null },
    { state: "unavailable" as const, id: "final_1", status: "READY", qaStatus: "APPROVED", qaScore: 94, bytes: 123, sha256: "a".repeat(64) },
  ])("does not render mutation or media controls for $state output", (view) => {
    const html = renderToStaticMarkup(createElement(FinalOutputCard, { view }));
    expect(html).not.toContain("<video");
    expect(html).not.toContain("Download MP4");
    expect(html).not.toContain("<button");
  });
});
