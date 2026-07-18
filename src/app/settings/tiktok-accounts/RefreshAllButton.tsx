"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshAllTikTokAccounts } from "./actions";

/**
 * Panel-header button that fires refreshAllTikTokAccounts and
 * surfaces the resulting summary inline. Kept as a separate client
 * component so the parent page.tsx can stay a server component.
 *
 * Toast auto-clears after 6s so a stale summary doesn't confuse
 * the next single-account action.
 */
export default function RefreshAllButton({
  accountCount,
}: {
  accountCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [toast, setToast] = useState<{ tone: "ok" | "bad"; text: string } | null>(
    null,
  );

  function onClick() {
    setToast(null);
    startTransition(async () => {
      const r = await refreshAllTikTokAccounts();
      setToast({ tone: r.ok ? "ok" : "bad", text: r.message });
      setTimeout(() => setToast(null), 6000);
      if (r.ok) router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-3">
      {toast && (
        <span
          className={`text-[11px] ${
            toast.tone === "ok" ? "text-ok" : "text-bad"
          }`}
        >
          {toast.text}
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="btn btn-sm"
        title={
          accountCount === 1
            ? "Refresh the connected account."
            : `Refresh all ${accountCount} accounts. Serial; skips any that hit the 12h cap.`
        }
      >
        {pending ? "Refreshing…" : "Refresh all"}
      </button>
    </div>
  );
}
