import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import SampleJobButtons from "../../batches/[id]/SampleJobButtons";

export const dynamic = "force-dynamic";

export default async function NewJobPage() {
  const { workspace } = await getCurrentWorkspace();
  const agents = await db.agent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, baseUrl: true, status: true },
  });

  return (
    <div className="space-y-6">
      <header>
        <Link href="/jobs" className="text-xs text-muted">← Jobs</Link>
        <h1 className="text-2xl font-semibold mt-1">New job (unattached)</h1>
        <p className="text-sm text-muted mt-1">
          For quick agent smoke-tests that don't belong to a specific
          batch. Most real jobs flow from a batch detail page.
        </p>
      </header>

      {agents.length === 0 ? (
        <p className="text-sm text-muted">
          Register an agent first on the{" "}
          <Link href="/agents" className="text-accent">Agents page</Link>.
        </p>
      ) : (
        <SampleJobButtons batchId="" agents={agents} />
      )}
    </div>
  );
}
