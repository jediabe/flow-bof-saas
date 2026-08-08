/**
 * Per-request context propagation.
 *
 * The MCP server object is shared across all HTTP requests, but each request
 * belongs to a different end user with different useapi.net credentials.
 * AsyncLocalStorage carries that identity from the Express middleware down into
 * the tool handlers without threading it through every function signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "./types.js";

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Returns the context for the in-flight request.
 * @throws if called outside a request scope — that indicates a wiring bug.
 */
export function requireContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "No request context available. Tool handlers must run inside runWithContext().",
    );
  }
  return ctx;
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}
