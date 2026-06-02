import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import StatusChip from "@/components/StatusChip";
import { createAgent, deleteAgent } from "./actions";
import TestAgentForm from "./TestAgentForm";
import RunnerSetupSteps from "./RunnerSetupSteps";
import {
  getRunnerMode,
  runnerModeBlurb,
  runnerModeLabel,
} from "@/lib/runner-mode";

export const dynamic = "force-dynamic";

function timeAgo(d: Date | null | undefined): string {
  if (!d) return "never";
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function RunnerSetupPage() {
  const { workspace } = await getCurrentWorkspace();
  const agents = await db.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
  });

  const defaultBaseUrl =
    process.env.NEXT_PUBLIC_AGENT_BASE_URL || "http://127.0.0.1:9444";
  // The runner needs the SaaS's *publicly reachable* hostname when
  // it's polling from another machine. Falls back to localhost for
  // local dev so the copy-paste command still does something useful.
  const saasBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const mode = getRunnerMode();
  const bannerTone =
    mode === "polling"
      ? "border-accent/40 bg-accent/[0.06] text-text"
      : "border-border bg-panel2 text-text";

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h-page">Runner Setup</h1>
        <p className="text-sm text-muted mt-1">
          Connect your local machine to the cockpit. The runner is the
          install on your computer that drives Chrome and Google Flow;
          this page is where you register it, generate its token, and
          confirm it's online.
        </p>
      </header>

      <div
        className={`rounded-2xl border px-5 py-3 text-sm flex flex-wrap items-center gap-3 ${bannerTone}`}
      >
        <StatusChip
          label={runnerModeLabel(mode)}
          variant={mode === "polling" ? "accent" : "muted"}
        />
        <span>{runnerModeBlurb(mode)}</span>
      </div>

      <Panel title="Register runner">
        <form
          action={createAgent}
          className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end"
        >
          <div>
            <label className="label" htmlFor="name">Name</label>
            <input
              className="field"
              id="name"
              name="name"
              placeholder="My laptop"
              required
            />
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="baseUrl">Base URL (direct mode only)</label>
            <input
              className="field"
              id="baseUrl"
              name="baseUrl"
              defaultValue={defaultBaseUrl}
              required
            />
          </div>
          <div className="md:col-span-3 flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted">
              In polling mode the Base URL is unused — the runner reaches
              the cockpit, not the other way around. Any non-empty value
              is fine.
            </p>
            <button className="btn btn-primary" type="submit">
              Register runner
            </button>
          </div>
        </form>
      </Panel>

      {agents.length === 0 ? (
        <EmptyState
          icon="◆"
          title="No runners registered"
          hint="Register a runner above. You'll then generate a token and paste a command into your local terminal to bring it online."
        />
      ) : (
        <div className="space-y-6">
          {agents.map((a) => {
            const variant =
              a.status === "online"  ? "ok"
            : a.status === "offline" ? "bad"
            :                          "muted";
            const recently =
              a.lastPollAt &&
              Date.now() - new Date(a.lastPollAt).getTime() < 5 * 60 * 1000;
            return (
              <Panel
                key={a.id}
                title={
                  <span className="flex items-baseline gap-3">
                    <span>{a.name}</span>
                    <StatusChip
                      label={recently ? "online" : a.status}
                      variant={recently ? "ok" : variant}
                    />
                  </span>
                }
                action={
                  <span className="text-[11px] text-muted">
                    last seen {timeAgo(a.lastSeenAt)}
                  </span>
                }
              >
                <div className="space-y-6">
                  {/* ----- 1. Runner status ----------------------- */}
                  <section>
                    <div className="section-title mb-2">1. Runner status</div>
                    <dl className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                      <StatusRow k="Last poll"      v={timeAgo(a.lastPollAt)} />
                      <StatusRow k="Last seen"      v={timeAgo(a.lastSeenAt)} />
                      <StatusRow k="Connected since" v={timeAgo(a.connectedAt)} />
                      <StatusRow
                        k="Token"
                        v={
                          a.runnerTokenHash
                            ? `set (****${a.runnerTokenLast4 ?? "—"})`
                            : "not generated"
                        }
                      />
                      <StatusRow k="Base URL (direct only)" v={a.baseUrl} mono />
                      <StatusRow k="Agent ID" v={a.id} mono />
                    </dl>
                  </section>

                  {/* ----- 2 & 3: Token + copy-paste commands ----- */}
                  <RunnerSetupSteps
                    agentId={a.id}
                    hasToken={!!a.runnerTokenHash}
                    last4={a.runnerTokenLast4}
                    connectedAt={a.connectedAt?.toISOString() ?? null}
                    lastPollAt={a.lastPollAt?.toISOString() ?? null}
                    status={a.status}
                    saasBaseUrl={saasBaseUrl}
                  />

                  {/* ----- Direct-mode test + delete -------------- */}
                  <section className="border-t border-border pt-4 flex flex-wrap items-center gap-2">
                    <TestAgentForm agentId={a.id} />
                    <form action={deleteAgent} className="inline ml-auto">
                      <input type="hidden" name="id" value={a.id} />
                      <button className="btn btn-danger" type="submit">
                        Remove runner
                      </button>
                    </form>
                  </section>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      {/* ----- Troubleshooting panel ----------------------------- */}
      <Panel title="Troubleshooting">
        <ul className="text-sm space-y-2 list-disc pl-5 text-text/85">
          <li>
            <strong>Docker Desktop</strong> must be running before you
            execute the command above.
          </li>
          <li>
            Run from the <code className="id-mono">flow-bof-automation</code>{" "}
            repo folder — the runner image's working directory expects
            its own source tree.
          </li>
          <li>
            <strong>Chrome debug profile</strong> must be started for
            Flow automation jobs. The runner connects to a separate
            Chrome instance via CDP; <code className="id-mono">./start.sh</code>{" "}
            (or <code className="id-mono">start.ps1</code> on Windows)
            in the runner repo brings it up.
          </li>
          <li>
            <strong>Google Flow</strong> must be open and logged in
            inside that debug Chrome before queueing scan / video
            jobs.
          </li>
          <li>
            If the runner is polling but never claims jobs, double-check:
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>The right runner is selected in the batch action.</li>
              <li>
                The hosted SaaS has{" "}
                <code className="id-mono">APP_RUNNER_MODE=polling</code>{" "}
                set (see Settings → Runner mode).
              </li>
              <li>The job's status really is queued, not failed.</li>
              <li>
                Runner capabilities cover the job type
                (<code className="id-mono">scan_favorited_images</code>,{" "}
                <code className="id-mono">generate_flow_images</code>, …).
              </li>
            </ul>
          </li>
        </ul>
      </Panel>
    </div>
  );
}

function StatusRow({
  k,
  v,
  mono = false,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-muted">{k}</dt>
      <dd className={`text-text mt-0.5 ${mono ? "id-mono" : ""}`}>{v}</dd>
    </div>
  );
}
