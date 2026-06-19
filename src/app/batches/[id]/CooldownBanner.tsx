import Link from "next/link";

/**
 * v0.6.15-alpha — surfaces a workspace-level cooldown on the batch
 * page so the user knows why "Generate images" buttons will refuse
 * to dispatch (or why a freshly-clicked one came back with a
 * cooldown error). Server-rendered: the cooldown state lives on
 * WorkspaceSettings and the parent server component computes the
 * remaining time per render.
 *
 * Hidden when not in cooldown — caller can pass nothing and this
 * component will be a no-op visually.
 */
export default function CooldownBanner({
  inCooldown,
  reason,
  remainingMinutes,
}: {
  inCooldown: boolean;
  reason: string | null;
  remainingMinutes: number;
}) {
  if (!inCooldown) return null;

  const remainingLabel =
    remainingMinutes >= 60
      ? `${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m`
      : `${remainingMinutes}m`;

  return (
    <div
      role="alert"
      className="rounded-2xl border border-bad/40 bg-bad/[0.08] text-sm text-bad px-4 py-3 space-y-2"
    >
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="font-semibold">
          ⚠ Image generation paused — Flow flagged this session
        </div>
        <Link
          href="/settings#anti-block"
          className="text-xs text-bad hover:underline shrink-0"
        >
          Manage in Settings →
        </Link>
      </div>
      <p className="text-xs leading-relaxed text-bad/90">
        Flow returned{" "}
        <code className="id-mono text-[11px]">
          {reason ?? "PUBLIC_ERROR_UNUSUAL_ACTIVITY"}
        </code>{" "}
        from a recent submit. Holding off new image-gen jobs for{" "}
        <strong>{remainingLabel}</strong> so the session score
        recovers — submitting now would compound the score. Use Flow
        manually (browse the dashboard, generate 1-2 videos by hand)
        to help warm the account back up.
      </p>
    </div>
  );
}
