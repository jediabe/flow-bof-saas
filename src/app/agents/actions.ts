"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getCurrentWorkspace } from "@/lib/workspace";
import { getHealth, getJobTypes } from "@/lib/agent-client";
import { mintRunnerToken } from "@/lib/runner-auth";
import { getRunnerMode } from "@/lib/runner-mode";

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
 * Probe an agent's status. Behaviour depends on the runner mode
 * resolved centrally in src/lib/runner-mode.ts.
 *
 * direct  — POST /health on the agent's baseUrl (the original
 *           local-dev flow). ECONNREFUSED becomes a clean
 *           "Local runner not reachable" message rather than a
 *           thrown error.
 * polling — Never dials the baseUrl. The hosted SaaS can't reach
 *           the user's localhost; "online" is derived from the
 *           connected-runner's own /api/runner/health POSTs (which
 *           update lastPollAt + connectedAt). This action just
 *           reports back what's in the DB.
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

  // Polling mode: never touch the agent's HTTP API — the hosted SaaS
  // can't reach the runner's localhost anyway. Surface the DB-side
  // signal so the user knows whether the connected runner is
  // currently checked in.
  if (getRunnerMode() === "polling") {
    const recently =
      agent.lastPollAt &&
      Date.now() - new Date(agent.lastPollAt).getTime() < 5 * 60 * 1000;
    const message = !agent.runnerTokenHash
      ? "Polling mode: no runner token generated yet."
      : recently
        ? `Polling mode: connected runner last seen ${new Date(agent.lastPollAt!).toLocaleString()}.`
        : agent.lastPollAt
          ? `Polling mode: runner has a token but hasn't checked in since ${new Date(agent.lastPollAt).toLocaleString()}.`
          : "Polling mode: runner has a token but hasn't checked in yet.";
    revalidatePath("/agents");
    return {
      ok: !!recently,
      envelope: null,
      jobTypes: [],
      message,
    };
  }

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
    // Direct-mode connection failure (ECONNREFUSED on a typical
    // "local runner is down" condition). Render a calm message
    // instead of throwing — the action never crashes the page.
    const e = err as Error;
    message = `Local runner not reachable: ${e.name}: ${e.message}`;
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

/**
 * Mint a fresh connected-runner token for an Agent. Returns the
 * full token to the caller exactly once — the DB only ever stores
 * the SHA-256 digest plus the last-4 preview. If the agent already
 * has a token this *replaces* it (rotation).
 *
 * On rotation we also clear `connectedAt` and flip status back to
 * "unknown" so the dashboard accurately shows "not connected" until
 * the runner checks in with the new credentials.
 */
export async function generateRunnerToken(formData: FormData): Promise<{
  ok: boolean;
  token: string;
  last4: string;
  message: string;
}> {
  const id = String(formData.get("id") || "");
  if (!id) {
    return { ok: false, token: "", last4: "", message: "missing agent id" };
  }
  const { workspace } = await getCurrentWorkspace();
  const agent = await db.agent.findFirst({
    where: { id, workspaceId: workspace.id },
    select: { id: true },
  });
  if (!agent) {
    return { ok: false, token: "", last4: "", message: "agent not found" };
  }

  const minted = mintRunnerToken();
  await db.agent.update({
    where: { id: agent.id },
    data: {
      runnerTokenHash:  minted.tokenHash,
      runnerTokenLast4: minted.last4,
      // New token → connection is severed until the new runner says
      // hello. Make that visible to the user.
      connectedAt: null,
      lastPollAt:  null,
      status:      "unknown",
    },
  });
  revalidatePath("/agents");
  revalidatePath("/dashboard");
  return {
    ok: true,
    token: minted.token,
    last4: minted.last4,
    message:
      "Copy this token now — it won't be shown again. " +
      "Set RUNNER_TOKEN on your local runner and start `--runner-poll`.",
  };
}

/**
 * Revoke an Agent's runner token. The next /api/runner/* call from
 * that runner will fail with 401 until the user generates a new one.
 */
export async function revokeRunnerToken(formData: FormData): Promise<void> {
  const id = String(formData.get("id") || "");
  if (!id) return;
  const { workspace } = await getCurrentWorkspace();
  await db.agent.updateMany({
    where: { id, workspaceId: workspace.id },
    data: {
      runnerTokenHash:  null,
      runnerTokenLast4: null,
      connectedAt:      null,
      lastPollAt:       null,
      status:           "unknown",
    },
  });
  revalidatePath("/agents");
  revalidatePath("/dashboard");
}
