"use client";

/**
 * Phone-first product review UI.
 *
 * Layout: one product per screen. Big image at the top, name +
 * persistent "Open in TikTok Shop" chip, four big buttons
 * (Approve / Maybe / Reject / Delete), Prev / Next nav at the
 * bottom. Touch targets sized for thumb operation.
 *
 * State machine: the client tracks which product index the user
 * is on. Each status-change action calls a server action; on
 * success we auto-advance to the next still-needs-review product
 * (so the user blasts through approvals without manual Next).
 * When every product has been touched, render the "You're done!"
 * end-state screen with the per-status counts.
 *
 * Network failures don't lose the user's place — we keep the
 * current index, surface a small toast, and let them retry.
 */

import { useMemo, useState, useTransition } from "react";
import {
  setProductReviewStatusViaToken,
  softDeleteProductViaToken,
} from "@/app/batches/actions";

export type ReviewStatus =
  | "needs_review"
  | "approved"
  | "rejected"
  | "maybe";

export interface MobileProduct {
  id: string;
  productName: string;
  tiktokUrl: string | null;
  referenceImageUrl: string | null;
  imageUrl: string | null;
  category: string | null;
  reviewStatus: ReviewStatus;
}

const STATUS_LABEL: Record<ReviewStatus, string> = {
  needs_review: "Needs review",
  approved:     "Approved",
  rejected:     "Rejected",
  maybe:        "Maybe",
};

const STATUS_PILL: Record<
  ReviewStatus,
  { bg: string; text: string }
> = {
  needs_review: { bg: "bg-orange-500/15", text: "text-orange-400" },
  approved:     { bg: "bg-green-500/15",  text: "text-green-400" },
  rejected:     { bg: "bg-red-500/15",    text: "text-red-400" },
  maybe:        { bg: "bg-zinc-500/15",   text: "text-zinc-300" },
};

export default function MobileReviewClient({
  token,
  batchName,
  batchMarket,
  products: initial,
}: {
  token: string;
  batchName: string;
  batchMarket: string;
  products: MobileProduct[];
}) {
  // Local mirror of the product list so an action-induced
  // reviewStatus change is reflected instantly without waiting
  // for the server revalidation round-trip. The Next.js
  // revalidatePath also runs but the client-local update fixes
  // perceived latency on mobile.
  const [products, setProducts] = useState<MobileProduct[]>(initial);
  const [index, setIndex] = useState<number>(() =>
    // Land the user on the first needs_review product. Falls back
    // to 0 if everything is already triaged (which would also
    // render the "you're done" state on first render).
    Math.max(
      0,
      initial.findIndex((p) => p.reviewStatus === "needs_review"),
    ),
  );
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<ReviewStatus | "deleted", number> = {
      needs_review: 0,
      approved:     0,
      rejected:     0,
      maybe:        0,
      deleted:      0,
    };
    for (const p of products) {
      c[p.reviewStatus] = (c[p.reviewStatus] ?? 0) + 1;
    }
    return c;
  }, [products]);

  const remaining = counts.needs_review;
  const done = remaining === 0 && products.length > 0;
  const current = products[index] ?? null;

  // After every action, advance to the next remaining-needs-review
  // product if there is one. Otherwise stop — caller will see the
  // "you're done" state.
  function advanceToNext(fromIndex: number): void {
    for (let i = fromIndex + 1; i < products.length; i++) {
      if (products[i].reviewStatus === "needs_review") {
        setIndex(i);
        return;
      }
    }
    // Wrap to the start in case we left some unresolved earlier.
    for (let i = 0; i < fromIndex; i++) {
      if (products[i].reviewStatus === "needs_review") {
        setIndex(i);
        return;
      }
    }
    // Nothing left — hold position; the done state will render.
  }

  function applyStatus(status: ReviewStatus): void {
    if (!current || pending) return;
    const productId = current.id;
    const i = index;
    setErrorMsg(null);
    startTransition(async () => {
      const r = await setProductReviewStatusViaToken({
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
          p.id === productId ? { ...p, reviewStatus: status } : p,
        ),
      );
      advanceToNext(i);
    });
  }

  function applyDelete(): void {
    if (!current || pending) return;
    const productId = current.id;
    const i = index;
    setErrorMsg(null);
    startTransition(async () => {
      const r = await softDeleteProductViaToken({ token, productId });
      if (!r.ok) {
        setErrorMsg(r.message ?? "Could not delete. Try again.");
        return;
      }
      // Soft-deleted products drop out of the visible list entirely.
      // Rebuild the array and clamp the index.
      setProducts((prev) => {
        const next = prev.filter((p) => p.id !== productId);
        return next;
      });
      // After removing the current product, the index should land
      // on what was previously index+1. But because the array
      // shrank by one, "index" already points there. Clamp to
      // the new length.
      setIndex((cur) =>
        Math.min(cur, Math.max(0, products.length - 2)),
      );
    });
  }

  // Render the done state when there's nothing left to review.
  // Comes BEFORE the "no products" empty state so an empty batch
  // doesn't show "you're done" prematurely.
  if (done) {
    return (
      <DoneScreen
        batchName={batchName}
        batchMarket={batchMarket}
        counts={counts}
        total={products.length}
        onReviewAgain={() => {
          // Reset back to the first product so the user can flip
          // statuses if they want.
          setIndex(0);
        }}
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
      {/* Top bar: batch name + progress */}
      <header className="px-4 pt-4 pb-2">
        <div className="text-[11px] text-zinc-400 uppercase tracking-wide">
          {batchName} · {batchMarket.toUpperCase()}
        </div>
        <div className="mt-1 text-sm text-zinc-200">
          Product <span className="font-medium">{index + 1}</span> of {total}
          {remaining > 0 && (
            <span className="text-zinc-400">
              {" "}· {remaining} need review
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

      {/* Image */}
      <div className="mx-4 mt-2 aspect-square rounded-2xl bg-zinc-900 overflow-hidden flex items-center justify-center">
        {current.referenceImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.referenceImageUrl}
            alt={current.productName}
            className="w-full h-full object-contain"
          />
        ) : current.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.imageUrl}
            alt={current.productName}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="text-zinc-500 text-sm">No image</div>
        )}
      </div>

      {/* Name + category + current status + TikTok chip */}
      <section className="px-4 pt-4 space-y-2">
        <h1 className="text-lg font-medium text-zinc-100 leading-tight">
          {current.productName}
        </h1>
        {current.category && (
          <div className="text-xs text-zinc-400">{current.category}</div>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center text-xs px-2.5 py-1 rounded-full ${STATUS_PILL[current.reviewStatus].bg} ${STATUS_PILL[current.reviewStatus].text}`}
          >
            {STATUS_LABEL[current.reviewStatus]}
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
          ) : (
            <span className="inline-flex items-center text-xs px-3 py-1 rounded-full bg-zinc-800 text-zinc-500">
              No TikTok link
            </span>
          )}
        </div>
      </section>

      {/* Big action buttons */}
      <section className="px-4 pt-6 space-y-2.5">
        <ReviewBtn
          label="Approve"
          color="bg-green-600 active:bg-green-700"
          textColor="text-white"
          disabled={pending}
          onTap={() => applyStatus("approved")}
        />
        <ReviewBtn
          label="Maybe"
          color="bg-zinc-700 active:bg-zinc-600"
          textColor="text-zinc-100"
          disabled={pending}
          onTap={() => applyStatus("maybe")}
        />
        <ReviewBtn
          label="Reject"
          color="bg-red-600 active:bg-red-700"
          textColor="text-white"
          disabled={pending}
          onTap={() => applyStatus("rejected")}
        />
        <ReviewBtn
          label="Delete product"
          color="bg-zinc-800 active:bg-zinc-700 border border-zinc-700"
          textColor="text-red-400"
          disabled={pending}
          onTap={applyDelete}
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

function ReviewBtn({
  label,
  color,
  textColor,
  disabled,
  onTap,
}: {
  label: string;
  color: string;
  textColor: string;
  disabled: boolean;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled}
      className={`w-full py-4 rounded-2xl text-base font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${color} ${textColor}`}
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
  counts: Record<ReviewStatus | "deleted", number>;
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
          Reviewed {total} product{total === 1 ? "" : "s"} in{" "}
          <span className="text-zinc-200">{batchName}</span>{" "}
          ({batchMarket.toUpperCase()})
        </p>
      </div>
      <div className="px-6 space-y-2">
        <SummaryRow
          label="Approved"
          count={counts.approved}
          color="bg-green-500/15 text-green-400"
        />
        <SummaryRow
          label="Maybe"
          count={counts.maybe}
          color="bg-zinc-500/15 text-zinc-300"
        />
        <SummaryRow
          label="Rejected"
          count={counts.rejected}
          color="bg-red-500/15 text-red-400"
        />
        {counts.needs_review > 0 && (
          <SummaryRow
            label="Still needs review"
            count={counts.needs_review}
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
          Review again from the start
        </button>
        <p className="mt-4 text-xs text-zinc-500 text-center">
          Close this page when finished. The batch owner will see
          your decisions on the desktop dashboard immediately.
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
      <h1 className="text-xl font-medium text-zinc-100">No products to review</h1>
      <p className="mt-3 text-sm text-zinc-400">
        Batch <span className="text-zinc-200">{batchName}</span>{" "}
        ({batchMarket.toUpperCase()}) has no products yet, or they were
        all deleted.
      </p>
      <p className="mt-3 text-xs text-zinc-500">
        Ask the batch owner to import products on the desktop
        dashboard before refreshing this page.
      </p>
    </div>
  );
}
