"use client";

import { useState, useTransition } from "react";
import { generateUkStorePrompts } from "../actions";

/**
 * Bulk "Generate UK Store Prompts" trigger. Lives inside the Products
 * panel header so the action stays close to the rows it mutates.
 *
 * The `overwrite` toggle lets users blast existing prompts when they
 * want to re-run with updated retailer keywords. Default is off so the
 * common case (fill in the blanks) is one click.
 */
export default function BulkPromptButton({ batchId }: { batchId: string }) {
  const [pending, startTransition] = useTransition();
  const [overwrite, setOverwrite] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function run() {
    setMessage(null);
    startTransition(async () => {
      const r = await generateUkStorePrompts({ batchId, overwrite });
      setMessage(r.message);
    });
  }

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <label className="flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => setOverwrite(e.target.checked)}
        />
        <span className="text-muted">overwrite</span>
      </label>
      <button
        type="button"
        className="btn btn-ghost text-[11px] px-2 py-1"
        disabled={pending}
        onClick={run}
      >
        {pending ? "Generating…" : "Generate UK Store Prompts"}
      </button>
      {message && (
        <span className="text-[11px] text-accent ml-1">{message}</span>
      )}
    </div>
  );
}
