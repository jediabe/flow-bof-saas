"use client";

import { useState, useTransition } from "react";
import { getOrCreateBatchPostingToken } from "../actions";

/**
 * Client wrapper for the "Generate Mobile Posting QR" button.
 * Mirrors GenerateReviewTokenButton — distinct action because
 * review and posting tokens live on separate Batch columns and
 * rotate independently.
 */
export default function GeneratePostingTokenButton({
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
            const r = await getOrCreateBatchPostingToken(batchId);
            if (!r.ok) {
              setError(r.message ?? "Could not generate posting token.");
            }
          });
        }}
      >
        {pending ? "Generating…" : "Generate Mobile Posting QR"}
      </button>
      <p className="text-[11px] text-muted">
        Creates a public posting URL anyone with the link can use to
        mark products posted / skipped. No login required.
      </p>
      {error && (
        <div className="text-xs text-bad">⚠ {error}</div>
      )}
    </div>
  );
}
