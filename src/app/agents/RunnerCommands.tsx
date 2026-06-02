"use client";

import { useState } from "react";

/**
 * Copy-paste setup commands for the local runner, one tab per OS.
 *
 * When the user just generated a fresh token via RunnerTokenPanel it
 * gets passed in via `freshToken`; we embed it directly into the
 * command strings so a single click puts everything on the
 * clipboard. Once they refresh the page (or click "hide token"),
 * `freshToken` goes back to null and the commands fall back to a
 * `runner_xxx` placeholder with a "generate a token to get the
 * filled-in version" hint.
 *
 * The component reads its own `hasToken` prop to decide whether to
 * even attempt the placeholder line — if there's no token at all
 * yet, the commands aren't actionable.
 */
export default function RunnerCommands({
  saasBaseUrl,
  hasToken,
  freshToken,
}: {
  saasBaseUrl: string;
  hasToken: boolean;
  freshToken?: string | null;
}) {
  const token = freshToken || "runner_xxx";
  const filledIn = !!freshToken;
  const [tab, setTab] = useState<"powershell" | "ps-one" | "bash">("powershell");
  const [copied, setCopied] = useState<string | null>(null);

  const commands = {
    powershell: [
      `docker compose run --rm \``,
      `  -e SAAS_BASE_URL="${saasBaseUrl}" \``,
      `  -e RUNNER_TOKEN="${token}" \``,
      `  -e RUNNER_POLL_INTERVAL_SECONDS="5" \``,
      `  app python main.py --runner-poll`,
    ].join("\n"),
    "ps-one":
      `docker compose run --rm ` +
      `-e SAAS_BASE_URL="${saasBaseUrl}" ` +
      `-e RUNNER_TOKEN="${token}" ` +
      `-e RUNNER_POLL_INTERVAL_SECONDS="5" ` +
      `app python main.py --runner-poll`,
    bash:
      `SAAS_BASE_URL="${saasBaseUrl}" ` +
      `RUNNER_TOKEN="${token}" ` +
      `RUNNER_POLL_INTERVAL_SECONDS="5" ` +
      `docker compose run --rm app python main.py --runner-poll`,
  } as const;

  function copy(key: keyof typeof commands) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard
        .writeText(commands[key])
        .then(() => {
          setCopied(key);
          setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
        })
        .catch(() => {
          /* ignore */
        });
    }
  }

  const TABS: { key: keyof typeof commands; label: string; sub: string }[] = [
    { key: "powershell", label: "Windows PowerShell", sub: "multi-line" },
    { key: "ps-one",     label: "Windows PowerShell", sub: "single line" },
    { key: "bash",       label: "macOS / Linux",      sub: "bash / zsh" },
  ];

  return (
    <div className="space-y-3">
      {!hasToken ? (
        <div className="rounded-2xl border border-warn/40 bg-warn/[0.06] px-4 py-3 text-xs text-warn">
          Generate a runner token in step 2 first — these commands need
          the token to authenticate.
        </div>
      ) : !filledIn ? (
        <div className="text-[11px] text-muted">
          A token is already set, but its full value is only displayed
          right after generation. Click <strong>Rotate runner token</strong>{" "}
          in step 2 to mint a new one if you need a filled-in command.
        </div>
      ) : (
        <div className="text-[11px] text-accent">
          Fresh token loaded — every command below already has{" "}
          <code className="id-mono">RUNNER_TOKEN</code> filled in.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`btn text-[11px] px-3 py-1.5 ${
              tab === t.key
                ? "btn-primary"
                : "btn-ghost"
            }`}
          >
            {t.label}{" "}
            <span className="text-[10px] opacity-70 ml-1">{t.sub}</span>
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-bg/80 p-3 relative">
        <pre className="text-[11.5px] leading-relaxed overflow-x-auto font-mono whitespace-pre">
{commands[tab]}
        </pre>
        <button
          type="button"
          className="btn btn-ghost text-[11px] px-2 py-1 absolute top-2 right-2"
          onClick={() => copy(tab)}
        >
          {copied === tab ? "✓ Copied" : "Copy"}
        </button>
      </div>

      <ol className="text-xs text-muted list-decimal pl-5 space-y-1">
        <li>
          Open a terminal in the{" "}
          <code className="id-mono">flow-bof-automation</code> repo
          folder on your computer.
        </li>
        <li>Paste the command above.</li>
        <li>
          Watch this page — once the runner POSTs its first
          <code className="id-mono"> /api/runner/health</code> the
          status above flips to <strong>online</strong>.
        </li>
      </ol>
    </div>
  );
}
