"use client";

import { useMemo, useState, useTransition } from "react";
import Panel from "@/components/ui/Panel";
import StatusChip from "@/components/StatusChip";
import EmptyState from "@/components/ui/EmptyState";
import {
  generatePromptsPreview,
  type GeneratePromptsPreviewResult,
} from "./actions";
import type { AiPromptOutput } from "@/lib/ai/types";

/**
 * Live hook & prompt preview surface. Not persistent — this is a
 * "give me hooks I can copy right now" tool, deliberately separate
 * from the batches flow (which persists to Product rows).
 *
 * Layout:
 *   Column A (5/12)  Product picker + optional discount % + optional
 *                    live campaign hashtag + Generate button
 *   Column B (7/12)  Results — image / video prompt, caption,
 *                    hashtags, then all hook variants grouped by
 *                    family with per-line copy buttons.
 */

export interface ProductSummary {
  id: string;
  productName: string;
  originalTitle: string | null;
  category: string | null;
  retailerName: string | null;
  batchName: string;
}

/** Map a hook label ("SORRY_1", "WAIT_3", …) to its family header. */
const FAMILY_ORDER = [
  { prefix: "SORRY",     title: "I'm So Sorry"    },
  { prefix: "WAIT",      title: "Wait…"           },
  { prefix: "POV",       title: "POV"             },
  { prefix: "CURIOSITY", title: "Curiosity"       },
  { prefix: "SCARCITY",  title: "Scarcity & Urgency" },
  { prefix: "DEAL",      title: "Deal & Discount" },
  { prefix: "SOCIAL",    title: "Social Proof"    },
] as const;

function familyOf(label: string): string {
  const up = label.toUpperCase();
  for (const f of FAMILY_ORDER) {
    if (up.startsWith(f.prefix)) return f.title;
  }
  return "Other";
}

export default function PromptsClient({
  products,
}: {
  products: ProductSummary[];
}) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [discountPercentText, setDiscountPercentText] = useState("");
  const [campaignTag, setCampaignTag] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<GeneratePromptsPreviewResult | null>(
    null,
  );

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId) ?? null,
    [products, productId],
  );

  function handleGenerate() {
    setResult(null);
    startTransition(async () => {
      const raw = discountPercentText.trim();
      const asNumber = raw ? Number(raw) : null;
      const pct =
        asNumber !== null && Number.isFinite(asNumber) ? asNumber : null;
      const r = await generatePromptsPreview({
        productId,
        discountPercent: pct,
      });
      setResult(r);
    });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Column A — inputs ---------------------------------------- */}
      <div className="lg:col-span-5 space-y-5">
        <Panel title="Product & options">
          {products.length === 0 ? (
            <EmptyState
              icon="◇"
              title="No products yet"
              hint="Add products through a batch first — this surface reuses your uploaded product library."
            />
          ) : (
            <div className="space-y-4">
              <div className="field-row">
                <label className="label" htmlFor="prompts-product">
                  Product
                </label>
                <select
                  id="prompts-product"
                  className="field"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  disabled={pending}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.productName} · {p.batchName}
                    </option>
                  ))}
                </select>
                {selectedProduct && (
                  <div className="flex gap-2 flex-wrap mt-2">
                    {selectedProduct.category && (
                      <StatusChip label={selectedProduct.category} variant="muted" />
                    )}
                    {selectedProduct.retailerName && (
                      <StatusChip label={selectedProduct.retailerName} variant="muted" />
                    )}
                  </div>
                )}
              </div>

              <div className="field-row">
                <label className="label" htmlFor="prompts-discount">
                  Discount %{" "}
                  <span className="normal-case tracking-normal text-muted2 ml-1">
                    · optional
                  </span>
                </label>
                <input
                  id="prompts-discount"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  placeholder="e.g. 25"
                  className="field"
                  value={discountPercentText}
                  onChange={(e) => setDiscountPercentText(e.target.value)}
                  disabled={pending}
                />
                <p className="text-[11px] text-muted2 mt-1 leading-relaxed">
                  When set, unlocks the four percentage-based hooks (WAIT_3,
                  DEAL_1, DEAL_5, DEAL_6). Never put a price in on-screen text
                  — TikTok can flag it. Percentages are safe.
                </p>
              </div>

              <div className="field-row">
                <label className="label" htmlFor="prompts-campaign">
                  Live campaign hashtag{" "}
                  <span className="normal-case tracking-normal text-muted2 ml-1">
                    · optional
                  </span>
                </label>
                <input
                  id="prompts-campaign"
                  type="text"
                  placeholder="e.g. #tiktokshopspringsale"
                  className="field"
                  value={campaignTag}
                  onChange={(e) => setCampaignTag(e.target.value)}
                  disabled={pending}
                />
                <p className="text-[11px] text-muted2 mt-1 leading-relaxed">
                  Appended to the 4 core UK hashtags as the 5th slot. Use
                  whatever tag TikTok Shop is currently running its campaign
                  under.
                </p>
              </div>

              <button
                type="button"
                onClick={handleGenerate}
                disabled={pending || !productId}
                className="btn btn-primary w-full"
              >
                {pending ? "Generating…" : "Generate hooks"}
              </button>

              {result && !result.ok && (
                <div className="text-[12px] text-bad mt-1">
                  {result.message}
                </div>
              )}
              {result && result.ok && (
                <div className="text-[11px] text-muted">
                  Generated via {result.provider}.
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>

      {/* Column B — results --------------------------------------- */}
      <div className="lg:col-span-7 space-y-5">
        {!result?.output ? (
          <Panel title="Output" variant="ghost">
            <EmptyState
              icon="✎"
              title="Nothing generated yet"
              hint="Pick a product, optionally add today's discount % or campaign tag, then click Generate. Everything you get is copy-ready — no editing needed."
            />
          </Panel>
        ) : (
          <ResultsBlock output={result.output} campaignTag={campaignTag.trim()} />
        )}
      </div>
    </div>
  );
}

function ResultsBlock({
  output,
  campaignTag,
}: {
  output: AiPromptOutput;
  campaignTag: string;
}) {
  const hashtags = output.hashtags ?? [];
  // Append the operator's live campaign tag if provided, matching
  // TikTok's 5-tag cap.
  const finalHashtags = [...hashtags];
  const normalisedCampaign = normaliseHashtag(campaignTag);
  if (normalisedCampaign && finalHashtags.length < 5) {
    finalHashtags.push(normalisedCampaign);
  }

  // Group hook variants by family for the vertical panel list.
  const grouped = new Map<string, Array<{ label: string; text: string }>>();
  for (const v of output.hookVariants ?? []) {
    const family = familyOf(v.label);
    const arr = grouped.get(family) ?? [];
    arr.push({ label: v.label, text: v.text });
    grouped.set(family, arr);
  }

  return (
    <>
      <Panel title="Image & video prompts">
        <div className="space-y-3">
          <PromptRow label="Image prompt" text={output.imagePrompt} />
          {output.videoPrompt && (
            <PromptRow label="Video prompt" text={output.videoPrompt} />
          )}
          {output.retailerName && (
            <div className="text-[11px] text-muted">
              Retailer:{" "}
              <span className="text-text font-medium">{output.retailerName}</span>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Caption + hashtags">
        <div className="space-y-3">
          {output.caption && (
            <PromptRow label="Caption" text={output.caption} />
          )}
          <PromptRow
            label="Hashtag block"
            text={finalHashtags.join(" ")}
            hint={
              finalHashtags.length === 4
                ? "4 hashtags — leave the 5th slot for a live TikTok Shop campaign tag."
                : `${finalHashtags.length} hashtags — max 5.`
            }
          />
        </div>
      </Panel>

      {/* Hooks grouped by family */}
      <Panel title={`Hooks · ${output.hookVariants?.length ?? 0} generated`}>
        <div className="space-y-4">
          {FAMILY_ORDER.map(({ prefix, title }) => {
            const items = grouped.get(title);
            if (!items || items.length === 0) return null;
            return (
              <div key={prefix}>
                <div className="text-[11px] uppercase tracking-[0.14em] text-muted2 mb-2">
                  {title}
                </div>
                <div className="space-y-1.5">
                  {items.map((v) => (
                    <HookRow key={v.label} label={v.label} text={v.text} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {output.warnings && output.warnings.length > 0 && (
        <div className="card-accent-red p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-accent-red mb-1">
            Warnings
          </div>
          <ul className="text-sm text-text list-disc list-inside space-y-1">
            {output.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function PromptRow({
  label,
  text,
  hint,
}: {
  label: string;
  text: string;
  hint?: string;
}) {
  return (
    <div className="field-row">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">{label}</span>
        <CopyButton text={text} />
      </div>
      <div className="text-sm text-text bg-bg/60 border border-border rounded-xl px-3 py-2 whitespace-pre-wrap">
        {text}
      </div>
      {hint && <div className="text-[11px] text-muted2 mt-1">{hint}</div>}
    </div>
  );
}

function HookRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex items-start gap-2 group">
      <span className="text-[10px] font-mono text-muted2 tracking-wider min-w-[70px] pt-1 uppercase">
        {label}
      </span>
      <div className="flex-1 text-sm text-text leading-relaxed">{text}</div>
      <div className="opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={text} small />
      </div>
    </div>
  );
}

function CopyButton({
  text,
  small = false,
}: {
  text: string;
  small?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  function onClick() {
    // navigator.clipboard is preferred but requires HTTPS. Fall
    // back to a hidden textarea + execCommand for HTTP dev boxes.
    (async () => {
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
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      } catch {
        // Ignore — the user can still select+copy manually.
      }
    })();
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        small
          ? "text-[10px] text-muted hover:text-accent transition-colors px-1.5 py-0.5"
          : "text-[11px] text-muted hover:text-accent transition-colors px-2 py-1"
      }
      title="Copy to clipboard"
    >
      {copied ? "✓ copied" : "copy"}
    </button>
  );
}

/** Prepend '#' if absent, strip whitespace, lowercase to match the
 *  core UK block. Returns "" if the input was empty. */
function normaliseHashtag(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  const stripped = trimmed.replace(/^#+/, "").replace(/\s+/g, "");
  return stripped ? `#${stripped}` : "";
}
