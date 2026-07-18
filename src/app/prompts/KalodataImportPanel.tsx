"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Panel from "@/components/ui/Panel";
import StatusChip from "@/components/StatusChip";
import {
  importKalodataForPrompts,
  getBatchReviewProgress,
  regenerateApprovedInBatch,
  type ImportKalodataToPromptsResult,
  type BatchReviewProgress,
} from "./actions";

/**
 * Kalodata import + mobile-review handoff panel for /prompts.
 *
 * Flow:
 *   1. Operator picks a .xlsx from a Kalodata export.
 *   2. Server action creates a new Batch, imports products, mints a
 *      review token, returns { batchId, reviewUrl, qrDataUrl }.
 *   3. This panel expands: QR code on the left, product list on the
 *      right.
 *   4. Reviewer opens the QR on their phone, swipes through
 *      Approve/Reject with an optional discount %. Server-side
 *      Next 15 `after()` fires the APEX hook + image prompt
 *      generator on every approval.
 *   5. This panel polls getBatchReviewProgress every 4s while a
 *      review is active so the desktop-side list shows real-time
 *      status transitions (needs_review → approved → hooks ready).
 */

interface ImportedState {
  batchId: string;
  reviewUrl: string;
  qrDataUrl?: string;
  message: string;
  productsCreated: number;
  imagesFailed: number;
  /** Epoch ms when the import succeeded. Used to expire stale
   *  localStorage entries so a batch from last week doesn't come
   *  back on tomorrow's visit. */
  importedAt: number;
}

const POLL_INTERVAL_MS = 4000;
const LOCAL_STORAGE_KEY = "apex.prompts.last-import";
const LOCAL_STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export default function KalodataImportPanel() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [batchName, setBatchName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportedState | null>(null);
  const [progress, setProgress] = useState<BatchReviewProgress | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Rehydrate the last-import panel from localStorage on mount.
  // Any of these fail the panel just stays empty:
  //   - No entry saved  → fresh visit
  //   - Entry older than 24h → stale, clear it
  //   - Entry decodes but batch no longer exists → cleared by the
  //     first polling tick (via getBatchReviewProgress "not found")
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ImportedState;
      if (
        typeof parsed?.batchId !== "string" ||
        typeof parsed?.reviewUrl !== "string" ||
        typeof parsed?.importedAt !== "number"
      ) {
        window.localStorage.removeItem(LOCAL_STORAGE_KEY);
        return;
      }
      if (Date.now() - parsed.importedAt > LOCAL_STORAGE_MAX_AGE_MS) {
        window.localStorage.removeItem(LOCAL_STORAGE_KEY);
        return;
      }
      setImported(parsed);
    } catch {
      try {
        window.localStorage.removeItem(LOCAL_STORAGE_KEY);
      } catch {
        // localStorage disabled — nothing to do
      }
    }
  }, []);

  // Poll for review progress once we have an imported batch. Stops
  // once every product is in a terminal review state (approved /
  // rejected / maybe) — no point burning fetches when nothing can
  // change without a page reload.
  useEffect(() => {
    if (!imported?.batchId) return;
    let cancelled = false;
    async function tick() {
      const r = await getBatchReviewProgress(imported!.batchId);
      if (cancelled) return;
      // If the server says the batch no longer exists (e.g. the
      // operator deleted it from /batches), drop the panel state
      // AND the localStorage cache so we stop trying.
      if (!r.ok && r.message === "batch not found") {
        try {
          window.localStorage.removeItem(LOCAL_STORAGE_KEY);
        } catch {
          // ignore
        }
        setImported(null);
        setProgress(null);
        return;
      }
      setProgress(r);
    }
    // Kick off immediately, then keep polling.
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [imported?.batchId]);

  /** Clear the persisted last-import state and reset the panel. */
  function clearImport() {
    try {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    } catch {
      // ignore
    }
    setImported(null);
    setProgress(null);
  }

  function submit() {
    if (!file) return;
    setError(null);
    setImported(null);
    setProgress(null);
    const fd = new FormData();
    fd.set("file", file);
    if (batchName.trim()) fd.set("batchName", batchName.trim());
    startTransition(async () => {
      let r: ImportKalodataToPromptsResult;
      try {
        r = await importKalodataForPrompts(fd);
      } catch (e) {
        setError((e as Error).message || "import failed");
        return;
      }
      if (!r.ok || !r.batchId || !r.reviewUrl) {
        setError(r.message);
        return;
      }
      const nextState: ImportedState = {
        batchId: r.batchId,
        reviewUrl: r.reviewUrl,
        qrDataUrl: r.qrDataUrl,
        message: r.message,
        productsCreated: r.report?.productsCreated ?? 0,
        imagesFailed: r.report?.imagesFailed ?? 0,
        importedAt: Date.now(),
      };
      setImported(nextState);
      // Cache so a refresh doesn't lose the QR + progress panel.
      try {
        window.localStorage.setItem(
          LOCAL_STORAGE_KEY,
          JSON.stringify(nextState),
        );
      } catch {
        // localStorage full / disabled — non-fatal, panel still
        // works for this session.
      }
      // Reset the file input so a second import doesn't need a page
      // reload; keep the batch-name buffer since the operator may
      // want the same naming pattern for the next import.
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      // Refresh the page so the manual product picker below picks
      // up the newly imported rows without a full navigation.
      router.refresh();
    });
  }

  function copyReviewUrl() {
    if (!imported?.reviewUrl) return;
    (async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(imported.reviewUrl);
        } else {
          const ta = document.createElement("textarea");
          ta.value = imported.reviewUrl;
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
    <Panel title="Import from Kalodata">
      <div className="space-y-4">
        <p className="text-xs text-muted leading-relaxed">
          Upload a Kalodata <code className="id-mono">.xlsx</code> export. The
          hub creates a new batch, downloads each product image, and hands
          you a QR code you can scan on your phone to review each product,
          type in today&apos;s TikTok Shop discount %, and approve. Hooks
          and image prompts generate automatically the moment you approve.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_minmax(0,220px)_auto] gap-3 items-end">
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

        {file && !imported && (
          <div className="text-[11px] text-muted">Selected: {file.name}</div>
        )}
        {error && <div className="text-[12px] text-bad">{error}</div>}

        {imported && (
          <>
            <div className="flex items-center justify-between gap-3 mt-4">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted">
                Active review
              </div>
              <button
                type="button"
                onClick={clearImport}
                className="text-[11px] text-muted hover:text-text transition-colors"
              >
                Dismiss
              </button>
            </div>
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6 items-start">
            {/* QR + copy link */}
            <div className="space-y-3">
              <div className="bg-white rounded-2xl p-3 inline-block">
                {imported.qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imported.qrDataUrl}
                    alt="Mobile review QR"
                    width={220}
                    height={220}
                    className="block"
                  />
                ) : (
                  <div className="w-[220px] h-[220px] flex items-center justify-center text-xs text-muted2">
                    QR unavailable — copy the link below.
                  </div>
                )}
              </div>
              <div className="text-[11px] text-muted leading-relaxed">
                Scan on your phone, or{" "}
                <button
                  type="button"
                  onClick={copyReviewUrl}
                  className="text-accent hover:underline"
                >
                  {copied ? "✓ copied" : "copy the review link"}
                </button>
                .
              </div>
              <div className="text-[10px] text-muted2 break-all">
                {imported.reviewUrl}
              </div>
            </div>

            {/* Product list + review progress */}
            <div className="space-y-3">
              <div className="text-sm text-text">
                <span className="font-medium">{imported.message}</span>
                {imported.imagesFailed > 0 && (
                  <span className="text-warn text-xs ml-2">
                    {imported.imagesFailed} image download{" "}
                    {imported.imagesFailed === 1 ? "" : "s"} failed — products
                    still saved, you can re-import for images.
                  </span>
                )}
              </div>

              <ProductProgressList
                progress={progress}
                batchId={imported.batchId}
              />
            </div>
          </div>
          </>
        )}
      </div>
    </Panel>
  );
}

function ProductProgressList({
  progress,
  batchId,
}: {
  progress: BatchReviewProgress | null;
  batchId: string;
}) {
  const [regenPending, startRegenTransition] = useTransition();
  const [regenMsg, setRegenMsg] = useState<string | null>(null);

  if (!progress?.ok || !progress.products) {
    return (
      <div className="text-[12px] text-muted">
        Waiting for products to sync…
      </div>
    );
  }
  const products = progress.products;
  const counts = {
    needs_review: 0,
    approved: 0,
    rejected: 0,
    maybe: 0,
  } as Record<string, number>;
  for (const p of products) {
    counts[p.reviewStatus] = (counts[p.reviewStatus] ?? 0) + 1;
  }
  const promptsReady = products.filter((p) => p.hasPrompt).length;
  // Approved products that don't yet have hooks — the audience for
  // the manual "Regenerate approved" fallback. When this is zero
  // and we've fully caught up, we still render the button but
  // muted, so the operator can force a re-run if they changed a
  // discount % after approval.
  const approvedMissingHooks = products.filter(
    (p) => p.reviewStatus === "approved" && !p.hasPrompt,
  ).length;

  function regenerate() {
    setRegenMsg(null);
    startRegenTransition(async () => {
      const r = await regenerateApprovedInBatch(batchId);
      setRegenMsg(r.message);
      setTimeout(() => setRegenMsg(null), 5000);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <StatusChip
          label={`${counts.needs_review} needs review`}
          variant={counts.needs_review > 0 ? "warn" : "muted"}
        />
        <StatusChip
          label={`${counts.approved} approved`}
          variant={counts.approved > 0 ? "ok" : "muted"}
        />
        <StatusChip
          label={`${counts.rejected} rejected`}
          variant="muted"
        />
        <StatusChip
          label={`${promptsReady} hooks ready`}
          variant={promptsReady > 0 ? "ok" : "muted"}
        />
      </div>
      {/* Manual fallback: forces regeneration for every approved
          product using each one's currently-persisted discount %.
          Useful when auto-generation didn't fire (deployment
          glitch, cold-start miss) OR when the operator changed a
          discount % after approval and wants updated hooks. */}
      {counts.approved > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
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
          {regenMsg && (
            <span className="text-[11px] text-muted">{regenMsg}</span>
          )}
        </div>
      )}
      <div className="max-h-72 overflow-y-auto rounded-xl border border-border divide-y divide-border">
        {products.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-3 px-3 py-2 text-[13px]"
          >
            <StatusIndicator status={p.reviewStatus} />
            <div className="flex-1 min-w-0 truncate text-text">
              {p.productName}
            </div>
            {p.discountPercent != null && (
              <span className="text-[10px] font-mono text-accent-red">
                −{p.discountPercent}%
              </span>
            )}
            {p.hasPrompt ? (
              <span className="text-[10px] text-ok">✓ hooks</span>
            ) : p.reviewStatus === "approved" ? (
              <span className="text-[10px] text-muted2 italic">generating…</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: string }) {
  const color =
    status === "approved"
      ? "bg-ok"
      : status === "rejected"
        ? "bg-accent-red"
        : status === "maybe"
          ? "bg-warn"
          : "bg-muted2";
  return <div className={`w-2 h-2 rounded-full ${color}`} />;
}
