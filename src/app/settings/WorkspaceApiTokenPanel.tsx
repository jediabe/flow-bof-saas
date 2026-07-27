"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  generateWorkspaceApiToken,
  revokeWorkspaceApiToken,
} from "./actions";

/**
 * Workspace API token panel — generate / rotate / revoke the token
 * that programmatic scripts (currently just the flow-bof-automation
 * cookie fetcher) use as Bearer auth against /api/tiktok-accounts/add.
 *
 * UX rules:
 *   - The raw token string is returned by the server EXACTLY ONCE,
 *     right after generation. This component surfaces it in a
 *     copy-friendly block for that one moment. After the user
 *     dismisses / navigates away, the string is unrecoverable —
 *     they'd rotate to get a new one.
 *   - The server-provided `hasToken` prop tells us whether ANY
 *     token exists, without revealing it. Drives the "rotate"
 *     vs "generate" verb + the Revoke button visibility.
 */
export default function WorkspaceApiTokenPanel({
  hasToken,
}: {
  hasToken: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function generate() {
    setError(null);
    setFreshToken(null);
    startTransition(async () => {
      const r = await generateWorkspaceApiToken();
      if (!r.ok || !r.token) {
        setError(r.message ?? "Could not generate token.");
        return;
      }
      setFreshToken(r.token);
      router.refresh();
    });
  }

  function revoke() {
    if (
      !window.confirm(
        "Revoke the current API token? Any script or integration " +
          "using it will stop working until you generate a new token.",
      )
    ) {
      return;
    }
    setError(null);
    setFreshToken(null);
    startTransition(async () => {
      await revokeWorkspaceApiToken();
      router.refresh();
    });
  }

  function copyToken() {
    if (!freshToken) return;
    (async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(freshToken);
        } else {
          const ta = document.createElement("textarea");
          ta.value = freshToken;
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
    <div className="space-y-4">
      <p className="text-xs text-muted leading-relaxed">
        Used by external scripts for programmatic access. Currently
        consumed by <code className="id-mono">flow-bof-automation</code>&apos;s{" "}
        <code className="id-mono">scripts/fetch_tiktok_cookies.py</code>{" "}
        which POSTs freshly-captured TikTok Shop cookies to{" "}
        <code className="id-mono">/api/tiktok-accounts/add</code>. Rotate
        anytime — old token stops working immediately.
      </p>

      {freshToken ? (
        <div className="card-accent-blue p-4 space-y-3">
          <div className="text-[11px] uppercase tracking-[0.14em] text-accent">
            New token — copy it now
          </div>
          <p className="text-xs text-text leading-relaxed">
            This is the only time this token will be shown. Copy it
            immediately — if you lose it you&apos;ll need to rotate to a
            new one.
          </p>
          <div className="flex items-center gap-2">
            <code className="id-mono flex-1 text-xs text-text bg-bg/60 border border-border rounded-xl px-3 py-2 break-all">
              {freshToken}
            </code>
            <button
              type="button"
              onClick={copyToken}
              className="btn btn-sm whitespace-nowrap"
            >
              {copied ? "✓ copied" : "Copy"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setFreshToken(null)}
            className="text-[11px] text-muted hover:text-text transition-colors"
          >
            Dismiss (I&apos;ve saved it)
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={generate}
            disabled={pending}
            className="btn btn-primary"
          >
            {pending
              ? "Generating…"
              : hasToken
                ? "Rotate token"
                : "Generate token"}
          </button>
          {hasToken && (
            <button
              type="button"
              onClick={revoke}
              disabled={pending}
              className="btn btn-danger text-xs"
            >
              Revoke
            </button>
          )}
          <span className="text-[11px] text-muted">
            {hasToken
              ? "A token is currently active (value not shown; rotate to see a new one)."
              : "No token active."}
          </span>
        </div>
      )}

      {error && <div className="text-[12px] text-bad">{error}</div>}

      <details className="text-[11px] text-muted mt-2">
        <summary className="cursor-pointer hover:text-text">
          Example: how the fetcher script uses this token
        </summary>
        <pre className="mt-2 bg-bg/60 border border-border rounded-xl px-3 py-2 text-[11px] leading-relaxed overflow-x-auto">
{`# On your machine (in flow-bof-automation)
python scripts/fetch_tiktok_cookies.py \\
    --api-url  https://app.autobof.xyz \\
    --api-token  <paste the token from above>

# Script launches Chrome, prompts you to log into each
# TikTok account, then POSTs each captured cookie to the
# dashboard. Zero manual paste per account.`}
        </pre>
      </details>
    </div>
  );
}
