"use client";

/**
 * Client wrapper for the "Generate Mobile Review QR" button. Calls
 * the server action via useTransition so we get a pending state
 * without a full page navigation. After success the parent server
 * component re-renders (revalidatePath fires inside the action)
 * and the QR card swaps to its active-token view.
 */

import { useState, useTransition } from "react";
import { getOrCreateBatchReviewToken } from "../actions";

export default function GenerateReviewTokenButton({
  batchId,
}: {
  batchId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn btn-primary text-xs"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await getOrCreateBatchReviewToken(batchId);
            if (!r.ok) {
              setError(r.message ?? "Could not generate review token.");
            }
            // On success the server action revalidates the batch
            // page; the parent server component re-renders and
            // this whole card swaps to the active-token view.
          });
        }}
      >
        {pending ? "Generating…" : "Generate Mobile Review QR"}
      </button>
      <p className="text-[11px] text-muted">
        Creates a public review URL anyone with the link can use.
        No login required. You can revoke the URL later by rotating
        the token.
      </p>
      {error && (
        <div className="text-xs text-bad">⚠ {error}</div>
      )}
    </div>
  );
}
