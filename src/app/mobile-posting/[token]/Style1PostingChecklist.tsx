"use client";

import { useMemo, useState, useTransition } from "react";
import { setChosenCopyPartViaToken } from "@/app/batches/actions";
import {
  parseStyle1Kit,
  buildElevenLabsScript,
} from "@/lib/ai/style1";

/**
 * Style 1 posting checklist — stripped-down mobile page (2026-08
 * pivot). Only the pieces the operator actually needs at post
 * time, in the order they consume them:
 *
 *   1. Caption 1 — Part 1 hook (Scene 1 on-screen text). Tap-to-
 *      pick from 5 options; the pick also feeds the ElevenLabs
 *      script below.
 *   2. Caption 2 — Part 3 sale text (Scene 2 on-screen text).
 *      Tap-to-pick from 5 options.
 *   3. ElevenLabs script — Part 1 chosen + Part 2 chosen back-
 *      to-back. Big copy button. Collapsible "swap Part 2"
 *      inside for changing the voiceover half without leaving
 *      the page. Voice-ID reminder pulled from workspace
 *      settings.
 *   4. Hashtags — 5-tag block, big copy button. #AIGC reminder.
 *   5. Product description — one-line TikTok caption lead-in,
 *      big copy button.
 *
 * Removed with the pivot: Google Flow section (desktop-only for
 * the extraction), CapCut section (out of scope for the new
 * flow), individual scene prompts, post-time reminder list.
 */

export interface Style1ChecklistWorkspaceVoices {
  ukVoiceId: string | null;
  ukVoiceLabel: string | null;
  usVoiceId: string | null;
  usVoiceLabel: string | null;
  /** Kept in the shape for now to avoid churning the parent
   *  prop chain — no longer rendered here. Legacy from the
   *  CapCut section we removed. */
  capCutTemplateUrl: string | null;
}

export interface Style1ChecklistProduct {
  id: string;
  style1Kit: string | null;
  chosenCopyPart1: string | null;
  chosenCopyPart2: string | null;
  chosenCopyPart3: string | null;
  /** Videos the /generate agent saved for this product with
   *  freshly-resolved signed URLs. Empty when no videos have been
   *  generated (agent hasn't been run OR the operator hasn't
   *  reached that product yet). */
  generatedVideos: Array<{
    id: string;
    sceneLabel: string;
    mediaGenerationId: string;
    prompt: string | null;
    notes: string | null;
    createdAt: string;
    url: string | null;
  }>;
}

export default function Style1PostingChecklist({
  token,
  batchMarket,
  product,
  voices,
  onLocalChosenUpdate,
}: {
  token: string;
  batchMarket: string;
  product: Style1ChecklistProduct;
  voices: Style1ChecklistWorkspaceVoices;
  /** Called after a successful chosenCopyPart write so the parent
   *  MobilePostingClient can optimistically update its local
   *  product cache without a re-fetch. */
  onLocalChosenUpdate: (
    part: "1" | "2" | "3",
    text: string,
  ) => void;
}) {
  const kit = parseStyle1Kit(product.style1Kit);
  const elevenLabsScript = useMemo(
    () =>
      kit
        ? buildElevenLabsScript(
            kit,
            product.chosenCopyPart1,
            product.chosenCopyPart2,
          )
        : "",
    [kit, product.chosenCopyPart1, product.chosenCopyPart2],
  );

  if (!kit) {
    return (
      <div className="mx-4 mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-300 leading-relaxed">
        Style 1 kit missing or malformed for this product. Regenerate
        on the desktop /prompts page to fix.
      </div>
    );
  }

  const isUk = batchMarket.toLowerCase() === "uk";
  const voiceId    = isUk ? voices.ukVoiceId    : voices.usVoiceId;
  const voiceLabel = isUk ? voices.ukVoiceLabel : voices.usVoiceLabel;

  return (
    <section className="px-4 pt-4 space-y-4">
      {/* 1. Videos — anything the /generate agent produced for this
          product. Rendered ONLY when generatedVideos has entries so
          products the operator hasn't run through /generate yet
          don't get an empty section screaming at them. */}
      {product.generatedVideos.length > 0 && (
        <ChecklistCard title="1 · Videos (from /generate agent)" accent="blue">
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Tap a scene to play. Download from the player&apos;s menu,
            then bring into CapCut for assembly. Signed URLs are
            fresh (valid ~6h); reload this page if a video stops
            loading.
          </p>
          <div className="space-y-3">
            {product.generatedVideos.map((v) => (
              <VideoRow key={v.id} video={v} />
            ))}
          </div>
        </ChecklistCard>
      )}

      {/* 2. Caption 1 — Part 1 hook, on-screen Scene 1 */}
      <ChecklistCard
        title={`${sectionNumber(product, 1)} · Caption 1 (Scene 1 hook)`}
        accent="blue"
      >
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Shown on Scene 1 AND read by ElevenLabs. Tap one to copy
          + pick.
        </p>
        <OptionsBlock
          options={kit.copy.part1Options}
          chosen={product.chosenCopyPart1}
          onPick={async (text) => {
            await setChosenCopyPartViaToken({
              token,
              productId: product.id,
              part: "1",
              text,
            });
            onLocalChosenUpdate("1", text);
          }}
        />
      </ChecklistCard>

      {/* 3. Caption 2 — Part 3 sale text, on-screen Scene 2 */}
      <ChecklistCard
        title={`${sectionNumber(product, 2)} · Caption 2 (Scene 2 sale text)`}
        accent="red"
      >
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          On-screen only over Scene 2. Not spoken.
        </p>
        <OptionsBlock
          options={kit.copy.part3Options}
          chosen={product.chosenCopyPart3}
          onPick={async (text) => {
            await setChosenCopyPartViaToken({
              token,
              productId: product.id,
              part: "3",
              text,
            });
            onLocalChosenUpdate("3", text);
          }}
        />
      </ChecklistCard>

      {/* 4. ElevenLabs script */}
      <ChecklistCard
        title={`${sectionNumber(product, 3)} · ElevenLabs script`}
        accent="blue"
      >
        {voiceId && voiceLabel ? (
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Paste into voice{" "}
            <span className="text-zinc-200 font-medium">{voiceLabel}</span>{" "}
            <code className="text-[10px] text-zinc-500 font-mono">
              ({voiceId})
            </code>
            . Stability ~40%. Uses your Part 1 pick + option 1 of Part 2
            by default — swap Part 2 below if needed.
          </p>
        ) : (
          <p className="text-[11px] text-red-300 leading-relaxed">
            No {isUk ? "UK" : "US"} voice configured. Set one up at{" "}
            <span className="font-medium">Settings → Voice setup</span>{" "}
            before generating the voiceover.
          </p>
        )}
        <CopyPill label="Copy ElevenLabs script" value={elevenLabsScript} />
        <pre className="text-[11px] leading-relaxed text-zinc-200 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 whitespace-pre-wrap mt-2">
          {elevenLabsScript}
        </pre>
        <details className="mt-3">
          <summary className="text-[11px] text-zinc-500 cursor-pointer">
            Swap Part 2 (voiceover half)
          </summary>
          <p className="text-[10px] text-zinc-500 leading-relaxed mt-2">
            Part 2 is spoken only — not on-screen. Tap one to change
            which line goes into the ElevenLabs script above.
          </p>
          <OptionsBlock
            options={kit.copy.part2Options}
            chosen={product.chosenCopyPart2}
            onPick={async (text) => {
              await setChosenCopyPartViaToken({
                token,
                productId: product.id,
                part: "2",
                text,
              });
              onLocalChosenUpdate("2", text);
            }}
          />
        </details>
      </ChecklistCard>

      {/* 5. Hashtags */}
      <ChecklistCard
        title={`${sectionNumber(product, 4)} · Hashtags`}
        accent="blue"
      >
        <CopyPill
          label="Copy hashtag block"
          value={kit.hashtags.join(" ")}
        />
        <p className="text-[11px] text-zinc-500 leading-relaxed mt-2">
          #AIGC is required for AI-generated content disclosure. Swap
          #weekendsale for the live campaign hashtag when there is one.
        </p>
      </ChecklistCard>

      {/* 6. Product description */}
      <ChecklistCard
        title={`${sectionNumber(product, 5)} · Product description (caption lead-in)`}
        accent="blue"
      >
        {kit.productDescription ? (
          <CopyPill
            label="Copy product description"
            value={kit.productDescription}
          />
        ) : (
          <p className="text-[11px] text-zinc-500 italic">
            No product description generated for this product.
          </p>
        )}
        <p className="text-[11px] text-zinc-500 leading-relaxed mt-2">
          Paste above the hashtag block in the TikTok caption.
        </p>
      </ChecklistCard>
    </section>
  );
}

/* --------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------ */

/** Section-number derivation. Videos section is dynamic — it
 *  only renders when there are videos. If it's rendered, it's
 *  section 1 and everything else shifts +1. If not, nothing
 *  shifts. Called with the "canonical" number a section had
 *  before Commit 7 (Caption 1 was 1, Caption 2 was 2, etc.);
 *  returns the number to actually display. */
function sectionNumber(
  product: Style1ChecklistProduct,
  canonical: number,
): number {
  const videosPresent = product.generatedVideos.length > 0;
  return videosPresent ? canonical + 1 : canonical;
}

/** One row in the Videos section — inline player + label +
 *  metadata. Handles the "url resolve failed" fallback gracefully
 *  with a retry hint (page reload). */
function VideoRow({
  video,
}: {
  video: Style1ChecklistProduct["generatedVideos"][number];
}) {
  const label = sceneLabelToHuman(video.sceneLabel);
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[12px] font-semibold text-zinc-100">
          {label}
        </div>
        <div className="text-[10px] text-zinc-500">
          {new Date(video.createdAt).toLocaleString()}
        </div>
      </div>
      {video.url ? (
        <video
          src={video.url}
          controls
          playsInline
          preload="metadata"
          className="w-full max-h-96 rounded-lg bg-black"
        />
      ) : (
        <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-[11px] text-orange-300 leading-relaxed">
          Couldn&apos;t resolve a fresh URL for this video. Reload the
          page to retry; if it keeps failing, the MCP server may be
          down or the Google Flow session may have broken (Settings
          → Google Flow account).
        </div>
      )}
      {(video.prompt || video.notes) && (
        <details className="text-[10px] text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-300">
            Prompt / notes
          </summary>
          {video.prompt && (
            <div className="mt-1.5">
              <span className="text-zinc-400 font-semibold">prompt:</span>{" "}
              <span className="whitespace-pre-wrap">{video.prompt}</span>
            </div>
          )}
          {video.notes && (
            <div className="mt-1.5">
              <span className="text-zinc-400 font-semibold">notes:</span>{" "}
              <span className="whitespace-pre-wrap">{video.notes}</span>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

/** Human-friendly scene label. Falls back to a titlecased
 *  version of the raw label for unknown values (e.g. "combined",
 *  "other", or future style labels). */
function sceneLabelToHuman(raw: string): string {
  switch (raw) {
    case "scene_1_store":
      return "Scene 1 · Store walk-up";
    case "scene_2_home":
      return "Scene 2 · Product at home";
    case "combined":
      return "Combined (stitched)";
    case "other":
      return "Adhoc";
    default:
      // Fallback: replace underscores with spaces, capitalize
      // first letter of each word.
      return raw
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
  }
}

function ChecklistCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent: "blue" | "red";
  children: React.ReactNode;
}) {
  const borderColor =
    accent === "blue" ? "border-blue-500/40" : "border-red-500/40";
  return (
    <div
      className={`rounded-2xl border ${borderColor} bg-zinc-900/40 p-4 space-y-3`}
    >
      <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Big tap-to-copy pill for a single value. */
function CopyPill({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    (async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(value);
        } else {
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // ignore
      }
    })();
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="w-full text-sm py-3 rounded-xl bg-blue-600 active:bg-blue-700 text-white font-medium"
    >
      {copied ? "✓ copied" : label}
    </button>
  );
}

/** Options list — 5 tappable cards, tapping one both copies to
 *  clipboard and persists it as the chosen pick for this Part.
 *  Chosen card renders with a green outline + "picked" label. */
function OptionsBlock({
  options,
  chosen,
  onPick,
}: {
  options: string[];
  chosen: string | null;
  onPick: (text: string) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [localChosen, setLocalChosen] = useState<string | null>(chosen);

  async function tap(text: string, i: number) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      // ignore
    }
    setCopiedIndex(i);
    setLocalChosen(text);
    setTimeout(() => setCopiedIndex(null), 1500);
    startTransition(async () => {
      await onPick(text);
    });
  }

  return (
    <div className="mt-2 space-y-2">
      {options.map((text, i) => {
        const isChosen = localChosen === text;
        const wasJustCopied = copiedIndex === i;
        return (
          <button
            key={i}
            type="button"
            onClick={() => tap(text, i)}
            disabled={pending}
            className={`w-full text-left rounded-xl px-3 py-3 border ${
              isChosen
                ? "border-green-500/60 bg-green-500/10"
                : "border-zinc-700 bg-zinc-900 active:bg-zinc-800"
            } transition-colors`}
          >
            <div className="flex items-start gap-2">
              <span className="text-[10px] font-mono text-zinc-500 min-w-[20px]">
                {i + 1}
              </span>
              <span className="flex-1 text-[13px] text-zinc-100 leading-relaxed">
                {text}
              </span>
            </div>
            {wasJustCopied && (
              <div className="mt-1 text-[10px] text-green-400 pl-6">
                ✓ copied
              </div>
            )}
            {isChosen && !wasJustCopied && (
              <div className="mt-1 text-[10px] text-green-500 pl-6">
                ✓ picked
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
