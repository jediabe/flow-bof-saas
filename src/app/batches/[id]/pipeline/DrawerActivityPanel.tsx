"use client";

import Link from "next/link";
import StatusChip from "@/components/StatusChip";
import { friendlyJobType } from "@/lib/job-types";

/**
 * Phase 10 — Activity panel inside the drawer.
 *
 * Compact job log. Replaces the old Activity tab. Same data, just
 * laid out for the narrower drawer width (no per-row Status chip
 * + Link blow-out — single-line rows that look like a notification
 * feed).
 */

const STATUS_VARIANT: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  queued:    "muted",
  running:   "warn",
  succeeded: "ok",
  failed:    "bad",
  cancelled: "muted",
};

export interface ActivityJob {
  id: string;
  jobType: string;
  status: string;
  createdAt: string;  // ISO
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function DrawerActivityPanel({
  jobs,
}: {
  jobs: ActivityJob[];
}) {
  if (jobs.length === 0) {
    return (
      <div className="text-muted2 text-xs italic px-1 py-4">
        No jobs run for this batch yet. Trigger an image generation from a
        Ready card to populate the activity log.
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {jobs.map((j) => (
        <li
          key={j.id}
          className="py-2.5 flex items-baseline gap-2.5 text-xs"
        >
          <StatusChip
            label={j.status}
            variant={STATUS_VARIANT[j.status] ?? "muted"}
          />
          <Link
            href={`/jobs/${j.id}`}
            className="flex-1 min-w-0 text-text hover:text-accent transition-colors truncate"
          >
            {friendlyJobType(j.jobType)}
          </Link>
          <span className="text-muted2 text-[11px] shrink-0">
            {timeAgo(j.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
