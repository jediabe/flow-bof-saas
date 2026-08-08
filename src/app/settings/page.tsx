import Link from "next/link";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import AiProviderSettingsForm from "./AiProviderSettings";
import AiPromptOverrides from "./AiPromptOverrides";
import WorkspaceApiTokenPanel from "./WorkspaceApiTokenPanel";
import WorkspaceVoicePanel from "./WorkspaceVoicePanel";
import WorkspaceCapCutPanel from "./WorkspaceCapCutPanel";
import WorkspaceGoogleFlowPanel from "./WorkspaceGoogleFlowPanel";
import {
  getMaskedAiSettings,
  setIpRiskChecksEnabled,
  saveAntiBlockSettings,
  clearUnusualActivityCooldown,
  getWorkspaceApiTokenStatus,
  getWorkspaceVoiceSettings,
  getWorkspaceCapCutTemplateUrl,
  getGoogleFlowAccountStatus,
} from "./actions";
import { loadOrCreateSettings } from "@/lib/workspace-settings";
import { UK_SYSTEM_PROMPT } from "@/lib/ai/uk-retail-prompts";
import { US_SYSTEM_PROMPT } from "@/lib/ai/us-retail-prompts";
import {
  getRunnerMode,
  runnerModeBlurb,
  runnerModeLabel,
} from "@/lib/runner-mode";

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
  const settingsRow = await loadOrCreateSettings(workspace.id);
  const ipRiskChecksEnabled = settingsRow.ipRiskChecksEnabled;
  const apiTokenStatus = await getWorkspaceApiTokenStatus();
  const voiceSettings = await getWorkspaceVoiceSettings();
  const capCutSettings = await getWorkspaceCapCutTemplateUrl();
  const googleFlowStatus = await getGoogleFlowAccountStatus();

  // Cooldown derivation: how much longer until the gate releases?
  const cooldownMs = settingsRow.cooldownHours * 60 * 60 * 1000;
  const inCooldown =
    settingsRow.lastUnusualActivityAt !== null &&
    Date.now() - settingsRow.lastUnusualActivityAt.getTime() < cooldownMs;
  const cooldownRemainingMin = inCooldown
    ? Math.ceil(
        (cooldownMs -
          (Date.now() - settingsRow.lastUnusualActivityAt!.getTime())) /
          60_000,
      )
    : 0;

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

      <Panel title="Workspace API token">
        <WorkspaceApiTokenPanel hasToken={apiTokenStatus.hasToken} />
      </Panel>

      <Panel title="Voice setup (ElevenLabs)">
        <WorkspaceVoicePanel initial={voiceSettings} />
      </Panel>

      <Panel title="CapCut template">
        <WorkspaceCapCutPanel initialUrl={capCutSettings.url} />
      </Panel>

      <Panel title="Google Flow account (via APEX MCP)">
        <WorkspaceGoogleFlowPanel initial={googleFlowStatus} />
      </Panel>

      <Panel title="AI Providers">
        <p className="text-xs text-muted mb-4">
          The cockpit uses AI providers only to author per-product
          image prompts (and optional hook / caption / hashtags). Your
          API keys never leave this server — they are not sent to the
          local runner, and they are not embedded in any job payload.
          See{" "}
          <a
            href="https://github.com/jediabe/flow-bof-saas/blob/main/docs/AI_PROVIDERS.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            docs/AI_PROVIDERS.md
          </a>{" "}
          for details.
        </p>
        <AiProviderSettingsForm initial={aiSettings} />
      </Panel>

      <Panel title="AI image prompts">
        <p className="text-xs text-muted mb-4">
          Per-workspace overrides for the system prompts the AI uses
          when generating per-product image prompts. Edit, save, and
          regenerate a product to see the result — no redeploy
          needed. Leave a field blank to fall back to the bundled
          default. Use &quot;Load default into editor&quot; to start
          from the current bundled prompt and edit from there.
        </p>
        <AiPromptOverrides
          initialUkOverride={settingsRow.ukSystemPromptOverride}
          initialUsOverride={settingsRow.usSystemPromptOverride}
          ukDefault={UK_SYSTEM_PROMPT}
          usDefault={US_SYSTEM_PROMPT}
        />
      </Panel>

      <Panel title="Anti-block — image-gen safety net">
        <p className="text-xs text-muted mb-4">
          Defends against Google Flow&apos;s reCAPTCHA Enterprise risk
          engine. Two gates:
          {" "}<strong>daily cap</strong> blocks the
          {" "}<code>PUBLIC_ERROR_UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC</code>{" "}
          volume signal;{" "}<strong>cooldown</strong> holds off new
          submits after a flag fires so the session score recovers.
          Lower the cap or raise the cooldown if you&apos;re hitting
          flags frequently.
        </p>

        {inCooldown && (
          <div className="rounded-2xl border border-bad/40 bg-bad/[0.08] text-sm text-bad px-4 py-3 mb-4 space-y-2">
            <div className="font-semibold">
              ⚠ Image-gen is in cooldown
            </div>
            <p className="text-xs leading-relaxed">
              Flow returned{" "}
              <code className="id-mono text-[11px]">
                {settingsRow.lastUnusualActivityReason ?? "PUBLIC_ERROR_UNUSUAL_ACTIVITY"}
              </code>{" "}
              recently. Holding off new image-gen dispatches for{" "}
              <strong>
                {cooldownRemainingMin >= 60
                  ? `${Math.floor(cooldownRemainingMin / 60)}h ${cooldownRemainingMin % 60}m`
                  : `${cooldownRemainingMin}m`}
              </strong>{" "}
              — submitting now would compound the session score.
              Use Flow manually in the meantime (browse, generate
              1-2 by hand) to help warm the account back up.
            </p>
            <form action={clearUnusualActivityCooldown}>
              <button
                type="submit"
                className="btn btn-sm"
                title="Clear the cooldown manually. Only do this after you've used Flow by hand and confirmed it works."
              >
                I&apos;ve warmed the account — clear cooldown
              </button>
            </form>
          </div>
        )}

        <form
          action={saveAntiBlockSettings}
          className="grid grid-cols-1 md:grid-cols-2 gap-3"
        >
          <div>
            <label className="label">Daily image-gen cap (24h rolling)</label>
            <input
              type="number"
              name="dailyImageSubmitCap"
              defaultValue={settingsRow.dailyImageSubmitCap}
              min={10}
              max={500}
              step={1}
              className="field mt-1"
            />
            <p className="text-[11px] text-muted mt-1">
              10-500. Default 50 (flow2api community report). Lower if
              you&apos;ve been getting flagged.
            </p>
          </div>
          <div>
            <label className="label">Cooldown after a flag (hours)</label>
            <input
              type="number"
              name="cooldownHours"
              defaultValue={settingsRow.cooldownHours}
              min={1}
              max={48}
              step={1}
              className="field mt-1"
            />
            <p className="text-[11px] text-muted mt-1">
              1-48. Default 4. Longer = safer; the session score
              decays roughly linearly with time.
            </p>
          </div>
          <div className="md:col-span-2">
            <button type="submit" className="btn btn-primary text-sm">
              Save
            </button>
          </div>
        </form>
      </Panel>

      <Panel title="IP / trademark risk screening">
        <p className="text-xs text-muted mb-4">
          When enabled, products containing famous brand names,
          imitation phrases, or protected character references are
          flagged and held back from image generation until you
          explicitly override them. This is a conservative pre-flight
          check — most TikTok Shop branded listings are legitimate, so
          the heuristic can produce false positives. Turn it off if
          you&apos;d rather review IP concerns yourself outside the
          tool.
        </p>
        <form action={setIpRiskChecksEnabled} className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={ipRiskChecksEnabled}
              className="accent-accent"
            />
            Enable IP / trademark risk screening
          </label>
          <button type="submit" className="btn btn-primary text-xs">
            Save
          </button>
          <span className="text-[11px] text-muted ml-auto">
            Currently: {ipRiskChecksEnabled ? (
              <span className="text-ok font-semibold">enabled</span>
            ) : (
              <span className="text-muted2 font-semibold">disabled</span>
            )}
          </span>
        </form>
      </Panel>

      <Panel title="Runner defaults">
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <Row
            k="Runner mode"
            v={
              <span>
                <span className="text-text">{runnerModeLabel()}</span>
                <span className="block text-[11px] text-muted mt-0.5">
                  {runnerModeBlurb()}
                </span>
                <span className="block text-[11px] text-muted2 mt-0.5">
                  APP_RUNNER_MODE={process.env.APP_RUNNER_MODE || "(unset)"}
                  {" · "}NODE_ENV={process.env.NODE_ENV || "(unset)"}
                  {" · resolved="}
                  {getRunnerMode()}
                </span>
              </span>
            }
          />
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
