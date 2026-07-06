"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import StatusChip from "@/components/StatusChip";
import {
  updateTikTokAccount,
  replaceTikTokCookie,
  deleteTikTokAccount,
  testTikTokCookie,
  refreshTikTokAccountNow,
  diagnoseTikTokAccount,
  type DiagnosticItem,
} from "./actions";

interface AccountSummary {
  id: string;
  label: string;
  region: string;
  monthlyToolCost: number;
  cookieStatus: string;
  cookieError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
}

/**
 * Single account row on /settings/tiktok-accounts. Collapsed by
 * default; the chevron toggles into an edit panel that exposes:
 *
 *   - Rename / region / monthly tool cost (one inline form)
 *   - Replace cookie (separate form to avoid wiping a valid cookie
 *     when only renaming)
 *   - Test cookie    button → posts to TikHub via the server action
 *   - Refresh now    button → fires the same refresh path the cron uses
 *   - Delete         button → cascade-deletes captured data
 *
 * All actions live in actions.ts; this client component only
 * renders + relays form submissions.
 */
export default function AccountRow({
  account,
}: {
  account: AccountSummary;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<{
    tone: "ok" | "bad";
    text: string;
  } | null>(null);
  /** Last diagnostic-probe result. Held inline under the action
   *  chips when populated. */
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[] | null>(null);

  function runDiagnose() {
    const fd = new FormData();
    fd.set("accountId", account.id);
    setToast(null);
    setDiagnostics(null);
    startTransition(async () => {
      const r = await diagnoseTikTokAccount(fd);
      flash(r.ok ? "ok" : "bad", r.message);
      setDiagnostics(r.items);
    });
  }

  function flash(tone: "ok" | "bad", text: string) {
    setToast({ tone, text });
    setTimeout(() => setToast(null), 4000);
  }

  function callAction(
    action: (fd: FormData) => Promise<{ ok: boolean; message: string }>,
    fields: Record<string, string>,
  ) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set("accountId", account.id);
    startTransition(async () => {
      const r = await action(fd);
      flash(r.ok ? "ok" : "bad", r.message);
      if (r.ok) router.refresh();
    });
  }

  function onUpdate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("accountId", account.id);
    setToast(null);
    startTransition(async () => {
      const r = await updateTikTokAccount(fd);
      flash(r.ok ? "ok" : "bad", r.message);
      if (r.ok) router.refresh();
    });
  }

  function onReplaceCookie(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("accountId", account.id);
    setToast(null);
    startTransition(async () => {
      const r = await replaceTikTokCookie(fd);
      flash(r.ok ? "ok" : "bad", r.message);
      if (r.ok) {
        form.reset();
        router.refresh();
      }
    });
  }

  const statusVariant: "ok" | "warn" | "bad" | "muted" =
    account.cookieStatus === "active"
      ? "ok"
      : account.cookieStatus === "expired"
        ? "bad"
        : account.cookieStatus === "error"
          ? "bad"
          : "muted";
  const statusLabel = `cookie: ${account.cookieStatus}`;

  return (
    <div className="rounded-2xl border border-border bg-bg/40">
      {/* Collapsed header — always visible */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-muted2 text-xs w-3 text-center">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-medium text-text truncate">
              {account.label}
            </span>
            <StatusChip label={account.region} variant="muted" />
            <StatusChip label={statusLabel} variant={statusVariant} />
            {account.cookieError && (
              <span className="text-[11px] text-bad truncate" title={account.cookieError}>
                {account.cookieError.slice(0, 60)}
                {account.cookieError.length > 60 ? "…" : ""}
              </span>
            )}
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            ${account.monthlyToolCost.toFixed(2)}/mo · checked{" "}
            {account.lastCheckedAt
              ? new Date(account.lastCheckedAt).toLocaleString()
              : "never"}
          </div>
        </span>
        <span className="flex gap-2 shrink-0">
          <Link
            href={`/analytics/${account.id}`}
            className="text-xs text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            View ↗
          </Link>
        </span>
      </button>

      {/* Inline action chips — visible without expanding */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        <button
          type="button"
          onClick={() => callAction(testTikTokCookie, {})}
          disabled={pending}
          className="btn btn-sm"
          title="Validate the stored cookie against TikHub."
        >
          Test cookie
        </button>
        <button
          type="button"
          onClick={() => callAction(refreshTikTokAccountNow, {})}
          disabled={pending}
          className="btn btn-sm"
          title="Pull health + revenue + products from TikHub right now."
        >
          Refresh now
        </button>
        <button
          type="button"
          onClick={runDiagnose}
          disabled={pending}
          className="btn btn-sm"
          title="Call every TikHub endpoint independently and dump the raw response. Useful when the dashboard shows zeros."
        >
          Diagnose
        </button>
        {toast && (
          <span
            className={`text-[11px] ${
              toast.tone === "ok" ? "text-ok" : "text-bad"
            }`}
          >
            {toast.text}
          </span>
        )}
      </div>

      {/* Diagnostic output. Each endpoint gets its own collapsible
          block so the user can scan which ones responded + what
          fields they returned. */}
      {diagnostics && diagnostics.length > 0 && (
        <div className="border-t border-border px-4 py-3 space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="text-[11px] uppercase tracking-wide text-muted">
              Endpoint probe results
            </div>
            <button
              type="button"
              onClick={() => setDiagnostics(null)}
              className="text-[11px] text-muted hover:text-text"
            >
              Hide
            </button>
          </div>
          {diagnostics.map((d, i) => (
            <details
              key={`${d.endpoint}-${i}`}
              className="rounded-2xl border border-border bg-bg/40"
            >
              <summary className="cursor-pointer px-3 py-2 flex items-center gap-2 text-xs">
                <StatusChip
                  label={d.ok ? "ok" : "fail"}
                  variant={d.ok ? "ok" : "bad"}
                />
                <span className="font-medium text-text">{d.label}</span>
                <span className="text-muted truncate">{d.endpoint}</span>
              </summary>
              <pre className="px-3 pb-3 pt-1 text-[11px] leading-snug text-muted whitespace-pre-wrap break-words font-mono overflow-x-auto max-h-96">
                {d.ok ? d.raw : d.error}
              </pre>
            </details>
          ))}
        </div>
      )}

      {/* Expanded edit panel */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 space-y-5">
          {/* Rename / region / monthly cost */}
          <form
            onSubmit={onUpdate}
            className="grid grid-cols-1 md:grid-cols-4 gap-3"
          >
            <div className="md:col-span-2">
              <label className="label">Label</label>
              <input
                name="label"
                defaultValue={account.label}
                required
                className="field mt-1"
                disabled={pending}
              />
            </div>
            <div>
              <label className="label">Region</label>
              <select
                name="region"
                defaultValue={account.region}
                className="field mt-1"
                disabled={pending}
              >
                <option value="US">US</option>
                <option value="UK">UK</option>
              </select>
            </div>
            <div>
              <label className="label">Monthly tool cost</label>
              <input
                type="number"
                min={0}
                step="0.01"
                name="monthlyToolCost"
                defaultValue={String(account.monthlyToolCost)}
                className="field mt-1"
                disabled={pending}
              />
            </div>
            <div className="md:col-span-4">
              <button
                type="submit"
                className="btn btn-primary text-xs"
                disabled={pending}
              >
                Save
              </button>
            </div>
          </form>

          {/* Replace cookie */}
          <form onSubmit={onReplaceCookie} className="space-y-2">
            <label className="label">Replace cookie</label>
            <textarea
              name="cookieRaw"
              rows={4}
              placeholder="Paste a fresh Cookie header from TikTok Shop here. Leave blank to keep the existing cookie."
              className="field font-mono text-[11px] leading-snug"
              spellCheck={false}
              disabled={pending}
              required
            />
            <button
              type="submit"
              className="btn text-xs"
              disabled={pending}
            >
              Update cookie
            </button>
          </form>

          {/* Delete — last so it doesn't get tapped by accident */}
          <div className="pt-2 border-t border-border/50">
            <DeleteButton
              accountId={account.id}
              label={account.label}
              disabled={pending}
              onAfter={(r) => {
                flash(r.ok ? "ok" : "bad", r.message);
                if (r.ok) router.refresh();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function DeleteButton({
  accountId,
  label,
  disabled,
  onAfter,
}: {
  accountId: string;
  label: string;
  disabled: boolean;
  onAfter: (r: { ok: boolean; message: string }) => void;
}) {
  const [pending, startTransition] = useTransition();

  function confirmDelete() {
    if (
      !window.confirm(
        `Delete "${label}" and all of its captured analytics? This cannot be undone.`,
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.set("accountId", accountId);
    startTransition(async () => {
      const r = await deleteTikTokAccount(fd);
      onAfter(r);
    });
  }

  return (
    <button
      type="button"
      onClick={confirmDelete}
      disabled={disabled || pending}
      className="btn btn-danger text-xs"
    >
      Delete account
    </button>
  );
}
