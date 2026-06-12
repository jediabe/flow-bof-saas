"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Phase 11 — action sheet for batch-wide actions launched from a
 * lane header button.
 *
 * The lane header buttons (Add products / Generate AI prompts /
 * Generate images / Scan Flow / Generate videos) open one of these
 * sheets. Each sheet renders the corresponding legacy panel
 * (AiPromptsPanel, GenerateImagesPanel, BatchWorkbench, etc.) so
 * the existing form / progress / status code keeps working — only
 * the launch mechanism is new.
 *
 * Centered modal with a max-width container, dark backdrop, ESC
 * to close, click-outside to close. Distinct from BatchDrawer
 * (right-side overlay for informational panels) so the user has
 * a clear mental model: drawer = ambient info, sheet = "do
 * something specific."
 */
export default function BatchActionSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  // ESC to close. Only attach the listener while the sheet is
  // open so background pages don't burn keystrokes on a noop.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock background scroll while the sheet is up so the page
  // doesn't shift around behind the modal.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 pb-8 px-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        // Click on the backdrop closes; clicks inside the sheet bubble
        // up here too, so we check the target.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-bg/80 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Sheet body. Stops click propagation so clicks inside the
          panel don't trip the backdrop's onClick. */}
      <div
        className="relative w-full max-w-3xl bg-panel border border-border rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text leading-tight">
              {title}
            </h2>
            {subtitle && (
              <p className="text-xs text-muted mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost text-xs px-2 py-1 shrink-0"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
