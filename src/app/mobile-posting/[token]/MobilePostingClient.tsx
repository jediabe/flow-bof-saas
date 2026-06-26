"use client";

/**
 * Phone-first posting-assist UI (v2 — full-screen single-product
 * design with whole-card tap-to-copy, hook-variant cycling, and
 * swipe navigation).
 *
 * Workflow this is tuned for:
 *   1. User opens this page on their phone alongside TikTok.
 *   2. For each product:
 *      a. TAP the hook card → clipboard now has the hook.
 *      b. Switch to TikTok video editor, paste as text overlay.
 *      c. Switch back, optionally cycle to a different hook variant.
 *      d. TAP the caption card → paste into TikTok's caption box.
 *      e. TAP the hashtags card → append to caption.
 *      f. TAP "Mark posted ✓" → auto-advances to next product.
 *   3. Repeat until done.
 *
 * Key design decisions:
 *   - The whole COPY card is the tap target (not a tiny button in the
 *     corner). Thumb-friendly while glancing between apps.
 *   - Only ONE hook variant is shown at a time, with cycle arrows.
 *     The user picks one per post; showing 5-7 stacked makes the
 *     primary action ambiguous and forces scrolling.
 *   - "Mark posted ✓ → next" is a giant primary CTA at the bottom.
 *     Skip / Reset are secondary chips.
 *   - Horizontal swipe (touch) jumps between products. Matches phone
 *     conventions; reduces hand reach to top-of-screen nav buttons.
 *   - productDescription is hidden behind a "More" disclosure —
 *     used rarely; doesn't deserve hero space.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { setProductPostingStatusViaToken } from "@/app/batches/actions";

export type PostingStatus = "needs_posting" | "posted" | "skipped";

export interface MobilePostingProduct {
  id: string;
  productName: string;
  tiktokUrl: string | null;
  referenceImageUrl: string | null;
  imageUrl: string | null;
  hook: string | null;
  hookVariants: Array<{
    label: string;
    text: string;
    leverName?: string;
  }>;
  caption: string | null;
  hashtags: string[];
  productDescription: string | null;
  postingStatus: PostingStatus;
  postingNotes: string | null;
}

const STATUS_PILL: Record<PostingStatus, { bg: string; text: string; label: string }> = {
  needs_posting: { bg: "bg-orange-500/15", text: "text-orange-400", label: "Needs posting" },
  posted:        { bg: "bg-green-500/15",  text: "text-green-400",  label: "Posted" },
  skipped:       { bg: "bg-zinc-500/15",   text: "text-zinc-300",   label: "Skipped" },
};

export default function MobilePostingClient({
  token,
  batchName,
  batchMarket,
  products: initial,
}: {
  token: string;
  batchName: string;
  batchMarket: string;
  products: MobilePostingProduct[];
}) {
  const [products, setProducts] = useState<MobilePostingProduct[]>(initial);
  const [index, setIndex] = useState<number>(() =>
    Math.max(0, initial.findIndex((p) => p.postingStatus === "needs_posting")),
  );
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Which hook variant is currently shown. Resets to 0 whenever the
  // user navigates to a different product — picking a hook is a
  // per-post decision.
  const [hookIndex, setHookIndex] = useState(0);
  useEffect(() => setHookIndex(0), [index]);

  const counts = useMemo(() => {
    const c: Record<PostingStatus, number> = { needs_posting: 0, posted: 0, skipped: 0 };
    for (const p of products) c[p.postingStatus]++;
    return c;
  }, [products]);

  const total = products.length;
  const remaining = counts.needs_posting;
  const done = remaining === 0 && total > 0;
  const current = products[index] ?? null;

  function advanceToNextPending(fromIndex: number): void {
    for (let i = fromIndex + 1; i < products.length; i++) {
      if (products[i].postingStatus === "needs_posting") {
        setIndex(i);
        return;
      }
    }
    for (let i = 0; i < fromIndex; i++) {
      if (products[i].postingStatus === "needs_posting") {
        setIndex(i);
        return;
      }
    }
    // If nothing else needs posting, fall through — the parent
    // will switch to the DoneScreen on next render.
  }

  function goPrev() {
    setIndex((i) => Math.max(0, i - 1));
  }
  function goNext() {
    setIndex((i) => Math.min(total - 1, i + 1));
  }

  function applyStatus(status: PostingStatus): void {
    if (!current || pending) return;
    const productId = current.id;
    const i = index;
    setErrorMsg(null);
    startTransition(async () => {
      const r = await setProductPostingStatusViaToken({
        token,
        productId,
        status,
      });
      if (!r.ok) {
        setErrorMsg(r.message ?? "Could not save status. Try again.");
        return;
      }
      setProducts((prev) =>
        prev.map((p) => (p.id === productId ? { ...p, postingStatus: status } : p)),
      );
      if (status !== "needs_posting") {
        advanceToNextPending(i);
      }
    });
  }

  if (done) {
    return (
      <DoneScreen
        batchName={batchName}
        batchMarket={batchMarket}
        counts={counts}
        total={total}
        onReviewAgain={() => setIndex(0)}
      />
    );
  }
  if (!current) {
    return (
      <Shell>
        <EmptyScreen batchName={batchName} batchMarket={batchMarket} />
      </Shell>
    );
  }

  // The active hook to show. Prefer the hookVariants array, fall
  // back to the single legacy hook string when variants are empty.
  const activeHook: { label: string; text: string; leverName?: string } | null =
    current.hookVariants.length > 0
      ? current.hookVariants[hookIndex % current.hookVariants.length]
      : current.hook
        ? { label: "Hook", text: current.hook }
        : null;

  const variantCount = current.hookVariants.length;
  const hashtagsLine =
    current.hashtags.length > 0 ? current.hashtags.join(" ") : null;

  return (
    <SwipeShell onSwipeLeft={goNext} onSwipeRight={goPrev}>
      <ProgressHeader
        batchName={batchName}
        batchMarket={batchMarket}
        index={index}
        total={total}
        remaining={remaining}
        products={products}
        onJumpTo={setIndex}
      />

      <ProductHeader product={current} />

      {/* Hook — full-card tap-to-copy with variant cycle */}
      <section className="px-4 pt-4">
        <SectionTitle
          left="Hook → text overlay in TikTok editor"
          right={
            variantCount > 1
              ? `Variant ${hookIndex + 1} of ${variantCount}`
              : null
          }
        />
        <CopyCard
          value={activeHook?.text ?? null}
          empty="No hook generated yet. Run AI prompts on desktop."
          subLabel={activeHook?.leverName ?? activeHook?.label}
          accent="hook"
        />
        {variantCount > 1 && (
          <VariantCycler
            count={variantCount}
            index={hookIndex}
            onChange={setHookIndex}
          />
        )}
      </section>

      {/* Caption */}
      <section className="px-4 pt-5">
        <SectionTitle left="Caption → paste into TikTok post screen" />
        <CopyCard
          value={current.caption}
          empty="No caption yet."
          accent="caption"
        />
      </section>

      {/* Hashtags */}
      <section className="px-4 pt-4">
        <SectionTitle left="Hashtags → append to caption" />
        <CopyCard
          value={hashtagsLine}
          empty="No hashtags yet."
          accent="hashtags"
        />
      </section>

      {/* More — productDescription tucked away */}
      {current.productDescription && (
        <section className="px-4 pt-4">
          <details className="rounded-2xl bg-zinc-900/60 px-3 py-2">
            <summary className="text-xs text-zinc-400 cursor-pointer select-none">
              More: product description
            </summary>
            <div className="mt-2 text-sm text-zinc-200 leading-relaxed">
              {current.productDescription}
            </div>
          </details>
        </section>
      )}

      {/* Hero "Mark posted & next" CTA */}
      <section className="px-4 pt-6 pb-2 space-y-2">
        <button
          type="button"
          onClick={() => applyStatus("posted")}
          disabled={pending}
          className="w-full py-4 rounded-2xl bg-green-600 active:bg-green-700 disabled:opacity-50 text-base font-semibold text-white shadow-lg shadow-green-900/30"
        >
          {current.postingStatus === "posted"
            ? "✓ Marked posted — tap to advance"
            : "✓ Mark posted & next"}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => applyStatus("skipped")}
            disabled={pending}
            className={`py-3 rounded-2xl text-sm font-medium text-zinc-200 transition-colors disabled:opacity-50 ${
              current.postingStatus === "skipped"
                ? "bg-zinc-600 ring-2 ring-blue-400/60"
                : "bg-zinc-800 active:bg-zinc-700"
            }`}
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => applyStatus("needs_posting")}
            disabled={pending || current.postingStatus === "needs_posting"}
            className="py-3 rounded-2xl text-sm font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 active:bg-zinc-800 disabled:opacity-50"
          >
            Reset
          </button>
        </div>
      </section>

      {/* Prev / Next product nav — kept for accessibility (swipe is
          the primary nav, but tap targets are needed for users who
          can't or don't swipe). */}
      <nav className="px-4 pt-4 pb-8 flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          disabled={index === 0 || pending}
          className="px-4 py-2 text-sm text-zinc-300 disabled:text-zinc-600"
        >
          ← Previous product
        </button>
        <span className="text-xs text-zinc-500">swipe ↔</span>
        <button
          type="button"
          onClick={goNext}
          disabled={index >= total - 1 || pending}
          className="px-4 py-2 text-sm text-zinc-300 disabled:text-zinc-600"
        >
          Next product →
        </button>
      </nav>

      {errorMsg && (
        <div className="fixed bottom-4 left-4 right-4 rounded-xl bg-red-600 text-white text-sm px-3 py-2 shadow-lg">
          {errorMsg}
        </div>
      )}
    </SwipeShell>
  );
}

/* ---------- pieces ---------- */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 max-w-md mx-auto">
      {children}
    </div>
  );
}

function SwipeShell({
  children,
  onSwipeLeft,
  onSwipeRight,
}: {
  children: React.ReactNode;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
}) {
  // Plain touch tracking — no library. Threshold of 60px and a
  // vertical-drift guard so a downward scroll doesn't accidentally
  // fire a swipe. iOS Safari fires touchend after pointer leaves
  // the element, so we attach to the outer container to capture.
  const start = useRef<{ x: number; y: number; t: number } | null>(null);

  function onTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }
  function onTouchEnd(e: React.TouchEvent<HTMLDivElement>) {
    if (!start.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.current.x;
    const dy = t.clientY - start.current.y;
    const dt = Date.now() - start.current.t;
    start.current = null;
    // Reject as a swipe if mostly vertical, too slow, or below the
    // horizontal threshold.
    if (Math.abs(dy) > 60) return;
    if (dt > 800) return;
    if (dx < -60) {
      onSwipeLeft();
    } else if (dx > 60) {
      onSwipeRight();
    }
  }

  return (
    <div
      className="min-h-screen bg-zinc-950 text-zinc-100 max-w-md mx-auto select-none"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {children}
    </div>
  );
}

function ProgressHeader({
  batchName,
  batchMarket,
  index,
  total,
  remaining,
  products,
  onJumpTo,
}: {
  batchName: string;
  batchMarket: string;
  index: number;
  total: number;
  remaining: number;
  products: MobilePostingProduct[];
  onJumpTo: (i: number) => void;
}) {
  return (
    <header className="px-4 pt-4 pb-2">
      <div className="text-[11px] text-zinc-400 uppercase tracking-wide">
        {batchName} · {batchMarket.toUpperCase()} · Posting assist
      </div>
      <div className="mt-1 text-sm text-zinc-200">
        Product <span className="font-medium">{index + 1}</span> of {total}
        {remaining > 0 && (
          <span className="text-zinc-400"> · {remaining} need posting</span>
        )}
      </div>
      {/* Dot row — one dot per product, colored by posting status.
          Taps jump straight to that product. Helps with "let me go
          back to the second one I skipped." */}
      <div className="mt-2 flex flex-wrap gap-1">
        {products.map((p, i) => {
          const isCurrent = i === index;
          const cls =
            p.postingStatus === "posted"
              ? "bg-green-500"
              : p.postingStatus === "skipped"
                ? "bg-zinc-600"
                : "bg-orange-500";
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onJumpTo(i)}
              className={`h-2 ${
                isCurrent ? "w-6 ring-2 ring-blue-400/60" : "w-2"
              } rounded-full ${cls} transition-all`}
              aria-label={`Jump to product ${i + 1}`}
            />
          );
        })}
      </div>
    </header>
  );
}

function ProductHeader({ product }: { product: MobilePostingProduct }) {
  return (
    <div className="px-4 pt-3 flex gap-3 items-start">
      <div className="w-20 h-20 shrink-0 rounded-xl bg-zinc-900 overflow-hidden">
        {product.referenceImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.referenceImageUrl}
            alt={product.productName}
            className="w-full h-full object-cover"
          />
        ) : product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.productName}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-500 text-[10px]">
            no img
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-base font-medium text-zinc-100 leading-tight line-clamp-3">
          {product.productName}
        </h1>
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center text-xs px-2.5 py-1 rounded-full ${STATUS_PILL[product.postingStatus].bg} ${STATUS_PILL[product.postingStatus].text}`}
          >
            {STATUS_PILL[product.postingStatus].label}
          </span>
          {product.tiktokUrl ? (
            <a
              href={product.tiktokUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center text-xs px-3 py-1 rounded-full bg-blue-500/15 text-blue-300 active:bg-blue-500/30"
            >
              Open in TikTok Shop ↗
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ left, right }: { left: string; right?: string | null }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-wide text-zinc-400">{left}</span>
      {right ? <span className="text-[11px] text-zinc-500">{right}</span> : null}
    </div>
  );
}

function CopyCard({
  value,
  empty,
  subLabel,
  accent,
}: {
  value: string | null;
  empty: string;
  subLabel?: string;
  accent: "hook" | "caption" | "hashtags";
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const hasValue = !!value && value.trim().length > 0;

  async function copy() {
    if (!hasValue || !value) return;
    setError(false);
    try {
      if (navigator.clipboard?.writeText) {
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
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  }

  const ringColor =
    accent === "hook"
      ? "ring-blue-500/50"
      : accent === "caption"
        ? "ring-purple-500/50"
        : "ring-pink-500/50";
  const bgColor =
    copied
      ? "bg-green-600/30 ring-2 ring-green-500/60"
      : `bg-zinc-900 active:bg-zinc-800 ring-1 ${ringColor}`;

  return (
    <button
      type="button"
      onClick={copy}
      disabled={!hasValue}
      className={`w-full text-left rounded-2xl p-4 transition-colors ${bgColor} disabled:opacity-50 disabled:active:bg-zinc-900`}
    >
      {subLabel && (
        <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
          {subLabel}
        </div>
      )}
      <div
        className={`text-base leading-relaxed break-words whitespace-pre-wrap ${
          hasValue ? "text-zinc-100" : "text-zinc-500 italic"
        }`}
      >
        {hasValue ? value : empty}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">
          {error ? "Copy failed" : copied ? "Copied ✓" : "Tap card to copy"}
        </span>
        <span className="text-xl">
          {copied ? "✓" : error ? "✗" : "📋"}
        </span>
      </div>
    </button>
  );
}

function VariantCycler({
  count,
  index,
  onChange,
}: {
  count: number;
  index: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={() => onChange((index - 1 + count) % count)}
        className="py-2 rounded-xl bg-zinc-900 active:bg-zinc-800 text-sm text-zinc-300 border border-zinc-800"
      >
        ← Prev variant
      </button>
      <button
        type="button"
        onClick={() => onChange((index + 1) % count)}
        className="py-2 rounded-xl bg-zinc-900 active:bg-zinc-800 text-sm text-zinc-300 border border-zinc-800"
      >
        Next variant →
      </button>
    </div>
  );
}

function DoneScreen({
  batchName,
  batchMarket,
  counts,
  total,
  onReviewAgain,
}: {
  batchName: string;
  batchMarket: string;
  counts: Record<PostingStatus, number>;
  total: number;
  onReviewAgain: () => void;
}) {
  return (
    <Shell>
      <div className="px-6 pt-16 pb-8 text-center">
        <div className="text-5xl mb-4">✓</div>
        <h1 className="text-2xl font-semibold text-zinc-100">
          You&apos;re done!
        </h1>
        <p className="mt-2 text-sm text-zinc-400">
          Posted (or skipped) {total} product{total === 1 ? "" : "s"} in{" "}
          <span className="text-zinc-200">{batchName}</span>{" "}
          ({batchMarket.toUpperCase()})
        </p>
      </div>
      <div className="px-6 space-y-2">
        <SummaryRow
          label="Posted"
          count={counts.posted}
          color="bg-green-500/15 text-green-400"
        />
        <SummaryRow
          label="Skipped"
          count={counts.skipped}
          color="bg-zinc-500/15 text-zinc-300"
        />
        {counts.needs_posting > 0 && (
          <SummaryRow
            label="Still needs posting"
            count={counts.needs_posting}
            color="bg-orange-500/15 text-orange-400"
          />
        )}
      </div>
      <div className="px-6 pt-8 pb-12">
        <button
          type="button"
          onClick={onReviewAgain}
          className="w-full py-3 rounded-2xl bg-zinc-800 active:bg-zinc-700 text-sm text-zinc-300"
        >
          Return to first product
        </button>
        <p className="mt-4 text-xs text-zinc-500 text-center">
          Close this page when finished. The batch owner sees your
          decisions on the desktop dashboard immediately.
        </p>
      </div>
    </Shell>
  );
}

function SummaryRow({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3 rounded-2xl bg-zinc-900">
      <span className="text-sm text-zinc-300">{label}</span>
      <span
        className={`text-sm px-2.5 py-0.5 rounded-full font-medium ${color}`}
      >
        {count}
      </span>
    </div>
  );
}

function EmptyScreen({
  batchName,
  batchMarket,
}: {
  batchName: string;
  batchMarket: string;
}) {
  return (
    <div className="px-6 pt-24 pb-8 text-center">
      <h1 className="text-xl font-medium text-zinc-100">
        No products ready to post
      </h1>
      <p className="mt-3 text-sm text-zinc-400">
        Batch <span className="text-zinc-200">{batchName}</span>{" "}
        ({batchMarket.toUpperCase()}) has no approved products yet.
      </p>
      <p className="mt-3 text-xs text-zinc-500">
        Approve products from the desktop dashboard (or the mobile
        review QR) before opening this page.
      </p>
    </div>
  );
}
