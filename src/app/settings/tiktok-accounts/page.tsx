import Link from "next/link";
import { getCurrentWorkspace } from "@/lib/workspace";
import { db } from "@/lib/db";
import Panel from "@/components/ui/Panel";
import StatusChip from "@/components/StatusChip";
import EmptyState from "@/components/ui/EmptyState";
import AccountForm from "./AccountForm";
import AccountRow from "./AccountRow";

/**
 * BOF Dashboard — Account Management.
 *
 * Lives at /settings/tiktok-accounts so it slots under the existing
 * Settings surface without disturbing the main Settings page. Users
 * can add unlimited TikTok Shop creator accounts, paste session
 * cookies, edit metadata, test cookies against TikHub, and trigger
 * an on-demand refresh.
 *
 * Tenancy: all rows scoped to workspace.id via getCurrentWorkspace().
 */

export const dynamic = "force-dynamic";

export default async function TikTokAccountsPage() {
  const { workspace } = await getCurrentWorkspace();

  const accounts = await db.tikTokAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: [{ createdAt: "asc" }],
    // Never return cookieRaw to the client — only the metadata it
    // needs to render the row. cookieError is OK to show because
    // we already truncate to 500 chars before write.
    select: {
      id: true,
      label: true,
      region: true,
      monthlyToolCost: true,
      cookieStatus: true,
      cookieError: true,
      lastCheckedAt: true,
      createdAt: true,
    },
  });

  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs text-muted mb-1">
          <Link href="/settings" className="hover:text-text">
            ← Settings
          </Link>
        </div>
        <h1 className="h-page">TikTok Shop accounts</h1>
        <p className="text-sm text-muted mt-1">
          Connect your TikTok Shop creator accounts so the BOF
          Dashboard can pull health, revenue, and product
          analytics. Cookies are encrypted at rest (AES-GCM); the
          plaintext never leaves the server.
        </p>
      </header>

      {/* Add form. Server action lives in actions.ts. */}
      <Panel title="Add an account">
        <AccountForm />
      </Panel>

      {/* Account list. Empty state when none. */}
      <Panel
        title={`Connected accounts (${accounts.length})`}
        action={
          accounts.length > 0 ? (
            <Link
              href="/analytics"
              className="text-accent hover:underline"
            >
              Go to dashboard →
            </Link>
          ) : null
        }
      >
        {accounts.length === 0 ? (
          <EmptyState
            icon="◇"
            title="No accounts connected yet"
            hint="Paste your TikTok Shop creator session cookie above to start pulling analytics."
          />
        ) : (
          <div className="space-y-3">
            {accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={{
                  id: a.id,
                  label: a.label,
                  region: a.region,
                  monthlyToolCost: Number(a.monthlyToolCost ?? 0),
                  cookieStatus: a.cookieStatus,
                  cookieError: a.cookieError,
                  lastCheckedAt:
                    a.lastCheckedAt?.toISOString() ?? null,
                  createdAt: a.createdAt.toISOString(),
                }}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="How cookies work" variant="ghost">
        <div className="text-xs text-muted space-y-2 leading-relaxed">
          <p>
            <strong className="text-text">Where to get the cookie.</strong>{" "}
            Open the TikTok Shop creator dashboard in a browser
            you&apos;re logged into. Open DevTools → Network. Reload
            the page. Pick any request, find the &quot;Cookie:&quot;
            header in Request Headers, and copy the entire value.
          </p>
          <p>
            <strong className="text-text">Required keys.</strong>{" "}
            The paste MUST contain{" "}
            <code className="id-mono">sessionid</code>,{" "}
            <code className="id-mono">msToken</code>, and{" "}
            <code className="id-mono">ttwid</code> — without these
            TikHub can&apos;t authenticate. Recommended-but-optional:{" "}
            <code className="id-mono">sessionid_ss</code>,{" "}
            <code className="id-mono">tt-target-idc</code>,{" "}
            <code className="id-mono">passport_csrf_token</code>{" "}
            (QR-code logins don&apos;t issue the latter). Every
            other cookie in the paste is forwarded to TikHub
            verbatim, so it&apos;s safe to paste the entire Cookie
            header rather than picking out specific keys.
          </p>
          <p>
            <strong className="text-text">Storage.</strong> The
            normalized cookie string is encrypted with AES-256-GCM
            using <code className="id-mono">TIKTOK_COOKIE_ENC_KEY</code>{" "}
            from the server environment. Only this server can
            decrypt it; the client never sees plaintext.
          </p>
          <p>
            <strong className="text-text">Expiry.</strong> TikTok
            cookies expire periodically (typically weekly or after a
            logout). When the dashboard sees a 401/428 from TikHub
            we mark the account as expired and surface a paste-new-
            cookie prompt here.
          </p>
        </div>
      </Panel>
    </div>
  );
}
