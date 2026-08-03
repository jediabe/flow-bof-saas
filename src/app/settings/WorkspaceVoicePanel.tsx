"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  saveWorkspaceVoiceSettings,
  type WorkspaceVoiceSettings,
} from "./actions";

/**
 * Voice setup panel — the one-time ElevenLabs voice-design flow
 * (per the Style 1 "Create Your Custom AI Voice" Loom) followed
 * by a small form where the operator pastes the resulting voice
 * ID + a friendly label. Per market (UK + US).
 *
 * No ElevenLabs API integration — the operator generates audio
 * in ElevenLabs' web UI. These fields are pure UX plumbing so
 * the mobile posting page can render "paste script into voice:
 * <label> (<id>)" per market at the moment the operator needs it.
 */

const UK_VOICE_PROMPT =
  "A warm, natural British female voice, around 25 years old, casual " +
  "and friendly like she's chatting to a friend. Relaxed, upbeat and " +
  "genuine — not robotic, not corporate. Clear, high-quality audio.";

const US_VOICE_PROMPT =
  "A warm, natural American female voice, around 25 years old, casual " +
  "and friendly like she's chatting to a friend. Relaxed, upbeat and " +
  "genuine — not robotic, not corporate. Clear, high-quality audio.";

export default function WorkspaceVoicePanel({
  initial,
}: {
  initial: WorkspaceVoiceSettings;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [ukVoiceId,    setUkVoiceId]    = useState(initial.ukVoiceId    ?? "");
  const [ukVoiceLabel, setUkVoiceLabel] = useState(initial.ukVoiceLabel ?? "");
  const [usVoiceId,    setUsVoiceId]    = useState(initial.usVoiceId    ?? "");
  const [usVoiceLabel, setUsVoiceLabel] = useState(initial.usVoiceLabel ?? "");
  const [toast, setToast] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const r = await saveWorkspaceVoiceSettings(fd);
      setToast(r.message);
      if (r.ok) {
        router.refresh();
        setTimeout(() => setToast(null), 3000);
      }
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted leading-relaxed">
        Voiceover for Style 1 videos runs through{" "}
        <a
          href="https://elevenlabs.io"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          ElevenLabs
        </a>
        . One-time setup per market: design a voice in ElevenLabs, save it,
        then paste the voice ID + a friendly name here. Every video's
        mobile posting page will remind you which voice to use.
      </p>

      {/* One-time voice-design walkthrough --------------------------- */}
      <details className="card-accent-blue p-4">
        <summary className="cursor-pointer text-sm font-medium text-text">
          One-time setup: design your ElevenLabs voice
        </summary>
        <div className="mt-3 space-y-3 text-xs text-muted leading-relaxed">
          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              Sign in at{" "}
              <a
                href="https://elevenlabs.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                elevenlabs.io
              </a>
              . Free tier is enough to start.
            </li>
            <li>
              Go to <span className="text-text font-medium">Voices</span> →{" "}
              <span className="text-text font-medium">Voice Design</span>.
            </li>
            <li>
              Paste one of the voice prompts below into the "voice
              description" field. Let ElevenLabs generate a few candidates.
            </li>
            <li>
              Listen back, pick the most human-sounding one, and{" "}
              <span className="text-text font-medium">save it</span> with a
              friendly name (e.g. "Alicia" for UK, "Emma" for US).
            </li>
            <li>
              Open the voice, copy the{" "}
              <span className="text-text font-medium">voice ID</span> from
              the URL or the voice detail panel. Paste it below.
            </li>
          </ol>

          <VoicePromptBlock label="UK voice prompt" prompt={UK_VOICE_PROMPT} />
          <VoicePromptBlock label="US voice prompt" prompt={US_VOICE_PROMPT} />
        </div>
      </details>

      {/* Save form -------------------------------------------------- */}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <VoiceRow
            marketLabel="UK"
            idFieldName="ukVoiceId"
            labelFieldName="ukVoiceLabel"
            idValue={ukVoiceId}
            labelValue={ukVoiceLabel}
            onIdChange={setUkVoiceId}
            onLabelChange={setUkVoiceLabel}
            disabled={pending}
          />
          <VoiceRow
            marketLabel="US"
            idFieldName="usVoiceId"
            labelFieldName="usVoiceLabel"
            idValue={usVoiceId}
            labelValue={usVoiceLabel}
            onIdChange={setUsVoiceId}
            onLabelChange={setUsVoiceLabel}
            disabled={pending}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="btn btn-primary text-xs"
          >
            {pending ? "Saving…" : "Save voice settings"}
          </button>
          {toast && (
            <span className="text-[11px] text-ok">{toast}</span>
          )}
        </div>
      </form>

      <p className="text-[11px] text-muted2 leading-relaxed">
        Clear either field to unset it — an empty ID is treated as "not
        configured" and the mobile posting page will nudge you to set it
        up before generating the voiceover.
      </p>
    </div>
  );
}

/** One market's row: ID + friendly label side by side. */
function VoiceRow({
  marketLabel,
  idFieldName,
  labelFieldName,
  idValue,
  labelValue,
  onIdChange,
  onLabelChange,
  disabled,
}: {
  marketLabel: string;
  idFieldName: string;
  labelFieldName: string;
  idValue: string;
  labelValue: string;
  onIdChange: (v: string) => void;
  onLabelChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="panel p-4 space-y-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted">
        {marketLabel} voice
      </div>
      <div className="field-row">
        <label className="label" htmlFor={idFieldName}>
          Voice ID
        </label>
        <input
          id={idFieldName}
          name={idFieldName}
          className="field font-mono text-[11px]"
          placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
          value={idValue}
          onChange={(e) => onIdChange(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="field-row">
        <label className="label" htmlFor={labelFieldName}>
          Friendly name
        </label>
        <input
          id={labelFieldName}
          name={labelFieldName}
          className="field"
          placeholder={
            marketLabel === "UK" ? "e.g. Alicia" : "e.g. Emma"
          }
          value={labelValue}
          onChange={(e) => onLabelChange(e.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

/** Copyable voice-design prompt block. */
function VoicePromptBlock({
  label,
  prompt,
}: {
  label: string;
  prompt: string;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    (async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(prompt);
        } else {
          const ta = document.createElement("textarea");
          ta.value = prompt;
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
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted">
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          className="text-[11px] text-accent hover:underline"
        >
          {copied ? "✓ copied" : "Copy"}
        </button>
      </div>
      <pre className="text-[11px] leading-relaxed text-text bg-bg/60 border border-border rounded-xl px-3 py-2 whitespace-pre-wrap">
        {prompt}
      </pre>
    </div>
  );
}
