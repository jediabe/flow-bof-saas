"use client";

import { useState } from "react";

/**
 * Tiny "Copy to clipboard" button. Falls back to a textarea +
 * execCommand on browsers without clipboard.writeText (rare in
 * 2026, but token URLs are sensitive enough that a silent failure
 * is bad UX).
 */
export default function CopyReviewUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  async function copy() {
    setError(false);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // execCommand fallback for very old browsers / non-HTTPS.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(true);
      setTimeout(() => setError(false), 2500);
    }
  }

  let label = "Copy URL";
  if (copied) label = "Copied ✓";
  if (error) label = "Copy failed";

  return (
    <button
      type="button"
      onClick={copy}
      className="btn btn-ghost text-xs"
    >
      {label}
    </button>
  );
}
