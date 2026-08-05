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

export type IpRiskStatus =
  | "unchecked"
  | "low"
  | "medium"
  | "high"
  | "needs_manual_review";

export interface MobileProduct {
  id: string;
  productName: string;
  tiktokUrl: string | null;
  referenceImageUrl: string | null;
  imageUrl: string | null;
  category: string | null;
  reviewStatus: ReviewStatus;
  /** Phase 9 — IP / trademark risk verdict. High and needs_review
   *  change the default action emphasis (Reject becomes the primary
   *  action) and surface a warning banner. */
  ipRiskStatus: IpRiskStatus;
  ipRiskReasons: string[];
  ipRiskOverride: boolean;
  /** TikTok Shop discount % the reviewer captured (integer 1..100)
   *  or null. Persisted server-side; feeds the APEX prompt
   *  generator's %-dependent hook variants when the reviewer taps
   *  Approve. */
  discountPercent: number | null;
  /** Whether the discount is a claimable voucher/coupon or a real
   *  sale price. Drives the exact word ("voucher"/"coupon" vs
   *  "sale") the LLM uses across all copy. Null → defaults to
   *  voucher/coupon per market. */
  discountType: "voucher" | "sale" | null;
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
  // Discount % text buffer, keyed by product id. Stored as text so
  // "empty" is distinguishable from "0" (empty → no discount, sent
  // as null; anything else parsed to int at approve time). Seeded
  // from each product's persisted discountPercent on first render.
  const [discountText, setDiscountText] = useState<Record<string, string>>(
    () =>
      Object.fromEntries(
        initial.map((p) => [
          p.id,
          p.discountPercent != null ? String(p.discountPercent) : "",
        ]),
      ),
  );
  // Discount type per product ("voucher" | "sale"). Defaults to
  // voucher when the product has no persisted pick — matches the
  // SOP bait-and-switch safe default. Persisted on Approve.
  const [discountType, setDiscountType] = useState<
    Record<string, "voucher" | "sale">
  >(() =>
    Object.fromEntries(
      initial.map((p) => [p.id, p.discountType === "sale" ? "sale" : "voucher"]),
    ),
  );
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
    // Parse the discount % text for this product. Empty / invalid
    // input → null (server treats null as "no discount"). Server
    // re-validates 1..100 so any garbage from a malicious client
    // still lands as null.
    const raw = (discountText[productId] ?? "").trim();
    const parsed = raw === "" ? null : Number(raw);
    const discountPercent =
      typeof parsed === "number" &&
      Number.isFinite(parsed) &&
      parsed > 0 &&
      parsed <= 100
        ? Math.round(parsed)
        : null;
    // Send discountType alongside discountPercent — server ignores
    // it for non-approve statuses but there's no harm persisting
    // the operator's pick regardless.
    const dt = discountType[productId] ?? "voucher";
    setErrorMsg(null);
    startTransition(async () => {
      let r: { ok: boolean; message?: string };
      try {
        r = await setProductReviewStatusViaToken({
          token,
          productId,
          status,
          discountPercent,
          discountType: dt,
        });
      } catch (e) {
        // A raw throw from the server action ends up here — most
        // often a transport error or an unhandled exception the
        // action forgot to wrap. Surface it so the reviewer isn't
        // left staring at a button that did nothing.
        setErrorMsg(
          `Save failed: ${(e as Error).message?.slice(0, 200) || "unknown error"}`,
        );
        return;
      }
      if (!r.ok) {
        setErrorMsg(r.message ?? "Could not save status. Try again.");
        return;
      }
      // If the server saved but flagged a partial-success
      // condition (e.g. discountPercent column missing on this
      // deployment), keep the reviewer moving but surface the
      // note as a non-blocking warning banner.
      if (r.message) {
        setErrorMsg(r.message);
      }
      setProducts((prev) =>
        prev.map((p) =>
          p.id === productId
            ? { ...p, reviewStatus: status, discountPercent, discountType: dt }
            : p,
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

      {/* Discount % capture — reviewer opens the TikTok Shop link
          above, sees today's actual discount, types it in. When
          Approve fires below, this % is persisted on the Product
          row and used by the APEX hook generator to unlock the
          four %-dependent variants (WAIT_3, DEAL_1, DEAL_5,
          DEAL_6). Leaving blank is fine — the generator falls
          back to the 30 non-% variants. */}
      <section className="px-4 pt-4">
        <label
          htmlFor={`pct-${current.id}`}
          className="block text-[11px] uppercase tracking-wide text-zinc-400 mb-1.5"
        >
          Discount % on TikTok Shop
          <span className="text-zinc-500 normal-case tracking-normal ml-1">
            · optional
          </span>
        </label>
        <div className="relative">
          <input
            id={`pct-${current.id}`}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            placeholder="e.g. 25"
            value={discountText[current.id] ?? ""}
            onChange={(e) =>
              setDiscountText((prev) => ({
                ...prev,
                [current.id]: e.target.value,
              }))
            }
            disabled={pending}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 pr-10 text-lg text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none">
            %
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-500 leading-relaxed">
          Unlocks the four percentage-based hook variants. Leave blank if
          the product isn&apos;t discounted right now.
        </p>

        {/* Sale vs voucher/coupon toggle — SOP bait-and-switch rule.
            Copy will say "20% off voucher" (default) or "20% off sale"
            depending on this pick. */}
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-wide text-zinc-400 mb-1.5">
            Deal type
          </div>
          <div className="grid grid-cols-2 gap-2">
            <DealTypeBtn
              active={(discountType[current.id] ?? "voucher") === "voucher"}
              onClick={() =>
                setDiscountType((prev) => ({
                  ...prev,
                  [current.id]: "voucher",
                }))
              }
              label={
                batchMarket.toLowerCase() === "us"
                  ? "Coupon"
                  : "Voucher"
              }
              hint="Claimable — copy says voucher/coupon"
            />
            <DealTypeBtn
              active={(discountType[current.id] ?? "voucher") === "sale"}
              onClick={() =>
                setDiscountType((prev) => ({
                  ...prev,
                  [current.id]: "sale",
                }))
              }
              label="Sale"
              hint="Real sale price — copy says sale"
            />
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-500 leading-relaxed">
            Only pick Sale when the price is actually reduced. Calling a
            voucher a sale reads as a bait-and-switch when the viewer
            lands on full price.
          </p>
        </div>
      </section>

      {/* Phase 9 — IP / trademark risk banner. Surfaces the verdict
          + reasons on phone reviewers' screens so they can react.
          The wording follows the spec: "potential risk; review
          manually before generating" — never "illegal". When the
          status is high or needs_review AND there's no override,
          the action order below puts Reject first. */}
      {(current.ipRiskStatus === "high" ||
        current.ipRiskStatus === "needs_manual_review" ||
        current.ipRiskStatus === "medium") && (
        <section className="px-4 pt-4">
          <div
            className={`rounded-2xl px-4 py-3 text-sm leading-snug ${
              current.ipRiskStatus === "high"
                ? "bg-red-500/10 border border-red-500/40 text-red-300"
                : "bg-orange-500/10 border border-orange-500/40 text-orange-300"
            }`}
          >
            <div className="font-medium">
              {current.ipRiskStatus === "high"
                ? "Potential HIGH IP/trademark risk"
                : current.ipRiskStatus === "needs_manual_review"
                  ? "Needs manual IP review"
                  : "Potential IP/trademark risk"}
            </div>
            <div className="text-xs mt-1">
              Review manually before generating content. This is not legal
              advice.
            </div>
            {current.ipRiskOverride && (
              <div className="text-[11px] text-green-400 mt-1.5">
                ✓ Override approved on desktop — generation allowed.
              </div>
            )}
            {current.ipRiskReasons.length > 0 && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-zinc-300/80">
                  Reasons ({current.ipRiskReasons.length})
                </summary>
                <ul className="mt-1 list-disc pl-4 text-zinc-300/80 space-y-0.5">
                  {current.ipRiskReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </section>
      )}

      {/* Big action buttons. When the product is HIGH risk (no
          override yet), Reject is shown first + emphasised so a
          casual swipe doesn't accidentally approve an IP-risky
          product. Override-approved high-risk rows revert to the
          normal Approve-first order — the desktop user has already
          made a deliberate decision to allow it. */}
      <section className="px-4 pt-6 space-y-2.5">
        {current.ipRiskStatus === "high" && !current.ipRiskOverride ? (
          <>
            <ReviewBtn
              label="Reject (recommended for HIGH risk)"
              color="bg-red-600 active:bg-red-700"
              textColor="text-white"
              disabled={pending}
              onTap={() => applyStatus("rejected")}
            />
            <ReviewBtn
              label="Maybe — flag for desktop review"
              color="bg-zinc-700 active:bg-zinc-600"
              textColor="text-zinc-100"
              disabled={pending}
              onTap={() => applyStatus("maybe")}
            />
            <ReviewBtn
              label="Approve anyway"
              color="bg-zinc-800 active:bg-zinc-700 border border-zinc-700"
              textColor="text-green-400"
              disabled={pending}
              onTap={() => {
                if (
                  window.confirm(
                    "This product has HIGH potential IP/trademark risk. " +
                      "Approving it lets it through review, but generation " +
                      "will still require a per-product override with a " +
                      "written reason on the desktop. Continue?",
                  )
                ) {
                  applyStatus("approved");
                }
              }}
            />
          </>
        ) : (
          <>
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
          </>
        )}
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

/** Two-state toggle button for the deal-type row (Voucher vs Sale).
 *  Green outline + fill when active; muted otherwise. */
function DealTypeBtn({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl px-3 py-3 border transition-colors ${
        active
          ? "border-green-500/60 bg-green-500/10 text-zinc-100"
          : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-700"
      }`}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[10px] text-zinc-500 mt-0.5">{hint}</div>
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
