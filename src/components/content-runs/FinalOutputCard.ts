import { createElement as h, type ReactNode } from "react";
import type { FinalOutputCardView } from "@/lib/content-runs/final-output-card";

function summary(view: Exclude<FinalOutputCardView, { state: "none" }>): ReactNode {
  return h("div", { className: "flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" },
    h("span", null, `Status ${view.status}`),
    h("span", null, `Final QA ${view.qaStatus}`),
    view.qaScore !== null ? h("span", null, `Score ${view.qaScore}`) : null,
    "bytes" in view ? h("span", null, `${view.bytes.toLocaleString("en-US")} bytes`) : null,
    "sha256" in view ? h("span", { title: view.sha256 }, `${view.sha256.slice(0, 12)}…`) : null,
  );
}

export default function FinalOutputCard({ view }: { view: FinalOutputCardView }) {
  const body = view.state === "none"
    ? h("p", { className: "mt-2 text-sm text-muted" }, "No final output has been persisted yet.")
    : h("div", { className: "mt-2 space-y-3" },
        summary(view),
        view.state === "legacy"
          ? h("p", { className: "text-sm text-muted" }, "This legacy final row has no complete persisted MP4 metadata.")
          : null,
        view.state === "unavailable"
          ? h("p", { className: "text-sm text-muted" }, "The persisted MP4 is not available through private storage.")
          : null,
        view.state === "available"
          ? h("div", { className: "space-y-2" },
              h("video", {
                className: "max-h-[32rem] w-full rounded-lg bg-black",
                controls: true,
                preload: "metadata",
                src: view.url,
              }),
              h("a", {
                className: "inline-flex rounded-md border border-border px-3 py-2 text-sm text-text hover:bg-surface",
                href: view.url,
                download: `final-output-${view.id}.mp4`,
              }, "Download MP4"),
            )
          : null,
      );

  return h("section", {
    className: "rounded-xl border border-border bg-panel p-4",
    "aria-labelledby": "final-output-heading",
  },
  h("h2", { id: "final-output-heading", className: "text-sm font-semibold text-text" }, "Final Output"),
  body);
}
