"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Panel from "@/components/ui/Panel";
import StatusChip from "@/components/StatusChip";
import EmptyState from "@/components/ui/EmptyState";
import {
  importKalodataForPrompts,
  getBatchPromptsState,
  regenerateApprovedInBatch,
  setChosenCopyPart,
  type BatchPromptsState,
  type BatchPromptsProduct,
  type RecentBatchSummary,
} from "./actions";
import {
  parseStyle1Kit,
  buildGoogleFlowToolInput,
  buildElevenLabsScript,
  type Style1Kit,
} from "@/lib/ai/style1";

/**
 * /prompts hub — redesigned around a product-card grid + mobile
 * posting QR handoff.
 *
 * State model:
 *   Active batch id lives in the URL as `?batch=<id>`. That way
 *   refresh doesn't lose state, the URL is shareable, and there
 *   is exactly one source of truth (no localStorage drift).
 *
 * Layout:
 *   1. Compact import bar   — file picker + optional name +
 *                              "Import & review on phone" button.
 *   2. Active batch panel   — batch header (name, counts, review
 *                              QR link) + product-card grid. Cards
 *                              show image, name, status, discount %,
 *                              and expand inline to show hooks.
 *   3. Recent batches       — quick-jump links when no ?batch is
 *                              set. Deep-links directly to the
 *                              batch's card view.
 *   4. Mobile-posting QR    — appears below the grid the moment
 *                              the first product has hooks ready.
 *                              Points at /mobile-posting/[token].
 *
 * Polling: while a batch is active, poll getBatchPromptsState every
 * 4s so approvals and hook-generation completions surface without
 * a manual refresh.
 */

const POLL_INTERVAL_MS = 4000;

export default function PromptsHubClient({
  initialState,
  recentBatches,
}: {
  /** Server-loaded initial state for the batch pointed at by
   *  ?batch=<id>. Null when no ?batch is set or the batch was
   *  not found. */
  initialState: BatchPromptsState | null;
  /** Recent batches for the quick-jump list when no ?batch is
   *  active. */
  recentBatches: RecentBatchSummary[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeBatchId = searchParams.get("batch");

  const [state, setState] = useState<BatchPromptsState | null>(initialState);

  // Reset local state when the URL batch changes (browser back,
  // manual URL edit, etc.). Server-side initialState comes back
  // in as a new prop but only on full navigation; on route
  // transitions within the same page, we re-fetch here.
  useEffect(() => {
    if (!activeBatchId) {
      setState(null);
      return;
    }
    // If the state we already have matches the URL, skip the
    // extra fetch — polling below handles refresh.
    if (state?.batchId === activeBatchId) return;
    let cancelled = false;
    (async () => {
      const r = await getBatchPromptsState(activeBatchId);
      if (!cancelled) setState(r.ok ? r : null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBatchId]);

  // Poll for the active batch. Stops when no batch is active.
  useEffect(() => {
    if (!activeBatchId) return;
    let cancelled = false;
    const id = setInterval(async () => {
      const r = await getBatchPromptsState(activeBatchId);
      if (cancelled) return;
      if (!r.ok) {
        // Batch disappeared (deleted). Clear the URL and drop out.
        router.replace("/prompts");
        setState(null);
        return;
      }
      setState(r);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activeBatchId, router]);

  return (
    <div className="space-y-6">
      <KalodataImportBar
        onImported={(batchId) => {
          // Preserve state across refresh via URL param — no
          // localStorage drift.
          router.replace(`/prompts?batch=${batchId}`);
        }}
      />

      {state && state.batchId ? (
        <ActiveBatchView state={state} />
      ) : recentBatches.length > 0 ? (
        <RecentBatchesPanel batches={recentBatches} />
      ) : (
        <Panel title="No batches yet" variant="ghost">
          <EmptyState
            icon="◇"
            title="Import a Kalodata workbook to start"
            hint="Pick an XLSX above. The hub creates a batch, hands you a QR to review products on your phone, and generates all seven APEX hook families as you approve — image prompts too."
          />
        </Panel>
      )}
    </div>
  );
}

/* --------------------------------------------------------------
 * Import bar
 * ------------------------------------------------------------ */

function KalodataImportBar({
  onImported,
}: {
  onImported: (batchId: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [batchName, setBatchName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function submit() {
    if (!file) return;
    setError(null);
    const fd = new FormData();
    fd.set("file", file);
    if (batchName.trim()) fd.set("batchName", batchName.trim());
    startTransition(async () => {
      try {
        const r = await importKalodataForPrompts(fd);
        if (!r.ok || !r.batchId) {
          setError(r.message);
          return;
        }
        setFile(null);
        setBatchName("");
        if (inputRef.current) inputRef.current.value = "";
        onImported(r.batchId);
      } catch (e) {
        setError((e as Error).message || "import failed");
      }
    });
  }

  return (
    <Panel title="Import from Kalodata">
      <div className="space-y-3">
        <p className="text-xs text-muted leading-relaxed">
          Upload a Kalodata <code className="id-mono">.xlsx</code> export.
          The hub creates a batch, downloads product images, and hands you a
          QR to review each product on your phone. Approvals auto-generate
          hooks and image prompts.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_minmax(0,240px)_auto] gap-3 items-end">
          <div className="field-row">
            <label className="label" htmlFor="kalodata-file">
              Workbook
            </label>
            <input
              ref={inputRef}
              id="kalodata-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={pending}
              className="text-xs text-text file:btn file:btn-ghost file:mr-3"
            />
          </div>
          <div className="field-row">
            <label className="label" htmlFor="kalodata-name">
              Batch name{" "}
              <span className="normal-case tracking-normal text-muted2 ml-1">
                · optional
              </span>
            </label>
            <input
              id="kalodata-name"
              type="text"
              placeholder="Kalodata · today"
              className="field"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              disabled={pending}
            />
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={!file || pending}
            className="btn btn-primary whitespace-nowrap"
          >
            {pending ? "Importing…" : "Import & review on phone"}
          </button>
        </div>
        {file && <div className="text-[11px] text-muted">Selected: {file.name}</div>}
        {error && <div className="text-[12px] text-bad">{error}</div>}
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------
 * Recent batches quick-jump
 * ------------------------------------------------------------ */

function RecentBatchesPanel({ batches }: { batches: RecentBatchSummary[] }) {
  return (
    <Panel title="Recent batches">
      <div className="space-y-1.5">
        {batches.map((b) => (
          <Link
            key={b.id}
            href={`/prompts?batch=${b.id}`}
            className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl hover:bg-panel2 transition-colors group"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text truncate group-hover:text-accent transition-colors">
                {b.name}
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {b.productCount} product{b.productCount === 1 ? "" : "s"} ·{" "}
                {new Date(b.createdAt).toLocaleDateString()}
              </div>
            </div>
            <span className="text-xs text-muted2 group-hover:text-accent transition-colors">
              Open →
            </span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------
 * Active batch view
 * ------------------------------------------------------------ */

function ActiveBatchView({ state }: { state: BatchPromptsState }) {
  const router = useRouter();
  const [regenPending, startRegenTransition] = useTransition();
  const [regenMsg, setRegenMsg] = useState<string | null>(null);
  const [copiedReview, setCopiedReview] = useState(false);

  const products = state.products ?? [];
  const counts = state.counts ?? {
    total: 0,
    needs_review: 0,
    approved: 0,
    rejected: 0,
    maybe: 0,
    hasHooks: 0,
  };
  const approvedMissingHooks = products.filter(
    (p) => p.reviewStatus === "approved" && p.hookVariants.length === 0 && !p.hook,
  ).length;

  function regenerate() {
    if (!state.batchId) return;
    const batchId = state.batchId;
    setRegenMsg(null);
    startRegenTransition(async () => {
      const r = await regenerateApprovedInBatch(batchId);
      setRegenMsg(r.message);
      setTimeout(() => setRegenMsg(null), 5000);
    });
  }

  function copyReviewUrl() {
    if (!state.reviewUrl) return;
    (async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(state.reviewUrl!);
        } else {
          const ta = document.createElement("textarea");
          ta.value = state.reviewUrl!;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopiedReview(true);
        setTimeout(() => setCopiedReview(false), 1500);
      } catch {
        // ignore
      }
    })();
  }

  return (
    <>
      {/* Batch header ------------------------------------------------ */}
      <Panel
        title={state.batchName ?? "Active batch"}
        action={
          <button
            type="button"
            onClick={() => router.replace("/prompts")}
            className="text-[11px] text-muted hover:text-text transition-colors"
          >
            Close batch
          </button>
        }
      >
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_240px] gap-6 items-start">
          {/* Counts + regenerate control */}
          <div className="space-y-4">
            <div className="flex gap-2 flex-wrap">
              <StatusChip
                label={`${counts.needs_review} needs review`}
                variant={counts.needs_review > 0 ? "warn" : "muted"}
              />
              <StatusChip
                label={`${counts.approved} approved`}
                variant={counts.approved > 0 ? "ok" : "muted"}
              />
              <StatusChip label={`${counts.rejected} rejected`} variant="muted" />
              <StatusChip
                label={`${counts.hasHooks}/${counts.approved || 0} hooks ready`}
                variant={counts.hasHooks > 0 ? "ok" : "muted"}
              />
            </div>

            <div>
              <div className="flex items-center gap-3 flex-wrap">
                {counts.approved > 0 ? (
                  <button
                    type="button"
                    onClick={regenerate}
                    disabled={regenPending}
                    className="btn btn-sm"
                    title={
                      approvedMissingHooks > 0
                        ? `${approvedMissingHooks} approved product${approvedMissingHooks === 1 ? "" : "s"} still missing hooks — regenerate now.`
                        : "Force-regenerate hooks for every approved product using each product's current discount %."
                    }
                  >
                    {regenPending
                      ? "Regenerating…"
                      : approvedMissingHooks > 0
                        ? `Generate hooks for ${approvedMissingHooks} approved`
                        : "Regenerate all approved"}
                  </button>
                ) : (
                  <span className="text-[11px] text-muted italic">
                    Approve products on your phone to auto-generate hooks.
                  </span>
                )}
                {regenMsg && (
                  <span className="text-[11px] text-muted">{regenMsg}</span>
                )}
              </div>
            </div>
          </div>

          {/* Review QR — compact panel on the right */}
          {state.reviewUrl && (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
                Review on phone
              </div>
              {state.reviewQrDataUrl ? (
                <div className="bg-white rounded-2xl p-3 inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={state.reviewQrDataUrl}
                    alt="Mobile review QR"
                    width={180}
                    height={180}
                    className="block"
                  />
                </div>
              ) : null}
              <button
                type="button"
                onClick={copyReviewUrl}
                className="text-[11px] text-accent hover:underline block"
              >
                {copiedReview ? "✓ copied" : "Copy review link"}
              </button>
            </div>
          )}
        </div>
      </Panel>

      {/* Product-card grid ----------------------------------------- */}
      <Panel
        title="Products"
        action={
          <span className="text-[11px] text-muted">
            Click a card to view hooks
          </span>
        }
      >
        {products.length === 0 ? (
          <EmptyState
            icon="◇"
            title="No products in this batch"
            hint="Import a Kalodata workbook to populate a batch."
          />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
            {products.map((p) => (
              <ProductPromptCard key={p.id} product={p} />
            ))}
          </div>
        )}
      </Panel>

      {/* Mobile-posting QR — appears when there's actually work
          to post. */}
      {counts.hasHooks > 0 && state.postingUrl && (
        <MobilePostingQrPanel
          postingUrl={state.postingUrl}
          postingQrDataUrl={state.postingQrDataUrl}
          hasHooksCount={counts.hasHooks}
          approvedCount={counts.approved}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------
 * Product card
 * ------------------------------------------------------------ */

function ProductPromptCard({ product }: { product: BatchPromptsProduct }) {
  const [open, setOpen] = useState(false);

  // Ready = has a Style 1 kit OR (legacy) has the flat hook fields.
  // parseStyle1Kit is deliberately not called here (a JSON.parse per
  // card per poll would be wasteful); presence of the raw string is
  // enough to know generation succeeded.
  const hasHooks =
    !!product.style1Kit || product.hookVariants.length > 0 || !!product.hook;
  const status = product.reviewStatus;

  // Card visual treatment mirrors the batches product cards but
  // pulls in APEX left-border accents based on state — blue for
  // approved-with-hooks (ready), red for rejected, muted for
  // needs_review.
  const cardTone: "ready" | "generating" | "rejected" | "pending" =
    status === "rejected"
      ? "rejected"
      : status === "approved" && hasHooks
        ? "ready"
        : status === "approved"
          ? "generating"
          : "pending";

  const wrapperClass =
    cardTone === "ready"
      ? "card-accent-blue"
      : cardTone === "rejected"
        ? "card-accent-red opacity-60"
        : "panel";

  return (
    <>
      <button
        type="button"
        onClick={() => (hasHooks ? setOpen(true) : undefined)}
        disabled={!hasHooks}
        className={`${wrapperClass} p-3 text-left transition-colors ${hasHooks ? "hover:border-border-strong cursor-pointer" : "cursor-default"}`}
      >
        {/* Image */}
        <div className="aspect-square rounded-xl overflow-hidden bg-panel2 border border-border mb-3 flex items-center justify-center">
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
            <div className="text-muted2 text-[10px]">No image</div>
          )}
        </div>

        {/* Name */}
        <div
          className="text-[13px] font-medium text-text leading-tight mb-2"
          title={product.productName}
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {product.productName}
        </div>

        {/* Review-status chip + discount % badge — persistent
            identity signals that don't depend on gen state. */}
        <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
          <StatusPill status={status} />
          {product.discountPercent != null && (
            <span className="text-[10px] font-mono text-accent-red border border-accent-red/40 bg-accent-red/[0.08] rounded-full px-1.5 py-0.5">
              −{product.discountPercent}%
            </span>
          )}
        </div>

        {/* One clear generation-state chip. Style 1 kit takes
            precedence for the "N hooks" count (15 total across
            three parts when generation ran cleanly); legacy hook
            variants only for pre-Style-1 rows. */}
        <GenerationStatePill
          cardTone={cardTone}
          hookCount={style1HookCount(product) ?? product.hookVariants.length}
          aiPromptError={product.aiPromptError}
          generatedAt={product.aiPromptGeneratedAt}
        />
      </button>

      {open && (
        <ProductKitModal product={product} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone: "ok" | "warn" | "bad" | "muted" =
    status === "approved"
      ? "ok"
      : status === "rejected"
        ? "bad"
        : status === "needs_review"
          ? "warn"
          : "muted";
  const label =
    status === "needs_review" ? "needs review" : status.replace(/_/g, " ");
  return <StatusChip label={label} variant={tone} />;
}

/**
 * Single generation-state chip per card. Rules:
 *
 *   READY  (hooks exist)          → green "✓ N hooks · Xm ago"
 *                                    A stale aiPromptError from a
 *                                    later failed regen attempt does
 *                                    NOT flip this back — hooks are
 *                                    functionally present. We surface
 *                                    the stale-retry note as a small
 *                                    muted tail for transparency.
 *   FAILED (no hooks + error)     → red "gen failed" with error text
 *                                    on hover.
 *   RUNNING (approved, no hooks,  → pulsing blue "generating…"
 *            no error)
 *   IDLE   (rejected / needs_review, no gen state)
 *                                 → renders nothing.
 */
function GenerationStatePill({
  cardTone,
  hookCount,
  aiPromptError,
  generatedAt,
}: {
  cardTone: "ready" | "generating" | "rejected" | "pending";
  hookCount: number;
  aiPromptError: string | null;
  generatedAt: string | null;
}) {
  if (cardTone === "ready" && hookCount > 0) {
    // Success wins over a stale error — hooks are present, so the
    // last SUCCESSFUL generation is what's on disk. If a later retry
    // also failed (aiPromptError set) we hint at it in the tail
    // rather than replacing the ready state.
    return (
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="inline-flex items-center gap-1 text-ok">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" />
          {hookCount} hooks
        </span>
        {generatedAt && (
          <span className="text-muted2">· {formatShortAgo(generatedAt)}</span>
        )}
        {aiPromptError && (
          <span
            className="text-muted2 italic truncate"
            title={`Latest retry failed: ${aiPromptError}`}
          >
            · retry failed
          </span>
        )}
      </div>
    );
  }
  if (cardTone === "generating") {
    if (aiPromptError) {
      return (
        <div
          className="inline-flex items-center gap-1 text-[10px] text-bad"
          title={aiPromptError}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-bad" />
          <span>gen failed</span>
          <span className="text-muted2 italic truncate">
            · {shortError(aiPromptError)}
          </span>
        </div>
      );
    }
    return (
      <div className="inline-flex items-center gap-1 text-[10px] text-accent">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
        <span className="italic">generating…</span>
      </div>
    );
  }
  // rejected / pending — no gen state chip.
  return null;
}

/** "Xm ago" / "Xh ago" / "just now" — the same shape the batches
 *  page uses for its timeAgo. Kept local so we don't drag in the
 *  shared helper (would need to be re-exported client-side). */
function formatShortAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** First short segment of an error string. LLM SDK errors are noisy
 *  ("BadRequestError: 400 Bad Request: ..."); a card only needs the
 *  head so the row doesn't wrap. Full text on hover via title. */
function shortError(err: string): string {
  const trimmed = err.trim();
  const cutAt = Math.min(
    trimmed.indexOf(":") + 1 || trimmed.length,
    40,
  );
  return trimmed.slice(0, cutAt).trim() || "error";
}

/* --------------------------------------------------------------
 * Product hooks modal
 * ------------------------------------------------------------ */

/** Count how many copy options a Style 1 kit contains (5 per part
 *  when generation ran cleanly, so 15 total). Returns null when the
 *  kit is missing / malformed so the caller can fall back to the
 *  legacy hookVariants count. */
function style1HookCount(p: BatchPromptsProduct): number | null {
  const kit = parseStyle1Kit(p.style1Kit);
  if (!kit) return null;
  return (
    kit.copy.part1Options.length +
    kit.copy.part2Options.length +
    kit.copy.part3Options.length
  );
}

/**
 * Product kit modal — Style 1's full video kit as the primary
 * shape. Legacy 7-family products (no style1Kit) render a
 * "regenerate to get the Style 1 kit" empty state.
 */
function ProductKitModal({
  product,
  onClose,
}: {
  product: BatchPromptsProduct;
  onClose: () => void;
}) {
  // Escape key closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const kit = useMemo(
    () => parseStyle1Kit(product.style1Kit),
    [product.style1Kit],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 md:p-8 overflow-y-auto"
      style={{ background: "rgba(10,16,32,0.7)" }}
      onClick={onClose}
    >
      <div
        className="panel max-w-3xl w-full my-8 relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — product identity + close */}
        <div className="p-5 border-b border-border flex items-start gap-4">
          <div className="w-16 h-16 rounded-xl overflow-hidden border border-border bg-panel2 flex-shrink-0">
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
            ) : null}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text">
              {kit?.productName || product.productName}
            </div>
            <div className="text-[11px] text-muted mt-1 flex items-center gap-2 flex-wrap">
              {product.discountPercent != null && (
                <span className="font-mono text-accent-red">
                  −{product.discountPercent}%
                </span>
              )}
              {kit?.market && <span>{kit.market}</span>}
              {kit?.category && <span>· {kit.category}</span>}
              {product.category && !kit && (
                <span>{product.category}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-text transition-colors text-lg leading-none w-7 h-7 flex items-center justify-center rounded-full"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {kit ? (
            <Style1KitContents kit={kit} product={product} />
          ) : (
            <LegacyProductContents product={product} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Style 1 kit renderer — post-pivot (2026-08).
 *
 * The kit no longer contains Flow scene prompts (those come from
 * the operator's external Google Flow tool now). This modal
 * surfaces, in order:
 *   1. Google Flow tool input — the three-line block the operator
 *      pastes into their tool to produce the Flow scenes.
 *   2. Part 1 / Part 2 / Part 3 copy options (5 each, tap-to-pick
 *      persists via the mobile posting page).
 *   3. ElevenLabs script — Part 1 + Part 2 back-to-back, composed
 *      from the operator's picks (or option 1 fallback).
 *   4. Hashtag block.
 *   5. Product description (TikTok caption lead-in).
 *   6. Any LLM warnings.
 */
function Style1KitContents({
  kit,
  product,
}: {
  kit: Style1Kit;
  product: BatchPromptsProduct;
}) {
  const flowInput = useMemo(() => buildGoogleFlowToolInput(kit), [kit]);

  // Local pick state — starts from the persisted values but
  // updates optimistically on tap so the ElevenLabs script
  // preview re-composes instantly (no server round-trip in the
  // render path). Server write fires in a transition below.
  const [chosen1, setChosen1] = useState<string | null>(
    product.chosenCopyPart1,
  );
  const [chosen2, setChosen2] = useState<string | null>(
    product.chosenCopyPart2,
  );
  const [chosen3, setChosen3] = useState<string | null>(
    product.chosenCopyPart3,
  );
  const [, startPickTransition] = useTransition();
  const persistPick = (part: "1" | "2" | "3", text: string) => {
    startPickTransition(async () => {
      await setChosenCopyPart({
        productId: product.id,
        part,
        text,
      });
    });
  };

  const elevenLabsScript = useMemo(
    () => buildElevenLabsScript(kit, chosen1, chosen2),
    [kit, chosen1, chosen2],
  );

  return (
    <>
      {/* 1. Google Flow tool input */}
      <div className="card-accent-blue p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[11px] uppercase tracking-[0.14em] text-accent">
            Google Flow tool input
          </div>
          <CopyButton text={flowInput} />
        </div>
        <p className="text-[11px] text-muted leading-relaxed">
          Paste these three lines into your external Google Flow tool.
          It handles the Flow scene generation.
        </p>
        <pre className="text-[12px] leading-relaxed text-text bg-bg/60 border border-border rounded-xl px-3 py-2 whitespace-pre-wrap font-mono">
          {flowInput}
        </pre>
      </div>

      {/* 2. Copy options — 5 per part. Tap on desktop persists
          via setChosenCopyPart (workspace-auth) AND updates local
          state so the ElevenLabs script below re-composes instantly. */}
      <CopyOptionsBlock
        label="Part 1 · hook (on-screen Scene 1 + spoken)"
        hint="Displayed on Scene 1 AND read by ElevenLabs across the full ~8s. Tap to pick — the ElevenLabs script below updates live."
        options={kit.copy.part1Options}
        chosen={chosen1}
        onPick={(text) => {
          setChosen1(text);
          persistPick("1", text);
        }}
      />
      <CopyOptionsBlock
        label="Part 2 · voiceover (spoken over Scene 2)"
        hint="Spoken only, ~8s. Pasted into ElevenLabs after Part 1 to make one 16s voice file."
        options={kit.copy.part2Options}
        chosen={chosen2}
        onPick={(text) => {
          setChosen2(text);
          persistPick("2", text);
        }}
      />
      <CopyOptionsBlock
        label="Part 3 · on-screen sale text (Scene 2, ≤10 words)"
        hint="Shown on Scene 2 for the whole clip. Not read aloud."
        options={kit.copy.part3Options}
        chosen={chosen3}
        onPick={(text) => {
          setChosen3(text);
          persistPick("3", text);
        }}
      />

      {/* 3. ElevenLabs script — composed from picks */}
      {elevenLabsScript && (
        <div className="card-accent-blue p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-[11px] uppercase tracking-[0.14em] text-accent">
              ElevenLabs script (Part 1 + Part 2)
            </div>
            <CopyButton text={elevenLabsScript} />
          </div>
          <p className="text-[11px] text-muted leading-relaxed">
            Paste into your saved voice (Stability ~40%). Uses your
            picks when set, otherwise falls back to option 1 of each
            Part. Blank line between = the CapCut cut.
          </p>
          <pre className="text-[12px] leading-relaxed text-text bg-bg/60 border border-border rounded-xl px-3 py-2 whitespace-pre-wrap">
            {elevenLabsScript}
          </pre>
        </div>
      )}

      {/* 4. Hashtag block */}
      {kit.hashtags.length > 0 && (
        <PromptRow
          label="Hashtag block"
          text={kit.hashtags.join(" ")}
          hint="#AIGC required for AI-generated content disclosure. Swap #weekendsale for a live campaign hashtag at post time."
        />
      )}

      {/* 5. Product description (TikTok caption lead-in) */}
      {kit.productDescription && (
        <PromptRow
          label="Product description (TikTok caption)"
          text={kit.productDescription}
          hint="One-line lead-in for the TikTok caption, above the hashtag block."
        />
      )}

      {/* 6. LLM warnings */}
      {kit.warnings.length > 0 && (
        <div className="card-accent-red p-3 space-y-1">
          <div className="text-[10px] uppercase tracking-[0.14em] text-accent-red">
            Warnings
          </div>
          <ul className="text-[11px] text-muted leading-relaxed list-disc list-inside">
            {kit.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * Legacy pre-Style-1 product renderer — flat imagePrompt +
 * caption + hashtags + hookVariants. Kept so old rows still
 * display something useful; user can Regenerate to get the
 * new Style 1 kit.
 */
function LegacyProductContents({
  product,
}: {
  product: BatchPromptsProduct;
}) {
  return (
    <>
      <div className="card-accent-red p-3 text-[12px] text-muted">
        This product was generated before Style 1. Regenerate the
        batch on the desktop to get the full Style 1 kit (Flow agent
        script, 3-part copy with 5 options each).
      </div>
      {product.imagePrompt && (
        <PromptRow label="Image prompt" text={product.imagePrompt} />
      )}
      {product.caption && (
        <PromptRow label="Caption" text={product.caption} />
      )}
      {product.hashtags.length > 0 && (
        <PromptRow
          label="Hashtag block"
          text={product.hashtags.join(" ")}
        />
      )}
      {product.hookVariants.length > 0 && (
        <div className="space-y-1.5">
          <div className="label">Legacy hooks</div>
          {product.hookVariants.map((v) => (
            <HookRow key={v.label} label={v.label} text={v.text} />
          ))}
        </div>
      )}
    </>
  );
}

/** Block for one Part's 5 options — tap-to-pick + per-option copy.
 *  When onPick is provided (desktop /prompts modal), the whole row
 *  is tappable: tapping picks the option (green outline) AND
 *  copies its text to the clipboard. When onPick is absent, the
 *  block is read-only (a passive display of the persisted pick). */
function CopyOptionsBlock({
  label,
  hint,
  options,
  chosen,
  onPick,
}: {
  label: string;
  hint?: string;
  options: string[];
  chosen: string | null;
  onPick?: (text: string) => void;
}) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  if (options.length === 0) return null;

  function copyToClipboard(text: string) {
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
      } catch {
        // ignore
      }
    })();
  }

  const handleTap = (text: string, i: number) => {
    if (!onPick) return;
    onPick(text);
    copyToClipboard(text);
    setCopiedIndex(i);
    setTimeout(() => setCopiedIndex(null), 1500);
  };

  return (
    <div className="field-row">
      <span className="label">{label}</span>
      {hint && <div className="text-[11px] text-muted2 mb-1">{hint}</div>}
      <div className="space-y-1.5">
        {options.map((text, i) => {
          const isChosen = chosen === text;
          const wasJustCopied = copiedIndex === i;
          const rowClass = `flex items-start gap-2 group px-3 py-2 rounded-xl border transition-colors ${
            isChosen
              ? "border-ok/60 bg-ok/[0.06]"
              : "border-border bg-bg/60"
          } ${onPick ? "cursor-pointer hover:border-border-strong text-left w-full" : ""}`;
          const inner = (
            <>
              <span className="text-[10px] font-mono text-muted2 min-w-[24px] pt-1">
                {i + 1}
              </span>
              <div className="flex-1 text-sm text-text leading-relaxed">
                {text}
                {isChosen && !wasJustCopied && (
                  <span className="ml-2 text-[10px] text-ok">
                    ✓ picked
                  </span>
                )}
                {wasJustCopied && (
                  <span className="ml-2 text-[10px] text-ok">
                    ✓ copied
                  </span>
                )}
              </div>
              {!onPick && (
                <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                  <CopyButton text={text} small />
                </div>
              )}
            </>
          );
          if (onPick) {
            return (
              <button
                type="button"
                key={i}
                onClick={() => handleTap(text, i)}
                className={rowClass}
              >
                {inner}
              </button>
            );
          }
          return (
            <div key={i} className={rowClass}>
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------
 * Mobile posting QR panel
 * ------------------------------------------------------------ */

function MobilePostingQrPanel({
  postingUrl,
  postingQrDataUrl,
  hasHooksCount,
  approvedCount,
}: {
  postingUrl: string;
  postingQrDataUrl?: string;
  hasHooksCount: number;
  approvedCount: number;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    (async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(postingUrl);
        } else {
          const ta = document.createElement("textarea");
          ta.value = postingUrl;
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
    <Panel title="Post from your phone">
      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6 items-start">
        <div>
          {postingQrDataUrl ? (
            <div className="bg-white rounded-2xl p-3 inline-block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={postingQrDataUrl}
                alt="Mobile posting QR"
                width={220}
                height={220}
                className="block"
              />
            </div>
          ) : (
            <div className="w-[220px] h-[220px] flex items-center justify-center text-xs text-muted2 bg-panel2 rounded-2xl">
              QR unavailable
            </div>
          )}
        </div>
        <div className="space-y-3">
          <p className="text-sm text-text leading-relaxed">
            Scan on your phone to open the posting assistant. Each approved
            product with hooks appears with{" "}
            <span className="text-accent">copy-and-post</span> buttons for
            the caption, hashtag block, and every hook — no re-typing.
          </p>
          <div className="flex gap-2 flex-wrap">
            <StatusChip label={`${hasHooksCount} ready to post`} variant="ok" />
            {approvedCount - hasHooksCount > 0 && (
              <StatusChip
                label={`${approvedCount - hasHooksCount} still generating`}
                variant="warn"
              />
            )}
          </div>
          <button
            type="button"
            onClick={copy}
            className="text-[11px] text-accent hover:underline"
          >
            {copied ? "✓ copied" : "Copy posting link"}
          </button>
          <div className="text-[10px] text-muted2 break-all">{postingUrl}</div>
        </div>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------
 * Shared: prompt row + hook row + copy button
 * ------------------------------------------------------------ */

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
