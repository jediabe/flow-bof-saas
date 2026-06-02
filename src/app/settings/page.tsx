import Link from "next/link";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import AiProviderSettingsForm from "./AiProviderSettings";
import { getMaskedAiSettings } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Settings is a stub in the alpha skeleton. Workspace/runner basics
 * live here so the nav rail has a real destination; auth, billing, and
 * team management land in Phase 4 alongside real auth.
 */
export default async function SettingsPage() {
  const { workspace, user } = await getCurrentWorkspace();
  const defaultBaseUrl =
    process.env.NEXT_PUBLIC_AGENT_BASE_URL || "http://127.0.0.1:9444";
  const aiSettings = await getMaskedAiSettings();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h-page">Settings</h1>
        <p className="text-sm text-muted mt-1">
          Workspace + runner basics. Auth and billing arrive in Phase 4.
        </p>
      </header>

      <Panel title="Workspace">
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <Row k="Name"  v={workspace.name} />
          <Row k="Owner" v={user.email} />
          <Row
            k="Created"
            v={new Date(workspace.createdAt).toLocaleString()}
          />
          <Row k="ID" v={<code className="id-mono">{workspace.id}</code>} />
        </dl>
      </Panel>

      <Panel title="AI Providers">
        <p className="text-xs text-muted mb-4">
          The cockpit uses AI providers only to author per-product
          image prompts (and optional hook / caption / hashtags). Your
          API keys never leave this server — they are not sent to the
          local runner, and they are not embedded in any job payload.
          See{" "}
          <Link
            href="/docs/AI_PROVIDERS.md"
            className="text-accent hover:underline"
          >
            docs/AI_PROVIDERS.md
          </Link>{" "}
          for details.
        </p>
        <AiProviderSettingsForm initial={aiSettings} />
      </Panel>

      <Panel title="Runner defaults">
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <Row
            k="Default runner URL"
            v={<code className="id-mono">{defaultBaseUrl}</code>}
          />
          <Row
            k="Auth token"
            v={
              process.env.AGENT_API_TOKEN
                ? "configured"
                : "unset — runs open"
            }
          />
        </dl>
        <p className="mt-4 text-xs text-muted">
          Manage registered runners on the{" "}
          <Link href="/agents" className="text-accent hover:underline">
            Runner page
          </Link>
          .
        </p>
      </Panel>

      <Panel title="Coming soon" variant="ghost">
        <EmptyState
          icon="⚙"
          title="Auth, team, billing"
          hint="Real authentication, multi-user workspaces, and billing land in Phase 4."
        />
      </Panel>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className="text-text mt-0.5">{v}</dd>
    </div>
  );
}
