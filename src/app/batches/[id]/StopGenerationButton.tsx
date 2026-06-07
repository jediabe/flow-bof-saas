"use client";

import { useState, useTransition } from "react";
import { cancelBatchJobs } from "../actions";

/**
 * Phase 7-ish — kill switch.
 *
 * Big red button at the top of the batch page that cancels every
 * queued or running job in this batch. The runner picks up the
 * cancellation on its next /events POST (between items) and exits
 * cleanly. See `cancelBatchJobs` in actions.ts for the full
 * propagation contract.
 *
 * Only renders when there's actually something to cancel — the
 * parent page passes `activeJobs` (count of queued + running). When
 * that's 0, this component returns null so the header stays clean.
 */
export default function StopGenerationButton({
  batchId,
  activeJobs,
}: {
  batchId: string;
  /** Count of queued + running jobs in this batch right now. */
  activeJobs: number;
}) {
  const [pending, startTransition] = useTransition();
  const [resultMsg, setResultMsg] = useState<string | null>(null);

  if (activeJobs <= 0) return null;

  function onClick() {
    if (
      !window.confirm(
        `Stop all generation for this batch?\n\n` +
          `This will cancel ${activeJobs} queued or running job${activeJobs === 1 ? "" : "s"}.\n\n` +
          `The runner will finish the item it's currently working on, ` +
          `then exit cleanly. Items completed so far are kept.`,
      )
    ) {
      return;
    }
    setResultMsg(null);
    const fd = new FormData();
    fd.set("batchId", batchId);
    startTransition(async () => {
      const r = await cancelBatchJobs(fd);
      setResultMsg(r.message);
    });
  }

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="btn btn-danger text-xs"
        title="Cancel every queued and running generation job in this batch. The runner finishes the current item then exits."
      >
        {pending
          ? "Cancelling…"
          : `■ Stop generation (${activeJobs} active)`}
      </button>
      {resultMsg && (
        <span className="text-[10px] text-muted leading-tight max-w-[16rem] text-right">
          {resultMsg}
        </span>
      )}
    </div>
  );
}
