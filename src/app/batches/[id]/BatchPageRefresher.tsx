"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Auto-refresh the batch detail page when the user tabs back to
 * it. The common case this fixes: the user opens the Mobile QR on
 * their phone, approves a few products, and switches back to the
 * desktop. Without this hook, server-side revalidatePath() has
 * invalidated the cache but the already-rendered React tree in
 * the browser stays stale until manual reload.
 *
 * Triggers on:
 *   - visibilitychange → "visible" (tab re-enters foreground)
 *   - window focus      (clicked back into the SaaS window)
 *
 * A 20s polling fallback also runs while the page is visible —
 * catches the rare case where the user has both the SaaS tab and
 * the mobile QR tab side-by-side in the same browser and never
 * fires a focus event. Cheap (one RSC re-fetch) but throttled so
 * we don't hammer the server during long idle sessions.
 */
export default function BatchPageRefresher() {
  const router = useRouter();

  useEffect(() => {
    let lastRefresh = Date.now();
    const MIN_INTERVAL_MS = 4_000; // throttle so rapid focus
                                   // flips don't spam refresh

    function maybeRefresh() {
      const now = Date.now();
      if (now - lastRefresh < MIN_INTERVAL_MS) return;
      lastRefresh = now;
      router.refresh();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") maybeRefresh();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", maybeRefresh);

    // Backup polling — fires every 20s only when visible.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") maybeRefresh();
    }, 20_000);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", maybeRefresh);
      clearInterval(interval);
    };
  }, [router]);

  return null;
}
