"use client";

import { useState, useTransition } from "react";
import { setChosenCopyPartViaToken } from "@/app/batches/actions";
import {
  parseStyle1Kit,
  buildFlowAgentPrompt,
} from "@/lib/ai/style1";

/**
 * Style 1 posting checklist — the top-to-bottom mobile walkthrough
 * an operator follows to turn one approved product into a posted
 * TikTok video.
 *
 * Sections (in order):
 *   1. Google Flow — one big Copy for the composed agent script,
 *      collapsible fallback with the 4 individual scene prompts.
 *   2. ElevenLabs — Voice reminder pulled from workspace settings
 *      + tappable Part 1 and Part 2 options (5 each). Tapping a
 *      Part option copies its text AND persists the pick via
 *      setChosenCopyPartViaToken so the desktop /prompts modal
 *      can surface which line was used.
 *   3. On-screen text — Part 3 (5 options), same tap-to-copy-and-
 *      pick UX. This is the ONLY visible text over Scene 2 (Part
 *      1 goes over Scene 1; Part 2 is spoken only).
 *   4. Hashtag block — one Copy, with the #aigc reminder.
 *   5. Post-time reminders — AI-label toggle + campaign hashtag
 *      swap.
 *
 * All server writes fire-and-forget with an optimistic local flip.
 * Copy defers to the shared CopyPill helper below.
 */

export interface Style1ChecklistWorkspaceVoices {
  ukVoiceId: string | null;
  ukVoiceLabel: string | null;
  usVoiceId: string | null;
  usVoiceLabel: string | null;
}

export interface Style1ChecklistProduct {
  id: string;
  style1Kit: string | null;
  chosenCopyPart1: string | null;
  chosenCopyPart2: string | null;
  chosenCopyPart3: string | null;
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
  if (!kit) {
    return (
      <div className="mx-4 mt-4 rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-300 leading-relaxed">
        Style 1 kit missing or malformed for this product. Regenerate
        on the desktop /prompts page to fix.
      </div>
    );
  }

  const agentPrompt = buildFlowAgentPrompt(kit);
  const isUk = batchMarket.toLowerCase() === "uk";
  const voiceId    = isUk ? voices.ukVoiceId    : voices.usVoiceId;
  const voiceLabel = isUk ? voices.ukVoiceLabel : voices.usVoiceLabel;

  return (
    <section className="px-4 pt-4 space-y-4">
      {/* 1. Flow */}
      <ChecklistCard title="1 · Google Flow" accent="blue">
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Open Flow, upload the reference image, paste this into the
          agent chat. Two stages — pick one store + one home when the
          images come back.
        </p>
        <CopyPill label="Copy Flow agent script" value={agentPrompt} />
        <details className="mt-2">
          <summary className="text-[11px] text-zinc-500 cursor-pointer">
            Or use Flow one prompt at a time
          </summary>
          <div className="mt-2 space-y-2">
            <CopyPill
              label="Scene 1 · image"
              value={kit.scene1.imagePrompt}
              small
            />
            <CopyPill
              label="Scene 1 · motion"
              value={kit.scene1.motionPrompt}
              small
            />
            <CopyPill
              label="Scene 2 · image"
              value={kit.scene2.imagePrompt}
              small
            />
            <CopyPill
              label="Scene 2 · motion"
              value={kit.scene2.motionPrompt}
              small
            />
          </div>
        </details>
      </ChecklistCard>

      {/* 2. ElevenLabs */}
      <ChecklistCard title="2 · ElevenLabs voice" accent="blue">
        {voiceId && voiceLabel ? (
          <p className="text-[11px] text-zinc-400 leading-relaxed">
            Paste Part 1 + Part 2 into voice{" "}
            <span className="text-zinc-200 font-medium">{voiceLabel}</span>{" "}
            <code className="text-[10px] text-zinc-500 font-mono">
              ({voiceId})
            </code>
            . Stability ~40%. Generate → download the MP3.
          </p>
        ) : (
          <p className="text-[11px] text-red-300 leading-relaxed">
            No {isUk ? "UK" : "US"} voice configured. Set one up on the
            desktop at{" "}
            <span className="font-medium">Settings → Voice setup</span>{" "}
            before generating the voiceover.
          </p>
        )}
        <OptionsBlock
          label="Part 1 hook (spoken + on-screen over Scene 1)"
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
        <OptionsBlock
          label="Part 2 voiceover (spoken over Scene 2)"
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
      </ChecklistCard>

      {/* 3. On-screen text */}
      <ChecklistCard title="3 · On-screen sale text (Scene 2)" accent="red">
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          Shown on screen over Scene 2 for the whole clip. Not spoken.
        </p>
        <OptionsBlock
          label="Part 3 sale text"
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

      {/* 4. Hashtags */}
      <ChecklistCard title="4 · Hashtags" accent="blue">
        <CopyPill
          label="Copy hashtag block"
          value={kit.hashtags.join(" ")}
        />
        <p className="text-[11px] text-zinc-500 leading-relaxed mt-2">
          #aigc is required for AI-generated content disclosure. If a
          TikTok Shop campaign is live, swap #weekendsale for the
          current campaign hashtag before you post.
        </p>
      </ChecklistCard>

      {/* 5. Post-time reminders */}
      <ChecklistCard title="5 · Post on TikTok" accent="red">
        <ul className="text-[11px] text-zinc-400 leading-relaxed space-y-1.5 list-disc list-inside">
          <li>
            Turn ON the{" "}
            <span className="text-zinc-200 font-medium">
              AI-generated content
            </span>{" "}
            label under More options.
          </li>
          <li>
            Confirm #aigc is in your caption after paste.
          </li>
          <li>Add the product link.</li>
          <li>Check the video looks right, then post.</li>
        </ul>
      </ChecklistCard>
    </section>
  );
}

/* --------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------ */

function ChecklistCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent: "blue" | "red";
  children: React.ReactNode;
}) {
  const borderColor = accent === "blue" ? "border-blue-500/40" : "border-red-500/40";
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
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
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
      className={`w-full ${
        small ? "text-[11px] py-2" : "text-sm py-3"
      } rounded-xl bg-blue-600 active:bg-blue-700 text-white font-medium`}
    >
      {copied ? "✓ copied" : label}
    </button>
  );
}

/** Options list — 5 tappable cards, tapping one both copies to
 *  clipboard and persists it as the chosen pick for this Part.
 *  The chosen card renders with a green outline + label. */
function OptionsBlock({
  label,
  options,
  chosen,
  onPick,
}: {
  label: string;
  options: string[];
  chosen: string | null;
  onPick: (text: string) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [localChosen, setLocalChosen] = useState<string | null>(chosen);

  async function tap(text: string, i: number) {
    // Optimistic copy first (feels instant even if the server call
    // takes a moment).
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
    <div className="mt-3 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
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
