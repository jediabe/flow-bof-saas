import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import Panel from "@/components/ui/Panel";
import EmptyState from "@/components/ui/EmptyState";
import StatusChip from "@/components/StatusChip";
import { createAgent, deleteAgent } from "./actions";
import TestAgentForm from "./TestAgentForm";
import RunnerTokenPanel from "./RunnerTokenPanel";

export const dynamic = "force-dynamic";

function timeAgo(d: Date | null | undefined): string {
  if (!d) return "never";
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function RunnerPage() {
  const { workspace } = await getCurrentWorkspace();
  const agents = await db.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
  });

  const defaultBaseUrl =
    process.env.NEXT_PUBLIC_AGENT_BASE_URL || "http://127.0.0.1:9444";

  return (
    <div className="space-y-8">
      <header>
        <h1 className="h-page">Runner</h1>
        <p className="text-sm text-muted mt-1">
          The local install that drives Chrome and Flow on your machine.
          The cockpit is the brain — this is the hands.
        </p>
      </header>

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
            <label className="label" htmlFor="baseUrl">Base URL</label>
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
              The alpha runner listens on{" "}
              <code className="id-mono">{defaultBaseUrl}</code> by default.
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
          hint="The cockpit needs a local runner to drive Flow. Register one above."
        />
      ) : (
        <div className="space-y-3">
          {agents.map((a) => {
            const variant =
              a.status === "online"  ? "ok"
            : a.status === "offline" ? "bad"
            :                          "muted";
            return (
              <Panel
                key={a.id}
                title={
                  <span className="flex items-baseline gap-3">
                    <span>{a.name}</span>
                    <StatusChip label={a.status} variant={variant} />
                  </span>
                }
                action={
                  <span className="text-[11px] text-muted">
                    last seen {timeAgo(a.lastSeenAt)}
                  </span>
                }
              >
                <div className="space-y-3">
                  <div className="text-xs text-muted">
                    <span className="text-text/70">Base URL: </span>
                    <code className="id-mono">{a.baseUrl}</code>
                  </div>
                  <RunnerTokenPanel
                    agentId={a.id}
                    hasToken={!!a.runnerTokenHash}
                    last4={a.runnerTokenLast4}
                    connectedAt={a.connectedAt?.toISOString() ?? null}
                    lastPollAt={a.lastPollAt?.toISOString() ?? null}
                    status={a.status}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <TestAgentForm agentId={a.id} />
                    <form action={deleteAgent} className="inline ml-auto">
                      <input type="hidden" name="id" value={a.id} />
                      <button className="btn btn-danger" type="submit">
                        Remove
                      </button>
                    </form>
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
