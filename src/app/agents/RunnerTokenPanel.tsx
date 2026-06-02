"use client";

import { useState, useTransition } from "react";
import StatusChip from "@/components/StatusChip";
import { generateRunnerToken, revokeRunnerToken } from "./actions";

/**
 * Connected-runner credential UI. Lives inline on each Agent card.
 *
 * Behaviours:
 *   - No token yet     → button: "Generate runner token". On click the
 *                        full token appears once in a copy-to-clipboard
 *                        block; the warning text says it won't be
 *                        shown again.
 *   - Token configured → chip: "token set (****abcd)". Buttons:
 *                        "Rotate" (mints a new one + invalidates the
 *                        old), "Revoke" (clears it).
 *
 * The full token is never stored client-side after this component
 * unmounts — the user has to copy it on the spot.
 */
export default function RunnerTokenPanel({
  agentId,
  hasToken,
  last4,
  connectedAt,
  lastPollAt,
  status,
}: {
  agentId: string;
  hasToken: boolean;
  last4: string | null;
  connectedAt: string | null;
  lastPollAt:  string | null;
  status: string;
}) {
  const [pending, startTransition] = useTransition();
  const [revealed, setRevealed] = useState<{ token: string; last4: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function mint() {
    setError(null);
    setRevealed(null);
    const fd = new FormData();
    fd.set("id", agentId);
    startTransition(async () => {
      const r = await generateRunnerToken(fd);
      if (r.ok) {
        setRevealed({ token: r.token, last4: r.last4 });
      } else {
        setError(r.message);
      }
    });
  }

  function revoke() {
    setError(null);
    setRevealed(null);
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Revoke this runner token? The runner will be locked out until you generate a new one.",
      )
    ) {
      return;
    }
    const fd = new FormData();
    fd.set("id", agentId);
    startTransition(async () => {
      await revokeRunnerToken(fd);
    });
  }

  return (
    <section className="rounded-2xl border border-border bg-bg/40 p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">Connected runner</span>
        <span className="text-[11px] text-muted">
          POST {`/api/runner/*`}
        </span>
      </div>

      {/* State chips ----------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {hasToken ? (
          <StatusChip
            label={`token set (****${last4 ?? "—"})`}
            variant="ok"
          />
        ) : (
          <StatusChip label="no token" variant="muted" />
        )}
        {connectedAt ? (
          <StatusChip label="online" variant={status === "online" ? "ok" : "muted"} />
        ) : (
          <StatusChip label="never connected" variant="muted" />
        )}
        {lastPollAt && (
          <span className="text-[11px] text-muted">
            last poll {new Date(lastPollAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Action buttons -------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending}
          onClick={mint}
        >
          {pending
            ? "Generating…"
            : hasToken
              ? "Rotate runner token"
              : "Generate runner token"}
        </button>
        {hasToken && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={pending}
            onClick={revoke}
          >
            Revoke
          </button>
        )}
      </div>

      {error && <div className="text-xs text-bad">⚠ {error}</div>}

      {/* One-time token reveal ------------------------------------- */}
      {revealed && (
        <div className="rounded-xl border border-warn/40 bg-warn/[0.06] p-3 space-y-2">
          <div className="text-xs text-warn font-medium">
            Copy this token now. It will not be shown again.
          </div>
          <code className="block break-all bg-bg/60 rounded-md p-2 font-mono text-xs">
            {revealed.token}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost text-[11px] px-2 py-1"
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  navigator.clipboard.writeText(revealed.token).catch(() => {});
                }
              }}
            >
              Copy to clipboard
            </button>
            <button
              type="button"
              className="btn btn-ghost text-[11px] px-2 py-1"
              onClick={() => setRevealed(null)}
            >
              I've copied it, hide
            </button>
          </div>
          <p className="text-[11px] text-muted">
            On the runner machine set{" "}
            <code className="id-mono">RUNNER_TOKEN</code> to this value
            (and <code className="id-mono">SAAS_BASE_URL</code> to this
            cockpit), then run{" "}
            <code className="id-mono">python main.py --runner-poll</code>.
          </p>
        </div>
      )}
    </section>
  );
}
