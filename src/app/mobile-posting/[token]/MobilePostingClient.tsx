"use client";

/**
 * Phone-first posting-assist UI.
 *
 * Per-product card with copy buttons for hook / caption / hashtags
 * / productDescription, an "Open in TikTok Shop" chip, and three
 * status pills (needs_posting / posted / skipped). The user works
 * down the list, copy-pasting each piece into the TikTok app as
 * they upload manually-downloaded Flow videos.
 *
 * No video upload happens here — the SaaS deliberately doesn't
 * store final videos; the user downloads them from Google Flow
 * and uploads via the TikTok app themselves. This page exists to
 * make the COPY workflow phone-friendly.
 */

import { useMemo, useState, useTransition } from "react";
import { setProductPostingStatusViaToken } from "@/app/batches/actions";
import Style1PostingChecklist from "./Style1PostingChecklist";

export type PostingStatus = "needs_posting" | "posted" | "skipped";

export interface WorkspaceVoicesForPosting {
  ukVoiceId: string | null;
  ukVoiceLabel: string | null;
  usVoiceId: string | null;
  usVoiceLabel: string | null;
  /** Shared CapCut template URL — surfaced as "Open CapCut
   *  template" button in the Style 1 checklist. Null = nudge to
   *  configure on /settings. */
  capCutTemplateUrl: string | null;
}

export interface MobilePostingProduct {
  id: string;
  productName: string;
  tiktokUrl: string | null;
  referenceImageUrl: string | null;
  imageUrl: string | null;
  hook: string | null;
  /** Legacy hook variants list (7-family output). Empty for
   *  Style 1 products — they use style1Kit.copy.partN instead. */
  hookVariants: Array<{
    label: string;
    text: string;
    leverName?: string;
  }>;
  caption: string | null;
  hashtags: string[];
  productDescription: string | null;
  /** Short (<=30 char) text for the TikTok link-sticker label. */
  productLinkDescription: string | null;
  postingStatus: PostingStatus;
  postingNotes: string | null;
  /** Style 1 additions. All null for legacy pre-Style-1 rows;
   *  those keep rendering via the legacy copy-block UI. */
  discountPercent: number | null;
  style1Kit: string | null;
  chosenCopyPart1: string | null;
  chosenCopyPart2: string | null;
  chosenCopyPart3: string | null;
}

/** Hard limit for productLinkDescription. TikTok truncates the
 *  visible link-sticker label; 30 chars keeps it readable on a
 *  phone-width feed view without ellipsis. */
const PRODUCT_LINK_DESC_MAX = 30;

const STATUS_LABEL: Record<PostingStatus, string> = {
  needs_posting: "Needs posting",
  posted:        "Posted",
  skipped:       "Skipped",
};

const STATUS_PILL: Record<
  PostingStatus,
  { bg: string; text: string }
> = {
  needs_posting: { bg: "bg-orange-500/15", text: "text-orange-400" },
  posted:        { bg: "bg-green-500/15",  text: "text-green-400" },
  skipped:       { bg: "bg-zinc-500/15",   text: "text-zinc-300" },
};

export default function MobilePostingClient({
  token,
  batchName,
  batchMarket,
  products: initial,
  voices,
}: {
  token: string;
  batchName: string;
  batchMarket: string;
  products: MobilePostingProduct[];
  voices: WorkspaceVoicesForPosting;
}) {
  const [products, setProducts] = useState<MobilePostingProduct[]>(initial);
  const [index, setIndex] = useState<number>(() =>
    Math.max(
      0,
      initial.findIndex((p) => p.postingStatus === "needs_posting"),
    ),
  );
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<PostingStatus, number> = {
      needs_posting: 0,
      posted:        0,
      skipped:       0,
    };
    for (const p of products) c[p.postingStatus]++;
    return c;
  }, [products]);

  const remaining = counts.needs_posting;
  const done = remaining === 0 && products.length > 0;
  const current = products[index] ?? null;

  function advanceToNext(fromIndex: number): void {
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
        prev.map((p) =>
          p.id === productId ? { ...p, postingStatus: status } : p,
        ),
      );
      // Only auto-advance when marking posted / skipped — if the
      // user reset to needs_posting they probably want to stay on
      // the current product.
      if (status !== "needs_posting") {
        advanceToNext(i);
      }
    });
  }

  if (done) {
    return (
      <DoneScreen
        batchName={batchName}
        batchMarket={batchMarket}
        counts={counts}
        total={products.length}
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

  const total = products.length;
  const progress = ((index + 1) / total) * 100;

  return (
    <Shell>
      {/* Top bar */}
      <header className="px-4 pt-4 pb-2">
        <div className="text-[11px] text-zinc-400 uppercase tracking-wide">
          {batchName} · {batchMarket.toUpperCase()} · Posting assist
        </div>
        <div className="mt-1 text-sm text-zinc-200">
          Product <span className="font-medium">{index + 1}</span> of {total}
          {remaining > 0 && (
            <span className="text-zinc-400">
              {" "}· {remaining} need posting
            </span>
          )}
        </div>
        <div className="mt-2 h-1 w-full bg-zinc-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      {/* Image + name */}
      <div className="px-4 pt-2 flex gap-3 items-start">
        <div className="w-20 h-20 shrink-0 rounded-xl bg-zinc-900 overflow-hidden">
          {current.referenceImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={current.referenceImageUrl}
              alt={current.productName}
              className="w-full h-full object-cover"
            />
          ) : current.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={current.imageUrl}
              alt={current.productName}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-500 text-[10px]">
              no img
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <CopyableTitle value={current.productName} />
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center text-xs px-2.5 py-1 rounded-full ${STATUS_PILL[current.postingStatus].bg} ${STATUS_PILL[current.postingStatus].text}`}
            >
              {STATUS_LABEL[current.postingStatus]}
            </span>
            {current.tiktokUrl ? (
              <a
                href={current.tiktokUrl}
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

      {/* Style 1 checklist takes over completely when the product
          has a kit — the checklist covers everything the operator
          needs (Flow script, voice, all 3 parts of copy,
          hashtags, posting reminders). Legacy pre-Style-1 rows
          fall through to the flat copy blocks below. */}
      {current.style1Kit ? (
        <Style1PostingChecklist
          token={token}
          batchMarket={batchMarket}
          product={{
            id:              current.id,
            style1Kit:       current.style1Kit,
            chosenCopyPart1: current.chosenCopyPart1,
            chosenCopyPart2: current.chosenCopyPart2,
            chosenCopyPart3: current.chosenCopyPart3,
          }}
          voices={voices}
          onLocalChosenUpdate={(part, text) => {
            // Optimistic local write so a re-render of the same
            // card shows the pick as "chosen" immediately, without
            // waiting for the server round-trip / page revalidate.
            setProducts((prev) =>
              prev.map((p) =>
                p.id === current.id
                  ? {
                      ...p,
                      chosenCopyPart1:
                        part === "1" ? text : p.chosenCopyPart1,
                      chosenCopyPart2:
                        part === "2" ? text : p.chosenCopyPart2,
                      chosenCopyPart3:
                        part === "3" ? text : p.chosenCopyPart3,
                    }
                  : p,
              ),
            );
          }}
        />
      ) : (
        <section className="px-4 pt-5 space-y-3">
          {/* Legacy path — flat copy blocks for pre-Style-1 rows. */}
          {current.hookVariants.length > 0 ? (
            <div className="space-y-2.5">
              <div className="text-[11px] text-zinc-400 uppercase tracking-wide">
                Hook variants ({current.hookVariants.length}) — pick one per post
              </div>
              {current.hookVariants.map((v, i) => (
                <CopyBlock
                  key={`${v.label}-${i}`}
                  label={
                    v.leverName
                      ? `Hook · ${v.label} — ${v.leverName}`
                      : `Hook · ${v.label}`
                  }
                  value={v.text}
                  placeholder=""
                  multiline
                />
              ))}
            </div>
          ) : (
            <CopyBlock
              label="Hook"
              value={current.hook}
              placeholder="No hook generated yet. Run AI prompts on the desktop."
              multiline
            />
          )}
          <CopyBlock
            label="Caption"
            value={current.caption}
            placeholder="No caption yet."
          />
          <CopyBlock
            label="Hashtags"
            value={current.hashtags.length > 0 ? current.hashtags.join(" ") : null}
            placeholder="No hashtags yet."
          />
          <CopyBlock
            label="Product description"
            value={current.productDescription}
            placeholder="No description yet."
            multiline
          />
          <CopyBlock
            label={`Product link description (${
              current.productLinkDescription?.length ?? 0
            }/${PRODUCT_LINK_DESC_MAX})`}
            value={current.productLinkDescription}
            placeholder={`Up to ${PRODUCT_LINK_DESC_MAX} chars — TikTok link-sticker overlay. Re-run AI prompts to fill.`}
            warning={
              current.productLinkDescription &&
              current.productLinkDescription.length > PRODUCT_LINK_DESC_MAX
                ? `Over ${PRODUCT_LINK_DESC_MAX} chars — TikTok will truncate.`
                : null
            }
          />
        </section>
      )}

      {/* Status pill row */}
      <section className="px-4 pt-6 grid grid-cols-3 gap-2">
        <StatusBtn
          label="Posted"
          color="bg-green-600 active:bg-green-700"
          active={current.postingStatus === "posted"}
          disabled={pending}
          onTap={() => applyStatus("posted")}
        />
        <StatusBtn
          label="Skip"
          color="bg-zinc-700 active:bg-zinc-600"
          active={current.postingStatus === "skipped"}
          disabled={pending}
          onTap={() => applyStatus("skipped")}
        />
        <StatusBtn
          label="Reset"
          color="bg-zinc-800 border border-zinc-700 active:bg-zinc-700"
          active={current.postingStatus === "needs_posting"}
          disabled={pending}
          onTap={() => applyStatus("needs_posting")}
        />
      </section>

      {/* Prev/Next nav */}
      <nav className="px-4 pt-5 pb-6 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0 || pending}
          className="px-4 py-2 text-sm text-zinc-300 disabled:text-zinc-600"
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(total - 1, i + 1))}
          disabled={index >= total - 1 || pending}
          className="px-4 py-2 text-sm text-zinc-300 disabled:text-zinc-600"
        >
          Next →
        </button>
      </nav>

      {errorMsg && (
        <div className="fixed bottom-4 left-4 right-4 rounded-xl bg-red-600 text-white text-sm px-3 py-2 shadow-lg">
          {errorMsg}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 max-w-md mx-auto">
      {children}
    </div>
  );
}

function CopyBlock({
  label,
  value,
  placeholder,
  multiline,
  warning,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  multiline?: boolean;
  /** Optional small warning shown below the value (e.g. for the
   *  product-link-description over-30-chars case). */
  warning?: string | null;
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

  let btnLabel = "Copy";
  if (copied) btnLabel = "Copied ✓";
  if (error) btnLabel = "Failed";

  return (
    <div className="rounded-2xl bg-zinc-900 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wide text-zinc-400">
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          disabled={!hasValue}
          className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
            hasValue
              ? "bg-blue-500/15 text-blue-300 active:bg-blue-500/30"
              : "bg-zinc-800 text-zinc-500"
          }`}
        >
          {btnLabel}
        </button>
      </div>
      <div
        className={`text-sm text-zinc-100 break-words ${
          multiline ? "leading-relaxed" : "leading-snug"
        } ${!hasValue ? "text-zinc-500 italic" : ""}`}
      >
        {hasValue ? value : placeholder}
      </div>
      {warning ? (
        <div className="mt-1.5 text-[11px] text-orange-400">
          {warning}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Title row at the top of each product card — shares CopyBlock's
 * copy-to-clipboard behaviour but renders inline so the image +
 * status pills stay alongside. Pre-redesign the title was an h1
 * with no copy button; the user explicitly asked for the title
 * to be copy-able again.
 */
function CopyableTitle({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  async function copy() {
    if (!value) return;
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

  let btnLabel = "Copy";
  if (copied) btnLabel = "Copied ✓";
  if (error) btnLabel = "Failed";

  return (
    <div className="flex items-start gap-2">
      <h1 className="text-base font-medium text-zinc-100 leading-tight flex-1 min-w-0 break-words">
        {value}
      </h1>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 text-[11px] px-2 py-1 rounded-full bg-blue-500/15 text-blue-300 active:bg-blue-500/30"
      >
        {btnLabel}
      </button>
    </div>
  );
}

function StatusBtn({
  label,
  color,
  active,
  disabled,
  onTap,
}: {
  label: string;
  color: string;
  active: boolean;
  disabled: boolean;
  onTap: () => void;
}) {
  // When active, show a ring around the button so the current
  // status is visually obvious. When inactive, keep the colour
  // but make the ring transparent.
  const ringClass = active
    ? "ring-2 ring-blue-400/60"
    : "ring-0";
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled}
      className={`py-3 rounded-2xl text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${color} ${ringClass}`}
    >
      {label}
    </button>
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
