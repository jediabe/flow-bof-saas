"use client";

import { useState } from "react";

/**
 * Step 3 of Runner Setup. End-user-friendly path is:
 *
 *   1. Download FlowBOFRunner.exe from GitHub Releases
 *   2. Run it
 *   3. Paste the runner token (or copy the full command with the
 *      token already baked in)
 *
 * No Docker, no Python, no `.env`. The Docker / direct-Python
 * commands stay reachable under an "Advanced developer setup"
 * disclosure for the dev path.
 *
 * `freshToken` is the one-time-display token from RunnerTokenPanel.
 * When it's present we splice it into every snippet so a single
 * "Copy" click is enough. When it's null we render a `runner_xxx`
 * placeholder with a clear hint to rotate the token if the user
 * needs a filled-in version.
 */

// Bump this whenever we cut a new GitHub Release. Surfaced inside
// the download instructions; nothing else parses it.
const LATEST_RUNNER_TAG_HINT = "the latest release";

// Three knobs the SaaS deploy can set on `.env.production`:
//
//   NEXT_PUBLIC_RUNNER_WINDOWS_RELEASE_URL — direct link to the
//     .exe on a GitHub Release. When set, the Windows card's
//     button downloads the file directly; when unset, the button
//     falls back to the generic releases page so the user can
//     browse.
//   NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL — same idea for the .dmg.
//     When unset, the Mac card renders a *disabled* button labelled
//     "Mac Runner coming soon" — the build pipeline isn't ready
//     yet and we don't want to surface a dead link.
//   NEXT_PUBLIC_RUNNER_RELEASES_URL — generic fallback releases
//     index. Used when the specific URLs above are unset and we
//     still want a "browse releases" landing page.
const RELEASES_URL =
  process.env.NEXT_PUBLIC_RUNNER_RELEASES_URL ||
  "https://github.com/jediabe/flow-bof-automation/releases";
const WINDOWS_RELEASE_URL =
  process.env.NEXT_PUBLIC_RUNNER_WINDOWS_RELEASE_URL || RELEASES_URL;
const MAC_RELEASE_URL =
  process.env.NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL || "";

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
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-4">
      {/* Token-availability banner --------------------------------- */}
      {!hasToken ? (
        <div className="rounded-2xl border border-warn/40 bg-warn/[0.06] px-4 py-3 text-xs text-warn">
          Generate a runner token in step 2 first — the runner needs
          it to authenticate.
        </div>
      ) : !filledIn ? (
        <div className="text-[11px] text-muted">
          A token is already set, but its full value is only shown
          right after generation. Click{" "}
          <strong>Rotate runner token</strong> in step 2 to mint a
          new one if you need it embedded in the command line.
        </div>
      ) : (
        <div className="text-[11px] text-accent">
          Fresh token loaded — every command below has the token
          pre-filled.
        </div>
      )}

      {/* Primary path: side-by-side platform download cards. Each
          shows its own copy-paste flow + Gatekeeper / SmartScreen
          caveats. The grid stacks on narrow screens. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <WindowsRunner
          saasBaseUrl={saasBaseUrl}
          token={token}
          filledIn={filledIn}
          hasToken={hasToken}
        />
        <MacRunner
          saasBaseUrl={saasBaseUrl}
          token={token}
          filledIn={filledIn}
          hasToken={hasToken}
        />
      </div>

      {/* Advanced disclosure for Docker / Python ------------------- */}
      <details
        className="rounded-2xl border border-border bg-bg/40 px-4 py-3"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-xs text-muted hover:text-text transition-colors select-none">
          Advanced developer setup — Docker / Python
        </summary>
        <div className="mt-3 space-y-4">
          <p className="text-[11px] text-muted">
            For contributors iterating on the runner. End users do{" "}
            <em>not</em> need any of this — they should use the
            Windows or Mac runner above.
          </p>
          <DockerCommands
            saasBaseUrl={saasBaseUrl}
            token={token}
            hasToken={hasToken}
          />
          <PythonCommand
            saasBaseUrl={saasBaseUrl}
            token={token}
            hasToken={hasToken}
          />
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------
// Windows runner panel
// ---------------------------------------------------------------------

function WindowsRunner({
  saasBaseUrl,
  token,
  filledIn,
  hasToken,
}: {
  saasBaseUrl: string;
  token: string;
  filledIn: boolean;
  hasToken: boolean;
}) {
  return (
    <div className="rounded-2xl border border-accent/40 bg-accent/[0.04] p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="section-title">Windows</div>
          <p className="text-xs text-muted mt-1">
            One executable. No Docker, no Python, no terminal commands.
          </p>
        </div>
        <a
          href={WINDOWS_RELEASE_URL}
          target="_blank"
          rel="noreferrer"
          className="btn btn-primary text-xs"
        >
          Download Windows Runner ↗
        </a>
      </div>

      <ol className="text-sm text-text/85 list-decimal pl-5 space-y-1.5">
        <li>
          Download <code className="id-mono">FlowBOFRunner.exe</code>{" "}
          from {LATEST_RUNNER_TAG_HINT} on GitHub Releases.
        </li>
        <li>
          Double-click the file. If Windows SmartScreen warns, click
          {" "}<strong>More info → Run anyway</strong> — the exe is
          unsigned for now.
        </li>
        <li>
          When prompted, paste your SaaS URL and runner token:
          <CopyPasteBox
            label="SaaS URL"
            value={saasBaseUrl}
            copyable
          />
          <CopyPasteBox
            label="Runner token"
            value={hasToken ? token : ""}
            copyable={filledIn}
            placeholder={
              hasToken
                ? "Rotate the token in step 2 to copy the full value."
                : "Generate a token in step 2 first."
            }
          />
        </li>
        <li>
          A dedicated Chrome window opens automatically. Sign into
          Google Flow inside it.
        </li>
        <li>
          Keep the runner window open. Queued jobs from the SaaS
          will land in Flow on their own.
        </li>
      </ol>

      <p className="text-[11px] text-muted">
        Auto-update is built into the GUI — click{" "}
        <strong>Check for updates</strong> any time to install a newer
        version. Future builds will be code-signed so the SmartScreen
        warning above goes away.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Advanced — Docker / direct Python / Mac placeholder
// ---------------------------------------------------------------------

function DockerCommands({
  saasBaseUrl,
  token,
  hasToken,
}: {
  saasBaseUrl: string;
  token: string;
  hasToken: boolean;
}) {
  const [tab, setTab] = useState<"powershell" | "bash">("powershell");
  const commands = {
    powershell: [
      `docker compose run --rm \``,
      `  -e SAAS_BASE_URL="${saasBaseUrl}" \``,
      `  -e RUNNER_TOKEN="${token}" \``,
      `  -e RUNNER_POLL_INTERVAL_SECONDS="5" \``,
      `  app python main.py --runner-poll`,
    ].join("\n"),
    bash:
      `SAAS_BASE_URL="${saasBaseUrl}" ` +
      `RUNNER_TOKEN="${token}" ` +
      `RUNNER_POLL_INTERVAL_SECONDS="5" ` +
      `docker compose run --rm app python main.py --runner-poll`,
  } as const;

  return (
    <section className="space-y-2">
      <div className="text-xs font-medium text-text">
        Docker (developer)
      </div>
      <p className="text-[11px] text-muted">
        Run from a clone of the{" "}
        <code className="id-mono">flow-bof-automation</code> repo with
        Docker Desktop running.
      </p>
      <div className="flex items-center gap-2">
        {(["powershell", "bash"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`btn text-[11px] px-3 py-1.5 ${
              tab === t ? "btn-primary" : "btn-ghost"
            }`}
          >
            {t === "powershell" ? "Windows PowerShell" : "macOS / Linux"}
          </button>
        ))}
      </div>
      <CodeBlock value={commands[tab]} copyable={hasToken} />
    </section>
  );
}

function PythonCommand({
  saasBaseUrl,
  token,
  hasToken,
}: {
  saasBaseUrl: string;
  token: string;
  hasToken: boolean;
}) {
  const cmd =
    `set SAAS_BASE_URL=${saasBaseUrl} && ` +
    `set RUNNER_TOKEN=${token} && ` +
    `python runner_app.py`;
  return (
    <section className="space-y-2">
      <div className="text-xs font-medium text-text">
        Direct Python (developer)
      </div>
      <p className="text-[11px] text-muted">
        Runs the same code path the exe wraps. Useful for iterating
        on <code className="id-mono">src/runner_app/</code>.
      </p>
      <CodeBlock value={cmd} copyable={hasToken} />
    </section>
  );
}

// ---------------------------------------------------------------------
// Mac runner panel
// ---------------------------------------------------------------------
//
// When NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL is set, this renders an
// active "Download Mac Runner" card with Gatekeeper instructions.
// When unset (default), the button is disabled and labelled "coming
// soon" so we don't surface a dead link — the build pipeline for the
// .dmg is run manually on a Mac.
function MacRunner({
  saasBaseUrl,
  token,
  filledIn,
  hasToken,
}: {
  saasBaseUrl: string;
  token: string;
  filledIn: boolean;
  hasToken: boolean;
}) {
  const available = !!MAC_RELEASE_URL;
  return (
    <div className="rounded-2xl border border-border bg-panel2 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="section-title">macOS</div>
          <p className="text-xs text-muted mt-1">
            {available
              ? "Drag into Applications, then double-click."
              : "Mac build is available — set NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL in the SaaS env to enable this download button."}
          </p>
        </div>
        {available ? (
          <a
            href={MAC_RELEASE_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary text-xs"
          >
            Download Mac Runner ↗
          </a>
        ) : (
          <button
            type="button"
            disabled
            className="btn text-xs opacity-60 cursor-not-allowed"
            title="Set NEXT_PUBLIC_RUNNER_MAC_RELEASE_URL in the SaaS env to enable."
          >
            Mac Runner coming soon
          </button>
        )}
      </div>

      {available ? (
        <ol className="text-sm text-text/85 list-decimal pl-5 space-y-1.5">
          <li>
            Download{" "}
            <code className="id-mono">FlowBOFRunner-mac-alpha.dmg</code>{" "}
            from {LATEST_RUNNER_TAG_HINT} on GitHub Releases.
          </li>
          <li>
            Open the .dmg. Drag <strong>Flow BOF Runner</strong> into{" "}
            <code className="id-mono">Applications</code>.
          </li>
          <li>
            Open Applications, <strong>right-click → Open</strong> the
            first time (Gatekeeper bypass — only needed once because
            the alpha builds aren&apos;t code-signed yet). The GUI
            window will open within a few seconds.
          </li>
          <li>
            When prompted, paste your SaaS URL and runner token:
            <CopyPasteBox
              label="SaaS URL"
              value={saasBaseUrl}
              copyable
            />
            <CopyPasteBox
              label="Runner token"
              value={hasToken ? token : ""}
              copyable={filledIn}
              placeholder={
                hasToken
                  ? "Rotate the token in step 2 to copy the full value."
                  : "Generate a token in step 2 first."
              }
            />
          </li>
          <li>
            A dedicated Chrome window opens. Sign into Google Flow
            inside it.
          </li>
          <li>
            Leave the Terminal window open while jobs run.
          </li>
        </ol>
      ) : (
        <p className="text-[11px] text-muted">
          Contributors can build locally from a Mac with{" "}
          <code className="id-mono">scripts/build_runner_mac.sh</code>;
          see{" "}
          <code className="id-mono">docs/RUNNER_PACKAGING.md</code> in
          the runner repo. The signed/notarised build is on the
          roadmap.
        </p>
      )}

      {available && (
        <p className="text-[11px] text-muted">
          First-launch Gatekeeper prompt? Right-click the .app →{" "}
          <strong>Open</strong> → <strong>Open</strong>, or use
          System Settings → Privacy &amp; Security → Open Anyway.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------

function CodeBlock({
  value,
  copyable,
}: {
  value: string;
  copyable: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-2xl border border-border bg-bg/80 p-3 relative">
      <pre className="text-[11.5px] leading-relaxed overflow-x-auto font-mono whitespace-pre">
{value}
      </pre>
      <button
        type="button"
        className="btn btn-ghost text-[11px] px-2 py-1 absolute top-2 right-2 disabled:opacity-40"
        disabled={!copyable}
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }
        }}
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}

function CopyPasteBox({
  label,
  value,
  copyable,
  placeholder,
}: {
  label: string;
  value: string;
  copyable: boolean;
  placeholder?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-[11px] text-muted shrink-0 w-24">{label}:</span>
      {value ? (
        <code className="id-mono flex-1 truncate bg-bg/60 rounded-md px-2 py-1">
          {value}
        </code>
      ) : (
        <span className="text-[11px] text-muted italic flex-1">
          {placeholder ?? "—"}
        </span>
      )}
      <button
        type="button"
        className="btn btn-ghost text-[11px] px-2 py-1 disabled:opacity-40"
        disabled={!copyable || !value}
        onClick={() => {
          if (typeof navigator !== "undefined" && navigator.clipboard) {
            navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }
        }}
      >
        {copied ? "✓" : "Copy"}
      </button>
    </div>
  );
}
