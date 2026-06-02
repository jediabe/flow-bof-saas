/**
 * Shared helpers for the /api/runner/* route handlers. Centralises:
 *   - 401 unauthenticated / 404 wrong-agent error shapes
 *   - JSON body parsing with a safe error response
 *
 * Each route stays a tiny function on top of these helpers.
 */

import { NextResponse } from "next/server";
import type { AgentForRunner } from "@/lib/runner-auth";
import { findAgentForToken } from "@/lib/runner-auth";

export function unauthorized(message = "Unauthorized") {
  return NextResponse.json(
    { ok: false, error: { code: "UNAUTHORIZED", message } },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

export function notFound(message: string) {
  return NextResponse.json(
    { ok: false, error: { code: "NOT_FOUND", message } },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export function badRequest(message: string) {
  return NextResponse.json(
    { ok: false, error: { code: "BAD_REQUEST", message } },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Resolve the Agent from the request's bearer token. Returns either
 * an `AgentForRunner` or a fully-formed 401 NextResponse the caller
 * should return directly.
 */
export async function requireAgent(
  req: Request,
): Promise<AgentForRunner | NextResponse> {
  const agent = await findAgentForToken(req.headers.get("authorization"));
  if (!agent) return unauthorized();
  return agent;
}

/** Parse a JSON body, returning {} on missing/invalid content. */
export async function readJson<T = Record<string, unknown>>(
  req: Request,
): Promise<T> {
  try {
    const text = await req.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}
