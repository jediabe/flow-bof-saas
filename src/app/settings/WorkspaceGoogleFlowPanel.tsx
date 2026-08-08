"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  bindGoogleFlowAccount,
  connectGoogleFlowAccount,
  disconnectGoogleFlowAccount,
  type GoogleFlowStatus,
  type AvailableFlowAccount,
} from "./actions";

/**
 * Google Flow account panel — the onboarding surface for the APEX
 * MCP integration.
 *
 * Two paths a user could have taken to hook up a Google Flow
 * account to their useapi.net subscription:
 *   1. useapi.net's own automated browser setup
 *      (https://useapi.net/assets/setup-browser/google-flow)
 *      — recommended path.
 *   2. Our cookie-paste form here — manual fallback for cases
 *      where useapi.net's automated flow doesn't work for them.
 *
 * Either way, once connected, the account shows up in the MCP's
 * /admin/accounts list. This panel treats that list as the source
 * of truth: pick one to bind to this workspace with a click. No
 * re-capture needed. Cookie paste demoted to a collapsible
 * "Add another account (advanced)" section for the case where the
 * operator has zero accounts on their subscription yet.
 *
 * States rendered:
 *   - Not bound, accounts available: list them, click-to-bind
 *   - Not bound, no accounts available: cookie-paste form prominent
 *   - Bound + healthy: bound-account chip + Change / Disconnect
 *   - Bound + unhealthy: red warning + how-to-recover hint
 *   - MCP list unreachable: yellow warning with the error message
 */
export default function WorkspaceGoogleFlowPanel({
  initial,
}: {
  initial: GoogleFlowStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ tone: "ok" | "bad"; text: string } | null>(
    null,
  );

  function doBind(email: string) {
    setToast(null);
    startTransition(async () => {
      const r = await bindGoogleFlowAccount({ email });
      setToast({ tone: r.ok ? "ok" : "bad", text: r.message });
      if (r.ok) router.refresh();
    });
  }

  function doDisconnect() {
    setToast(null);
    startTransition(async () => {
      const r = await disconnectGoogleFlowAccount();
      setToast({ tone: r.ok ? "ok" : "bad", text: r.message });
      if (r.ok) router.refresh();
    });
  }

  function doConnectByCookies(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setToast(null);
    startTransition(async () => {
      const r = await connectGoogleFlowAccount(fd);
      setToast({ tone: r.ok ? "ok" : "bad", text: r.message });
      if (r.ok) {
        (e.currentTarget.elements.namedItem("cookies") as HTMLTextAreaElement).value = "";
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted leading-relaxed">
        Connect a Google Flow account to unlock the per-batch chat
        agent. Every generated video runs on this account&apos;s
        credits. Pick from what&apos;s already on your useapi.net
        subscription, or add a new one via cookie paste.
      </p>

      {initial.listError && (
        <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 p-3 text-[11px] text-orange-300 leading-relaxed">
          <div className="font-semibold">
            Couldn&apos;t list connected accounts
          </div>
          <div className="text-text mt-0.5">{initial.listError}</div>
          <div className="text-orange-300 mt-1">
            The MCP server might be down or the APEX_SERVICE_KEY may
            not match. Check server logs.
          </div>
        </div>
      )}

      {initial.bound ? (
        <BoundView
          status={initial}
          pending={pending}
          onDisconnect={doDisconnect}
          onRebind={doBind}
        />
      ) : (
        <UnboundView
          available={initial.availableAccounts}
          pending={pending}
          onBind={doBind}
        />
      )}

      <details className="pt-1">
        <summary className="cursor-pointer text-[11px] text-muted hover:text-text">
          Add another account (advanced — cookie paste)
        </summary>
        <div className="mt-3 space-y-3">
          <CookieWalkthrough />
          <form onSubmit={doConnectByCookies} className="space-y-2">
            <label className="label" htmlFor="google-flow-cookies">
              Cookie table (tab-separated, from DevTools)
            </label>
            <textarea
              id="google-flow-cookies"
              name="cookies"
              rows={5}
              disabled={pending}
              placeholder="Paste the copied cookies table here..."
              className="field font-mono text-[10px] leading-relaxed"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[10px] text-muted2 leading-relaxed">
              Cookies are forwarded to the MCP for a one-shot Google
              handshake, then discarded. Never logged, never persisted
              on our side.
            </p>
            <button
              type="submit"
              disabled={pending}
              className="btn btn-primary text-xs"
            >
              {pending ? "Connecting… (20-40s)" : "Connect via cookie paste"}
            </button>
          </form>
        </div>
      </details>

      {toast && (
        <div
          className={`text-[12px] ${
            toast.tone === "ok" ? "text-ok" : "text-bad"
          } leading-relaxed`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
 * States
 * ---------------------------------------------------------------- */

function BoundView({
  status,
  pending,
  onDisconnect,
  onRebind,
}: {
  status: GoogleFlowStatus;
  pending: boolean;
  onDisconnect: () => void;
  onRebind: (email: string) => void;
}) {
  const healthPill = status.liveError
    ? { bg: "bg-orange-500/15", text: "text-orange-400", label: "Live check failed" }
    : status.healthy
      ? { bg: "bg-green-500/15", text: "text-green-400", label: `Health: ${status.health}` }
      : { bg: "bg-red-500/15", text: "text-red-400", label: `Health: ${status.health ?? "unknown"}` };

  // Alternate accounts they could rebind to.
  const others = (status.availableAccounts ?? []).filter(
    (a) => a.email !== status.email,
  );

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-panel2 p-4 space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-muted2">
          Bound to this workspace
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm text-text font-medium truncate">
            {status.email}
          </div>
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full ${healthPill.bg} ${healthPill.text}`}
          >
            {healthPill.label}
          </span>
        </div>
        {status.liveError && (
          <div className="text-[11px] text-orange-300 leading-relaxed">
            <span className="font-semibold">MCP live-check:</span>{" "}
            {status.liveError}
          </div>
        )}
        {!status.healthy && !status.liveError && (
          <div className="text-[11px] text-red-300 leading-relaxed">
            The Google session is broken (upstream health is not OK).
            Most common cause: someone signed into this Google
            account in a browser after connecting. Disconnect,
            reconnect via useapi.net&apos;s{" "}
            <a
              href="https://useapi.net/assets/setup-browser/google-flow"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              automated setup
            </a>
            , then bind again.
          </div>
        )}
      </div>
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={onDisconnect}
          disabled={pending}
          className="btn btn-sm"
        >
          {pending ? "Working…" : "Disconnect account"}
        </button>
      </div>
      {others.length > 0 && (
        <div className="pt-2">
          <div className="text-[10px] uppercase tracking-wide text-muted2 mb-1.5">
            Other connected accounts (click to switch)
          </div>
          <div className="flex flex-col gap-1.5">
            {others.map((a) => (
              <AccountRow
                key={a.email}
                account={a}
                pending={pending}
                onClick={() => onRebind(a.email)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UnboundView({
  available,
  pending,
  onBind,
}: {
  available: AvailableFlowAccount[] | null;
  pending: boolean;
  onBind: (email: string) => void;
}) {
  if (!available) {
    // List call failed; the top-level listError banner already
    // covers this. Render nothing extra.
    return null;
  }
  if (available.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-panel2 p-4 text-xs text-muted leading-relaxed">
        No Google Flow accounts are connected to the useapi.net
        subscription yet.
        <div className="mt-2">
          Either use{" "}
          <a
            href="https://useapi.net/assets/setup-browser/google-flow"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline font-medium"
          >
            useapi.net&apos;s automated browser setup
          </a>{" "}
          (recommended — handles the cookie capture for you), or
          expand &quot;Add another account&quot; below to paste
          cookies manually.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-muted2">
        Pick one to bind to this workspace
      </div>
      <div className="flex flex-col gap-1.5">
        {available.map((a) => (
          <AccountRow
            key={a.email}
            account={a}
            pending={pending}
            onClick={() => onBind(a.email)}
          />
        ))}
      </div>
    </div>
  );
}

function AccountRow({
  account,
  pending,
  onClick,
}: {
  account: AvailableFlowAccount;
  pending: boolean;
  onClick: () => void;
}) {
  const chip = account.healthy
    ? { bg: "bg-green-500/15", text: "text-green-400" }
    : { bg: "bg-red-500/15", text: "text-red-400" };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-border bg-bg/60 hover:border-border-strong hover:bg-panel2 text-left transition-colors group disabled:opacity-50"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm text-text font-medium truncate">
          {account.email}
        </span>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full ${chip.bg} ${chip.text} flex-shrink-0`}
        >
          {account.health}
        </span>
      </div>
      <span className="text-[11px] text-muted group-hover:text-accent transition-colors flex-shrink-0">
        Use →
      </span>
    </button>
  );
}

function CookieWalkthrough() {
  return (
    <div className="card-accent-blue p-3 text-xs text-muted leading-relaxed space-y-2">
      <p className="text-text font-medium">
        Only use this if useapi.net&apos;s automated setup didn&apos;t
        work.
      </p>
      <ol className="list-decimal list-inside space-y-1 ml-2">
        <li>
          Use a browser that&apos;s NOT Chrome (Opera, Brave, or
          Ungoogled Chromium). Clear all cookies first.
        </li>
        <li>
          Sign in at{" "}
          <a
            href="https://labs.google/fx/tools/flow"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            labs.google/fx/tools/flow
          </a>
          . <strong>Tick &quot;Don&apos;t ask again on this
          device&quot;</strong> at the 2FA prompt.
        </li>
        <li>
          DevTools on{" "}
          <a
            href="https://myaccount.google.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            myaccount.google.com
          </a>{" "}
          → Application → Cookies →{" "}
          <code className="id-mono text-[11px]">
            accounts.google.com
          </code>{" "}
          → select all, copy, paste below.
        </li>
        <li>
          After: open a new tab, close the others, clear cookies
          again. Never sign into this account in a browser
          afterwards — breaks the session.
        </li>
      </ol>
    </div>
  );
}
