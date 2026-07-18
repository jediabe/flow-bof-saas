"use client";

import { useEffect, useState } from "react";
import Panel from "@/components/ui/Panel";
import {
  getApprovedHooksForBatch,
  type ApprovedHooksProduct,
} from "./actions";

/**
 * Post-approval hook display for /prompts.
 *
 * Once the mobile reviewer approves a product, the server fires
 * generateAiPromptForProduct via `after()`. Result lands on the
 * Product row (imagePrompt, caption, hashtags, hookVariants).
 * Nothing on /prompts surfaced this — you had to hunt through
 * /batches/[id] to see the actual generated content. This
 * component closes that gap: polls the batch's approved products
 * every 4s, renders one collapsible card per product with the
 * full hook set + copy buttons.
 *
 * Reads-only. Regeneration lives on the panel above (the "Generate
 * hooks for N approved" button).
 */

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

const POLL_INTERVAL_MS = 4000;

export default function ApprovedHooksSection({
  batchId,
}: {
  batchId: string;
}) {
  const [products, setProducts] = useState<ApprovedHooksProduct[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Poll for approved-with-hooks products. Independent from the
  // KalodataImportPanel's progress polling — different action,
  // different payload — but shares the 4s cadence so cost is
  // consistent.
  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    async function tick() {
      const r = await getApprovedHooksForBatch(batchId);
      if (cancelled) return;
      if (r.ok && r.products) {
        setProducts(r.products);
      }
      setLoaded(true);
    }
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [batchId]);

  // Split approved products into ready (have hooks) and pending
  // (approved but generation hasn't finished / errored). Ready
  // ones render as expandable cards; pending ones as a small
  // "still generating" note so the operator knows the polling
  // will pick them up.
  const ready = products.filter(
    (p) => p.hookVariants.length > 0 || p.hook,
  );
  const pending = products.filter(
    (p) =>
      p.hookVariants.length === 0 &&
      !p.hook &&
      !p.aiPromptError,
  );
  const errored = products.filter((p) => p.aiPromptError);

  // Nothing to show yet — mount fast then hide until we have
  // something. Panel is a no-op when there are zero approvals.
  if (!loaded || (ready.length === 0 && pending.length === 0 && errored.length === 0)) {
    return null;
  }

  return (
    <Panel
      title={`Auto-generated hooks · ${ready.length} of ${products.length} ready`}
    >
      <div className="space-y-3">
        {ready.map((p) => (
          <ProductHooksCard key={p.id} product={p} />
        ))}
        {pending.length > 0 && (
          <div className="text-[11px] text-muted italic pl-2">
            Still generating for {pending.length} approved product
            {pending.length === 1 ? "" : "s"}…
          </div>
        )}
        {errored.map((p) => (
          <div
            key={p.id}
            className="card-accent-red p-3 text-[12px]"
          >
            <div className="font-medium text-text">
              {p.productName}
            </div>
            <div className="text-accent-red mt-1">
              Generation failed: {p.aiPromptError}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/**
 * One product's hooks as a collapsible details/summary card.
 * Collapsed by default so 30-product batches don't blow out the
 * page; the summary line shows product + discount + hook count.
 */
function ProductHooksCard({ product }: { product: ApprovedHooksProduct }) {
  const [open, setOpen] = useState(false);

  // Group by family so the card mirrors the manual generate page's
  // layout — familiar territory for the operator.
  const grouped = new Map<string, Array<{ label: string; text: string }>>();
  for (const v of product.hookVariants) {
    const family = familyOf(v.label);
    const arr = grouped.get(family) ?? [];
    arr.push(v);
    grouped.set(family, arr);
  }

  return (
    <div className="panel border border-border rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-panel2/50 transition-colors"
      >
        <span className="text-muted2 text-xs w-3 text-center">
          {open ? "▾" : "▸"}
        </span>
        <span className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text truncate">
            {product.productName}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            {product.hookVariants.length} hooks
            {product.discountPercent != null && (
              <>
                {" · "}
                <span className="text-accent-red font-mono">
                  −{product.discountPercent}%
                </span>
              </>
            )}
          </div>
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4 space-y-5">
          {/* Image + video prompts */}
          {product.imagePrompt && (
            <PromptRow label="Image prompt" text={product.imagePrompt} />
          )}
          {/* Caption + hashtags */}
          {product.caption && (
            <PromptRow label="Caption" text={product.caption} />
          )}
          {product.hashtags.length > 0 && (
            <PromptRow
              label="Hashtag block"
              text={product.hashtags.join(" ")}
              hint="Add your live TikTok Shop campaign tag as the 5th slot at post time."
            />
          )}

          {/* Hooks grouped by family */}
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
        </div>
      )}
    </div>
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
        // ignore
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
