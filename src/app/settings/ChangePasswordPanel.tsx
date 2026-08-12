"use client";

/**
 * Change-password panel — sits inside the Account/Workspace
 * section of /settings. Three inputs (current, new, confirm),
 * client-side match check for early feedback, server-side
 * validation as the source of truth.
 *
 * Never returns the plaintext values back to the client on
 * success; the form clears on OK so a shoulder-surfer can't
 * read the value from an inspector after the fact.
 *
 * Uses React 19's useActionState for pending + error surfacing.
 */

import { useActionState, useEffect, useRef, useState } from "react";
import {
  changePasswordAction,
  type ChangePasswordState,
} from "@/app/(auth)/actions";

const INITIAL: ChangePasswordState = { ok: false, message: "" };

export default function ChangePasswordPanel() {
  const [state, formAction, pending] = useActionState(
    changePasswordAction,
    INITIAL,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  // Clear the form on a successful update so the password
  // values aren't sitting in the DOM after the transaction
  // completes. The success message stays for a few seconds.
  useEffect(() => {
    if (state.ok && formRef.current) {
      formRef.current.reset();
    }
  }, [state.ok, state.message]);

  function onSubmit(_event: React.FormEvent<HTMLFormElement>) {
    // Client-side pre-check for match — server validates too but
    // this gives instant feedback without a round-trip.
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const next = String(fd.get("newPassword") || "");
    const confirm = String(fd.get("confirmPassword") || "");
    if (next && confirm && next !== confirm) {
      _event.preventDefault();
      setClientError("The two new-password fields don't match.");
      return;
    }
    setClientError(null);
  }

  // Prefer client-side error while the user is typing; fall
  // back to whatever the server said.
  const displayMessage = clientError ?? state.message;
  const displayOk = clientError == null && state.ok;

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={onSubmit}
      className="space-y-3"
    >
      <div>
        <label className="label" htmlFor="cp-current">
          Current password
        </label>
        <input
          id="cp-current"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          className="field mt-1"
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="cp-new">
            New password
          </label>
          <input
            id="cp-new"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            required
            disabled={pending}
            className="field mt-1"
          />
          <p className="text-[11px] text-muted mt-1">
            Minimum 8 characters.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="cp-confirm">
            Confirm new password
          </label>
          <input
            id="cp-confirm"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            required
            disabled={pending}
            className="field mt-1"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 flex-wrap pt-1">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary"
        >
          {pending ? "Updating…" : "Change password"}
        </button>
        {displayMessage && (
          <span
            className={
              "text-[12px] " + (displayOk ? "text-ok" : "text-bad")
            }
          >
            {displayOk ? "✓ " : ""}{displayMessage}
          </span>
        )}
      </div>
    </form>
  );
}
