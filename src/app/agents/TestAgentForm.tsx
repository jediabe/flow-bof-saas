"use client";

import { useState, useTransition } from "react";
import { testAgentHealth } from "./actions";

import type { JobEnvelopeResponse } from "@/lib/agent-client";

interface Result {
  ok: boolean;
  envelope: JobEnvelopeResponse | null;
  jobTypes: string[];
  message: string;
}

export default function TestAgentForm({ agentId }: { agentId: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        <form
          action={async (formData) => {
            // Cast through unknown — server-action return values flow
            // back via the action invocation.
            startTransition(async () => {
              const r = await testAgentHealth(formData);
              setResult(r);
            });
          }}
        >
          <input type="hidden" name="id" value={agentId} />
          <button className="btn" type="submit" disabled={pending}>
            {pending ? "Testing…" : "Test Agent Health"}
          </button>
        </form>
      </div>

      {result && (
        <div className="mt-3 panel p-3 text-xs space-y-2">
          <div className={result.ok ? "text-ok" : "text-bad"}>
            {result.ok ? "✅" : "❌"} {result.message}
          </div>
          {result.jobTypes.length > 0 && (
            <div className="text-muted">
              <span className="text-text">Supported job types:</span>{" "}
              {result.jobTypes.join(", ")}
            </div>
          )}
          {result.envelope && (
            <details>
              <summary className="cursor-pointer text-muted">
                Raw envelope
              </summary>
              <pre className="mt-2 p-2 bg-bg border border-border rounded overflow-x-auto">
{JSON.stringify(result.envelope, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
