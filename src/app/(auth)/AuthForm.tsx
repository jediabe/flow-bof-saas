"use client";

import { useActionState } from "react";
import { loginAction, signupAction, type AuthFormState } from "./actions";

/**
 * Shared signup/login form. Same field set minus the name input on
 * login; same server-action state shape so we can reuse the inline
 * error rendering.
 *
 * Uses React 19's `useActionState` so form submissions stay on the
 * page until the server action either redirects (success) or
 * returns an error state.
 */
export default function AuthForm({
  variant,
}: {
  variant: "signup" | "login";
}) {
  const initial: AuthFormState = { error: null };
  const [state, formAction, pending] = useActionState(
    variant === "signup" ? signupAction : loginAction,
    initial,
  );

  return (
    <div className="w-full max-w-md panel p-8 space-y-6">
      <div>
        <h1 className="h-page">
          {variant === "signup" ? "Create your account" : "Welcome back"}
        </h1>
        <p className="text-sm text-muted mt-2">
          {variant === "signup"
            ? "Sign up to launch automation jobs against your own Flow account."
            : "Sign in to your Flow BOF cockpit."}
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        {variant === "signup" && (
          <label className="block">
            <span className="label">Name</span>
            <input
              className="field mt-1"
              type="text"
              name="name"
              autoComplete="name"
              maxLength={120}
              placeholder="Your name"
            />
          </label>
        )}
        <label className="block">
          <span className="label">Email</span>
          <input
            className="field mt-1"
            type="email"
            name="email"
            required
            autoComplete={variant === "signup" ? "email" : "username"}
            maxLength={320}
          />
        </label>
        <label className="block">
          <span className="label">Password</span>
          <input
            className="field mt-1"
            type="password"
            name="password"
            required
            minLength={8}
            autoComplete={
              variant === "signup" ? "new-password" : "current-password"
            }
          />
          {variant === "signup" && (
            <span className="text-[11px] text-muted mt-1 block">
              At least 8 characters.
            </span>
          )}
        </label>

        {state.error && (
          <div className="text-sm text-bad bg-bad/[0.06] border border-bad/30 rounded-xl px-3 py-2">
            {state.error}
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary w-full justify-center"
          disabled={pending}
        >
          {pending
            ? variant === "signup"
              ? "Creating account…"
              : "Signing in…"
            : variant === "signup"
              ? "Create account"
              : "Sign in"}
        </button>
      </form>

      <div className="text-center text-xs text-muted">
        {variant === "signup" ? (
          <>
            Already have an account?{" "}
            <a href="/login" className="text-accent hover:underline">
              Sign in
            </a>
          </>
        ) : (
          <>
            New here?{" "}
            <a href="/signup" className="text-accent hover:underline">
              Create an account
            </a>
          </>
        )}
      </div>
    </div>
  );
}
