"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { getHealth, getJobTypes } from "@/lib/agent-client";

/**
 * Create a new Agent record. Workspace-scoped to the current
 * (skeleton-default) workspace.
 */
export async function createAgent(formData: FormData): Promise<void> {
  const name = String(formData.get("name") || "").trim();
  const baseUrl = String(formData.get("baseUrl") || "").trim();
  if (!name || !baseUrl) return;

  const { workspace } = await getCurrentWorkspace();
  await db.agent.create({
    data: {
      workspaceId: workspace.id,
      name,
      baseUrl,
      status: "unknown",
    },
  });
  revalidatePath("/agents");
  revalidatePath("/dashboard");
}

/**
 * Update an existing Agent's name + base URL. Skeleton only — no
 * permission checks beyond workspace scoping.
 */
export async function updateAgent(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  const name = String(formData.get("name") || "").trim();
  const baseUrl = String(formData.get("baseUrl") || "").trim();
  if (!id || !name || !baseUrl) return;

  const { workspace } = await getCurrentWorkspace();
  await db.agent.updateMany({
    where: { id, workspaceId: workspace.id },
    data: { name, baseUrl },
  });
  revalidatePath("/agents");
}

export async function deleteAgent(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  if (!id) return;
  const { workspace } = await getCurrentWorkspace();
  await db.agent.deleteMany({ where: { id, workspaceId: workspace.id } });
  revalidatePath("/agents");
  revalidatePath("/dashboard");
}

/**
 * Probe the agent's /health endpoint and persist what we observed
 * onto the Agent row.
 */
export async function testAgentHealth(formData: FormData): Promise<{
  ok: boolean;
  envelope: import("@/lib/agent-client").JobEnvelopeResponse | null;
  jobTypes: string[];
  message: string;
}> {
  const id = String(formData.get("id") || "");
  if (!id) return { ok: false, envelope: null, jobTypes: [], message: "missing id" };

  const { workspace } = await getCurrentWorkspace();
  const agent = await db.agent.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!agent) return { ok: false, envelope: null, jobTypes: [], message: "agent not found" };

  const token = process.env.AGENT_API_TOKEN || undefined;
  let ok = false;
  let envelope: import("@/lib/agent-client").JobEnvelopeResponse | null = null;
  let jobTypes: string[] = [];
  let message = "";

  try {
    envelope = await getHealth(agent.baseUrl, token);
    ok = envelope?.status === "succeeded";
    try {
      const types = await getJobTypes(agent.baseUrl, token);
      jobTypes = types.job_types;
    } catch {
      // /jobs/types is informational — health is the authoritative signal.
    }
  } catch (err) {
    const e = err as Error;
    message = `${e.name}: ${e.message}`;
  }

  await db.agent.update({
    where: { id: agent.id },
    data: {
      status: ok ? "online" : "offline",
      lastSeenAt: ok ? new Date() : agent.lastSeenAt,
    },
  });
  revalidatePath("/agents");

  return {
    ok,
    envelope,
    jobTypes,
    message: message || (ok ? "Agent reachable." : "Agent did not respond."),
  };
}
