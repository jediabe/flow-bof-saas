import type { ReactNode } from "react";

/**
 * Friendly placeholder for "nothing here yet". Drops onto any list /
 * grid / section that hasn't been populated. Keeps the UI from
 * looking broken when there's no data.
 */
export default function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="panel2 rounded-2xl border border-dashed border-border-strong/60 px-8 py-10 text-center">
      {icon && (
        <div className="text-3xl text-muted2 mb-2 leading-none">{icon}</div>
      )}
      <div className="text-sm font-medium text-text">{title}</div>
      {hint && <div className="text-xs text-muted mt-1">{hint}</div>}
      {action && <div className="mt-4 inline-flex">{action}</div>}
    </div>
  );
}
