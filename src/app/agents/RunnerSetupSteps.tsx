"use client";

import { useState } from "react";
import RunnerTokenPanel from "./RunnerTokenPanel";
import RunnerCommands from "./RunnerCommands";

/**
 * Client-side glue between steps 2 (mint token) and 3 (copy command).
 *
 * The token can only be displayed once — right after generation —
 * because the SaaS only ever stores its SHA-256 hash. By owning the
 * `freshToken` state here we can pipe that one-time value into the
 * copy-paste command block without round-tripping it through the
 * server again.
 *
 * When the user clicks "hide" in the token panel, `freshToken` goes
 * back to null and the commands display a `runner_xxx` placeholder
 * with a hint to rotate the token if they need a filled-in copy.
 */
export default function RunnerSetupSteps({
  agentId,
  hasToken,
  last4,
  connectedAt,
  lastPollAt,
  status,
  saasBaseUrl,
}: {
  agentId: string;
  hasToken: boolean;
  last4: string | null;
  connectedAt: string | null;
  lastPollAt: string | null;
  status: string;
  saasBaseUrl: string;
}) {
  const [freshToken, setFreshToken] = useState<string | null>(null);

  // After a successful mint the panel exposes the token to us; after
  // the user explicitly hides it, the panel clears it again.
  const tokenSet = hasToken || freshToken !== null;

  return (
    <>
      <section>
        <div className="section-title mb-2">2. Generate runner token</div>
        <RunnerTokenPanel
          agentId={agentId}
          hasToken={hasToken}
          last4={last4}
          connectedAt={connectedAt}
          lastPollAt={lastPollAt}
          status={status}
          onTokenChange={setFreshToken}
        />
      </section>

      <section>
        <div className="section-title mb-2">
          3. Start the local runner
        </div>
        <RunnerCommands
          saasBaseUrl={saasBaseUrl}
          hasToken={tokenSet}
          freshToken={freshToken}
        />
      </section>
    </>
  );
}
