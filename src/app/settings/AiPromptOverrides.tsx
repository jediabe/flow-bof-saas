"use client";

import { useState, useTransition } from "react";
import { saveAiPrompts } from "./actions";

/**
 * Settings panel for the per-workspace AI image-prompt overrides.
 *
 * Two textareas (UK + US) + a Save button. Each market has a
 * "Show bundled default" disclosure that reveals the in-code
 * constant — the user can copy-paste it as a starting point for
 * their edit. Saving an empty / whitespace textarea clears the
 * override and the bundled default kicks back in.
 *
 * The textareas are big (rows=18) on purpose — these prompts are
 * long-form and the operator iterates by reading them end-to-end.
 * Smaller textareas force scrolling within a tiny window, which
 * makes editing painful.
 */
export default function AiPromptOverrides({
  initialUkOverride,
  initialUsOverride,
  ukDefault,
  usDefault,
}: {
  initialUkOverride: string | null;
  initialUsOverride: string | null;
  ukDefault: string;
  usDefault: string;
}) {
  const [uk, setUk] = useState(initialUkOverride ?? "");
  const [us, setUs] = useState(initialUsOverride ?? "");
  const [showUkDefault, setShowUkDefault] = useState(false);
  const [showUsDefault, setShowUsDefault] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      await saveAiPrompts(fd);
      setSavedAt(Date.now());
    });
  }

  function resetMarket(market: "uk" | "us") {
    if (market === "uk") setUk("");
    else setUs("");
  }

  function loadDefault(market: "uk" | "us") {
    if (market === "uk") setUk(ukDefault);
    else setUs(usDefault);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <MarketEditor
        marketLabel="UK"
        fieldName="ukSystemPromptOverride"
        value={uk}
        onChange={setUk}
        defaultText={ukDefault}
        showDefault={showUkDefault}
        onToggleDefault={() => setShowUkDefault((v) => !v)}
        onReset={() => resetMarket("uk")}
        onLoadDefault={() => loadDefault("uk")}
        usingDefault={uk.trim().length === 0}
      />

      <MarketEditor
        marketLabel="US"
        fieldName="usSystemPromptOverride"
        value={us}
        onChange={setUs}
        defaultText={usDefault}
        showDefault={showUsDefault}
        onToggleDefault={() => setShowUsDefault((v) => !v)}
        onReset={() => resetMarket("us")}
        onLoadDefault={() => loadDefault("us")}
        usingDefault={us.trim().length === 0}
      />

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save prompts"}
        </button>
        {savedAt && !pending && (
          <span className="text-xs text-ok">
            ✓ Saved. The next AI prompt generation will use these.
          </span>
        )}
      </div>
    </form>
  );
}

function MarketEditor({
  marketLabel,
  fieldName,
  value,
  onChange,
  defaultText,
  showDefault,
  onToggleDefault,
  onReset,
  onLoadDefault,
  usingDefault,
}: {
  marketLabel: string;
  fieldName: string;
  value: string;
  onChange: (v: string) => void;
  defaultText: string;
  showDefault: boolean;
  onToggleDefault: () => void;
  onReset: () => void;
  onLoadDefault: () => void;
  usingDefault: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div className="flex items-baseline gap-3">
          <span className="label">{marketLabel} system prompt</span>
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider ${
              usingDefault ? "text-muted" : "text-accent"
            }`}
          >
            {usingDefault ? "using bundled default" : "override active"}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={onLoadDefault}
          >
            Load default into editor
          </button>
          <span className="text-muted2">·</span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={onReset}
          >
            Clear override
          </button>
          <span className="text-muted2">·</span>
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={onToggleDefault}
          >
            {showDefault ? "Hide bundled default" : "Show bundled default"}
          </button>
        </div>
      </div>

      <textarea
        name={fieldName}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={18}
        placeholder={`Leave blank to use the bundled ${marketLabel} default. Paste / edit to override.`}
        className="field font-mono text-[11px] leading-snug w-full"
        spellCheck={false}
      />

      {showDefault && (
        <div className="rounded-2xl border border-border bg-panel2 p-3 mt-2">
          <div className="text-[10px] uppercase tracking-wider text-muted mb-2">
            Bundled {marketLabel} default — read-only
          </div>
          <pre className="text-[11px] leading-snug text-muted whitespace-pre-wrap max-h-80 overflow-y-auto font-mono">
            {defaultText}
          </pre>
        </div>
      )}
    </div>
  );
}
