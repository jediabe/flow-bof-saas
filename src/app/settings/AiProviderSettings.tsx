"use client";

import { useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import {
  saveAiSettings,
  testAiProviderAction,
} from "./actions";
import type { MaskedAiProviderSettings } from "@/lib/workspace-settings";
import type { AiProviderKey } from "@/lib/ai/types";
import { KNOWN_PROVIDERS } from "@/lib/ai/types";

/**
 * AI provider settings form. Lives inside the existing /settings page.
 *
 * API keys never round-trip through this component as plain text:
 *   - On first render the API-key input is empty + a chip shows
 *     "Set (****abcd)" or "Not set".
 *   - Leaving the field blank on save = "keep existing key".
 *   - Typing a value = "replace key with this".
 *   - Clicking "Clear" sets a sentinel that wipes the stored key.
 *
 * That way we never have to ship the secret to the client just so it
 * can be re-saved.
 */
export default function AiProviderSettingsForm({
  initial,
}: {
  initial: MaskedAiProviderSettings;
}) {
  const [pending, startTransition] = useTransition();
  const [testing, startTest] = useTransition();
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const [provider, setProvider] = useState<AiProviderKey>(initial.provider);

  // Local "I typed a new key" state. When the input is non-empty it
  // overrides the existing keySet preview.
  const [openaiKey, setOpenaiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openrouterKey, setOpenrouterKey] = useState("");

  const [openaiModel, setOpenaiModel] = useState(initial.openai.model);
  const [anthropicModel, setAnthropicModel] = useState(
    initial.anthropic.model,
  );
  const [openrouterModel, setOpenrouterModel] = useState(
    initial.openrouter.model,
  );
  const [orSiteUrl, setOrSiteUrl] = useState(initial.openrouter.siteUrl);
  const [orAppName, setOrAppName] = useState(initial.openrouter.appName);

  // Track per-provider "this key is currently saved" so the chip
  // updates as soon as the user saves (without a full page refresh).
  const [savedKeys, setSavedKeys] = useState({
    openai:     { set: initial.openai.keySet,     preview: initial.openai.keyPreview },
    anthropic:  { set: initial.anthropic.keySet,  preview: initial.anthropic.keyPreview },
    openrouter: { set: initial.openrouter.keySet, preview: initial.openrouter.keyPreview },
  });

  function buildFormData(opts?: { clearKeyFor?: keyof typeof savedKeys }) {
    const fd = new FormData();
    fd.set("aiProvider", provider);
    // Models / non-secret fields. Empty string → clear.
    fd.set("openaiModel", openaiModel);
    fd.set("anthropicModel", anthropicModel);
    fd.set("openrouterModel", openrouterModel);
    fd.set("openrouterSiteUrl", orSiteUrl);
    fd.set("openrouterAppName", orAppName);
    // Keys: sentinel logic.
    fd.set("openaiApiKey", opts?.clearKeyFor === "openai" ? "__CLEAR__" : openaiKey);
    fd.set("anthropicApiKey", opts?.clearKeyFor === "anthropic" ? "__CLEAR__" : anthropicKey);
    fd.set("openrouterApiKey", opts?.clearKeyFor === "openrouter" ? "__CLEAR__" : openrouterKey);
    return fd;
  }

  function save(opts?: { clearKeyFor?: keyof typeof savedKeys }) {
    setSaveMessage(null);
    setTestMessage(null);
    const fd = buildFormData(opts);
    startTransition(async () => {
      const r = await saveAiSettings(fd);
      setSaveMessage(r.message);
      if (r.ok) {
        // Reflect what we just persisted: typed keys become "set"
        // with a preview; cleared keys go back to "not set".
        setSavedKeys((s) => ({
          openai:     opts?.clearKeyFor === "openai"     ? { set: false, preview: "" } : openaiKey     ? { set: true, preview: `****${openaiKey.slice(-4)}` }     : s.openai,
          anthropic:  opts?.clearKeyFor === "anthropic"  ? { set: false, preview: "" } : anthropicKey  ? { set: true, preview: `****${anthropicKey.slice(-4)}` }  : s.anthropic,
          openrouter: opts?.clearKeyFor === "openrouter" ? { set: false, preview: "" } : openrouterKey ? { set: true, preview: `****${openrouterKey.slice(-4)}` } : s.openrouter,
        }));
        // Empty the typed-key inputs so a second save doesn't re-write.
        setOpenaiKey("");
        setAnthropicKey("");
        setOpenrouterKey("");
      }
    });
  }

  function test() {
    setTestMessage(null);
    startTest(async () => {
      const r = await testAiProviderAction();
      setTestMessage({ ok: r.ok, text: r.message });
    });
  }

  return (
    <div className="space-y-5">
      {/* Provider radio buttons ------------------------------------ */}
      <div>
        <div className="label mb-2">Active provider</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {KNOWN_PROVIDERS.map((p) => (
            <label
              key={p}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-sm transition-colors ${
                provider === p
                  ? "border-accent bg-accent/[0.06] text-text"
                  : "border-border bg-panel2 text-muted hover:text-text"
              }`}
            >
              <input
                type="radio"
                name="provider"
                value={p}
                className="sr-only"
                checked={provider === p}
                onChange={() => setProvider(p)}
              />
              <span className="capitalize">{p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : p === "openrouter" ? "OpenRouter" : "Manual"}</span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted mt-1">
          Manual = deterministic UK retail prompt. Remote providers
          generate prompt + hook + caption + hashtags.
        </p>
      </div>

      {/* OpenAI ---------------------------------------------------- */}
      <ProviderBlock
        title="OpenAI"
        keySetPreview={savedKeys.openai.set ? `set (${savedKeys.openai.preview})` : "not set"}
        keySet={savedKeys.openai.set}
        clear={() => save({ clearKeyFor: "openai" })}
      >
        <KeyInput value={openaiKey} setValue={setOpenaiKey} placeholder="sk-..." />
        <ModelInput value={openaiModel} setValue={setOpenaiModel} placeholder="gpt-4o-mini" />
      </ProviderBlock>

      {/* Anthropic ------------------------------------------------- */}
      <ProviderBlock
        title="Anthropic"
        keySetPreview={savedKeys.anthropic.set ? `set (${savedKeys.anthropic.preview})` : "not set"}
        keySet={savedKeys.anthropic.set}
        clear={() => save({ clearKeyFor: "anthropic" })}
      >
        <KeyInput value={anthropicKey} setValue={setAnthropicKey} placeholder="sk-ant-..." />
        <ModelInput value={anthropicModel} setValue={setAnthropicModel} placeholder="claude-3-5-sonnet-latest" />
      </ProviderBlock>

      {/* OpenRouter ----------------------------------------------- */}
      <ProviderBlock
        title="OpenRouter"
        keySetPreview={savedKeys.openrouter.set ? `set (${savedKeys.openrouter.preview})` : "not set"}
        keySet={savedKeys.openrouter.set}
        clear={() => save({ clearKeyFor: "openrouter" })}
      >
        <KeyInput value={openrouterKey} setValue={setOpenrouterKey} placeholder="sk-or-..." />
        <ModelInput value={openrouterModel} setValue={setOpenrouterModel} placeholder="openrouter/auto" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="label">Site URL (optional)</span>
            <input
              className="field mt-1"
              value={orSiteUrl}
              onChange={(e) => setOrSiteUrl(e.target.value)}
              placeholder="https://your-site.example"
            />
          </label>
          <label className="block">
            <span className="label">App name (optional)</span>
            <input
              className="field mt-1"
              value={orAppName}
              onChange={(e) => setOrAppName(e.target.value)}
              placeholder="Flow BOF SaaS"
            />
          </label>
        </div>
      </ProviderBlock>

      {/* Actions --------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={() => save()}
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={testing}
          onClick={test}
        >
          {testing ? "Testing…" : "Test active provider"}
        </button>
        {saveMessage && (
          <span className="text-[11px] text-accent">{saveMessage}</span>
        )}
        {testMessage && (
          <StatusChip
            label={testMessage.text.slice(0, 80)}
            variant={testMessage.ok ? "ok" : "bad"}
          />
        )}
      </div>
    </div>
  );
}

function ProviderBlock({
  title,
  keySetPreview,
  keySet,
  clear,
  children,
}: {
  title: string;
  keySetPreview: string;
  keySet: boolean;
  clear: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-panel2 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium text-text">{title}</div>
        <div className="flex items-center gap-2">
          <StatusChip
            label={keySetPreview}
            variant={keySet ? "ok" : "muted"}
          />
          {keySet && (
            <button
              type="button"
              className="btn btn-ghost text-[11px] px-2 py-1"
              onClick={clear}
            >
              Clear key
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

function KeyInput({
  value,
  setValue,
  placeholder,
}: {
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="label">API key</span>
      <input
        className="field mt-1 font-mono"
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
      />
      <span className="text-[11px] text-muted mt-1 block">
        Leave blank to keep the existing key.
      </span>
    </label>
  );
}

function ModelInput({
  value,
  setValue,
  placeholder,
}: {
  value: string;
  setValue: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="label">Model</span>
      <input
        className="field mt-1"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
