"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addTikTokAccount } from "./actions";

/**
 * Add-account form. Client component because we want inline
 * validation feedback + a status message after the server action
 * completes, without a full page reload.
 *
 * The server action does the real cookie parsing + encryption; this
 * form is just a thin wrapper that surfaces the result.
 */
export default function AccountForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{
    tone: "ok" | "bad";
    text: string;
  } | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setMessage(null);
    startTransition(async () => {
      const r = await addTikTokAccount(fd);
      if (r.ok) {
        setMessage({ tone: "ok", text: r.message });
        form.reset();
        router.refresh();
      } else {
        setMessage({ tone: "bad", text: r.message });
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label htmlFor="label" className="label">
            Label / nickname
          </label>
          <input
            id="label"
            name="label"
            type="text"
            required
            placeholder="e.g. Halara US affiliate"
            className="field mt-1"
            disabled={pending}
          />
        </div>
        <div>
          <label htmlFor="region" className="label">
            Region
          </label>
          <select
            id="region"
            name="region"
            defaultValue="US"
            className="field mt-1"
            disabled={pending}
          >
            <option value="US">US</option>
            <option value="UK">UK</option>
          </select>
        </div>
        <div>
          <label htmlFor="monthlyToolCost" className="label">
            Monthly tool cost
          </label>
          <input
            id="monthlyToolCost"
            name="monthlyToolCost"
            type="number"
            min={0}
            step="0.01"
            defaultValue="0"
            className="field mt-1"
            disabled={pending}
          />
          <p className="text-[10px] text-muted mt-1">
            Enter in the same currency the account earns in
            (GBP for UK shops, USD for US shops).
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="cookieRaw" className="label">
          Cookie paste
        </label>
        <textarea
          id="cookieRaw"
          name="cookieRaw"
          required
          rows={5}
          placeholder="Paste the entire Cookie header from a logged-in TikTok Shop session. We extract sessionid, sessionid_ss, tt-target-idc, msToken, ttwid, and passport_csrf_token. Anything else is ignored."
          className="field mt-1 font-mono text-[11px] leading-snug"
          disabled={pending}
          spellCheck={false}
        />
        <p className="text-[11px] text-muted mt-1">
          The paste is encrypted (AES-GCM) before it touches the
          database. Cookie values never leave the server.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={pending}
        >
          {pending ? "Adding…" : "Add account"}
        </button>
        {message && (
          <span
            className={`text-xs ${
              message.tone === "ok" ? "text-ok" : "text-bad"
            }`}
          >
            {message.text}
          </span>
        )}
      </div>
    </form>
  );
}
