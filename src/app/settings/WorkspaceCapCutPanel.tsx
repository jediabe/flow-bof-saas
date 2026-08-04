"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveWorkspaceCapCutTemplateUrl } from "./actions";

/**
 * CapCut template panel — persist a shareable CapCut template URL
 * that gets surfaced on the mobile posting page per product.
 *
 * The operator builds the template ONCE in CapCut (all styling,
 * timing, music, text overlay presets) then pastes its share link
 * here. On the mobile posting page, that link renders as a big
 * "Open CapCut template" button so per-video assembly drops to
 * "drop 2 clips + voice into 3 slots, type 2 text lines, export."
 *
 * Pure UX plumbing — no CapCut API integration.
 */
export default function WorkspaceCapCutPanel({
  initialUrl,
}: {
  initialUrl: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState(initialUrl ?? "");
  const [toast, setToast] = useState<{ tone: "ok" | "bad"; text: string } | null>(
    null,
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const r = await saveWorkspaceCapCutTemplateUrl(fd);
      setToast({ tone: r.ok ? "ok" : "bad", text: r.message });
      if (r.ok) {
        router.refresh();
        setTimeout(() => setToast(null), 3000);
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted leading-relaxed">
        Pre-styled CapCut template that gets one link per shared
        template. Mobile posting page surfaces it as a big Open in
        CapCut button per video so each assembly is fill-in-the-
        blanks instead of starting from scratch.
      </p>

      <details className="card-accent-blue p-4">
        <summary className="cursor-pointer text-sm font-medium text-text">
          What the template should include
        </summary>
        <div className="mt-3 space-y-2 text-xs text-muted leading-relaxed">
          <p className="text-text font-medium">Timing:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-2">
            <li>Scene 1 slot: 8-second clip placeholder</li>
            <li>Hard cut at 8s</li>
            <li>Scene 2 slot: 8-second clip placeholder</li>
          </ul>
          <p className="text-text font-medium mt-3">Audio:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-2">
            <li>Trending sound at low volume (music duck curve baked in)</li>
            <li>Voice slot on Scene 2 at higher volume — the duck curve
                brings music DOWN when the voice fires</li>
            <li>OR: voice on the full 16s if the coach's Scene 1
                voiceover rule wins (still awaiting their call)</li>
          </ul>
          <p className="text-text font-medium mt-3">Text overlays:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-2">
            <li>Scene 1 hook text slot — 2 lines, top-third, big + readable</li>
            <li>Scene 2 sale text slot — 1 line, upper-half, clear of product</li>
            <li>Auto-caption preset for the voice track — small, low
                on screen (turn on in-editor per video)</li>
          </ul>
          <p className="text-text font-medium mt-3">Export:</p>
          <ul className="list-disc list-inside space-y-0.5 ml-2">
            <li>9:16 vertical, no transitions, no effects</li>
          </ul>
          <p className="mt-3 text-muted2 italic">
            Once built, tap Share &rarr; Copy link on the template, paste below.
          </p>
        </div>
      </details>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="field-row">
          <label className="label" htmlFor="capCutTemplateUrl">
            CapCut template share URL
          </label>
          <input
            id="capCutTemplateUrl"
            name="capCutTemplateUrl"
            type="url"
            className="field font-mono text-[11px]"
            placeholder="https://www.capcut.com/t/<template-id>"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="btn btn-primary text-xs"
          >
            {pending ? "Saving…" : "Save template URL"}
          </button>
          {toast && (
            <span
              className={`text-[11px] ${toast.tone === "ok" ? "text-ok" : "text-bad"}`}
            >
              {toast.text}
            </span>
          )}
        </div>
      </form>

      <p className="text-[11px] text-muted2 leading-relaxed">
        Clear the field and Save to unset — mobile posting will nudge
        you back here if a product tries to open CapCut with no URL
        configured.
      </p>
    </div>
  );
}
