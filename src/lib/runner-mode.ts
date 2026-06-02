/**
 * Runner-mode selector.
 *
 * Two modes:
 *   - "direct"  — local-dev. The SaaS server calls the local agent's
 *                 HTTP API directly (e.g. http://127.0.0.1:9444).
 *                 Server and runner share a host.
 *   - "polling" — hosted production. The SaaS creates queued Job rows
 *                 and waits for the connected runner to claim them via
 *                 /api/runner/*. The SaaS never dials out to the
 *                 agent's baseUrl.
 *
 * Resolution order:
 *   1. process.env.APP_RUNNER_MODE — explicit override always wins.
 *      Recognised values: "direct" | "polling" (case-insensitive).
 *      Anything else is treated as "the env var was unset" and falls
 *      through to step 2.
 *   2. NODE_ENV=production       → default "polling".
 *   3. anything else (dev/test)  → default "direct".
 *
 * The hosted prod compose stack sets APP_RUNNER_MODE=polling
 * explicitly via .env.production; this fallback is belt-and-suspenders
 * for the case where the var fails to plumb through (which is exactly
 * the bug we hit on Hostinger).
 *
 * Centralising this in one helper means every callsite — the job
 * dispatcher, the agent-health probe, the UI banners — looks at the
 * same answer. Don't add another `process.env.APP_RUNNER_MODE` read
 * anywhere else in the codebase; route through here.
 */

export type RunnerMode = "direct" | "polling";

export function getRunnerMode(): RunnerMode {
  const raw = (process.env.APP_RUNNER_MODE ?? "").trim().toLowerCase();
  if (raw === "direct")  return "direct";
  if (raw === "polling") return "polling";
  return process.env.NODE_ENV === "production" ? "polling" : "direct";
}

/** Whether the SaaS server is allowed to dial the agent's baseUrl. */
export function canDialAgentDirectly(): boolean {
  return getRunnerMode() === "direct";
}

/** Short human label for chips / banners. */
export function runnerModeLabel(mode: RunnerMode = getRunnerMode()): string {
  return mode === "polling" ? "Connected runner (polling)" : "Direct local mode";
}

/** One-line copy the UI shows to explain the active mode. */
export function runnerModeBlurb(mode: RunnerMode = getRunnerMode()): string {
  return mode === "polling"
    ? "Connected runner mode: jobs are queued and claimed by your local runner."
    : "Direct local mode: this app calls the local runner HTTP API.";
}
