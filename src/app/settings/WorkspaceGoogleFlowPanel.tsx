"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectGoogleFlowAccount,
  disconnectGoogleFlowAccount,
  type GoogleFlowStatus,
} from "./actions";

/**
 * Google Flow account panel — the onboarding surface for the APEX
 * MCP integration.
 *
 * States:
 *   1. Not connected: renders the cookie-capture walkthrough +
 *      textarea + Connect button.
 *   2. Connected + healthy: shows the email + green health chip +
 *      Disconnect button.
 *   3. Connected + unhealthy: red chip explaining what broke
 *      (596 = broken session, most common) + hint to reconnect.
 *   4. Connected but live-check failed: yellow chip with the raw
 *      MCP error (usually "MCP down" or auth mismatch) + retry
 *      guidance.
 *
 * The cookie blob is NEVER logged or persisted on our side. It goes
 * to the MCP which forwards to useapi.net for a session handshake,
 * then discards. From then on useapi.net owns the refresh cycle.
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

  function onConnect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setToast(null);
    startTransition(async () => {
      const r = await connectGoogleFlowAccount(fd);
      setToast({ tone: r.ok ? "ok" : "bad", text: r.message });
      if (r.ok) {
        // Clear the textarea on success — the cookies were consumed.
        (
          e.currentTarget.elements.namedItem("cookies") as HTMLTextAreaElement
        ).value = "";
        router.refresh();
      }
    });
  }

  function onDisconnect() {
    setToast(null);
    startTransition(async () => {
      const r = await disconnectGoogleFlowAccount();
      setToast({ tone: r.ok ? "ok" : "bad", text: r.message });
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted leading-relaxed">
        Connect a Google Flow account to unlock the /generate video
        agent (coming next). One account per workspace for now —
        every generated video runs on this account&apos;s credits.
      </p>

      {initial.connected ? (
        <ConnectedView status={initial} pending={pending} onDisconnect={onDisconnect} />
      ) : (
        <NotConnectedView pending={pending} onSubmit={onConnect} />
      )}

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

function ConnectedView({
  status,
  pending,
  onDisconnect,
}: {
  status: GoogleFlowStatus;
  pending: boolean;
  onDisconnect: () => void;
}) {
  const healthPill = status.liveError
    ? { bg: "bg-orange-500/15", text: "text-orange-400", label: "Live check failed" }
    : status.healthy
      ? { bg: "bg-green-500/15", text: "text-green-400", label: `Health: ${status.health}` }
      : { bg: "bg-red-500/15", text: "text-red-400", label: `Health: ${status.health ?? "unknown"}` };

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-panel2 p-4 space-y-2">
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
            account in a browser after connecting. Disconnect and
            reconnect with a fresh cookie capture. Retrying won&apos;t
            recover it.
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onDisconnect}
        disabled={pending}
        className="btn btn-sm"
      >
        {pending ? "Disconnecting…" : "Disconnect account"}
      </button>
    </div>
  );
}

function NotConnectedView({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <details className="card-accent-blue p-4">
        <summary className="cursor-pointer text-sm font-medium text-text">
          How to capture the cookie blob
        </summary>
        <div className="mt-3 space-y-2 text-xs text-muted leading-relaxed">
          <p className="text-text font-medium">
            Use a fresh browser that&apos;s NOT Chrome for this account.
          </p>
          <ol className="list-decimal list-inside space-y-1 ml-2">
            <li>
              Open Opera, Brave, or Ungoogled Chromium. Clear all
              cookies first.
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
              . <strong>At the 2FA prompt, check
              &quot;Don&apos;t ask again on this device&quot;</strong> —
              skipping this breaks the session immediately.
            </li>
            <li>
              Open{" "}
              <a
                href="https://myaccount.google.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                myaccount.google.com
              </a>{" "}
              → DevTools → Application → Cookies →{" "}
              <code className="id-mono text-[11px]">
                accounts.google.com
              </code>
              .
            </li>
            <li>Select every row, copy, paste into the field below.</li>
            <li>
              After connecting: open a new empty tab, close the others,
              clear all cookies again. Don&apos;t sign in to this Google
              account in any browser afterwards — it invalidates the
              session useapi.net holds.
            </li>
          </ol>
          <p className="mt-2 text-muted2">
            useapi.net also has an{" "}
            <a
              href="https://useapi.net/assets/setup-browser/google-flow.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              automated browser setup
            </a>{" "}
            that skips the manual capture. Try that first.
          </p>
        </div>
      </details>

      <div className="field-row">
        <label className="label" htmlFor="google-flow-cookies">
          Cookie table (tab-separated, copied from DevTools)
        </label>
        <textarea
          id="google-flow-cookies"
          name="cookies"
          rows={6}
          disabled={pending}
          placeholder="Paste the copied cookies table here — it should be a big blob starting with cookie names like __Secure-1PSID, __Secure-1PSIDTS, etc."
          className="field font-mono text-[10px] leading-relaxed"
          spellCheck={false}
          autoComplete="off"
        />
        <p className="mt-1 text-[10px] text-muted2 leading-relaxed">
          Cookies are forwarded to the MCP for a one-shot Google
          handshake, then discarded. Never logged, never persisted
          on our side.
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="btn btn-primary text-xs"
      >
        {pending ? "Connecting… (this can take 20-40s)" : "Connect account"}
      </button>
    </form>
  );
}
