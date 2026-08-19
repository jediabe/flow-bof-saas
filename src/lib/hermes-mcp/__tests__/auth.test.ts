import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { middleware } from "@/middleware";
import {
  HermesMcpAuthError,
  resolveHermesMcpAuth,
  type HermesMcpAuthEnvironment,
} from "../auth";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

const devEnvironment = {
  NODE_ENV: "development",
  HERMES_MCP_DEV_TOKEN: "dev-token-123",
  HERMES_MCP_DEV_WORKSPACE_ID: "workspace_123",
} as const;

function captureAuthError(
  header: string | null | undefined,
  environment: HermesMcpAuthEnvironment = devEnvironment,
) {
  try {
    resolveHermesMcpAuth(header, environment);
  } catch (error) {
    expect(error).toBeInstanceOf(HermesMcpAuthError);
    return error as HermesMcpAuthError;
  }
  throw new Error("Expected authentication to fail");
}

describe("resolveHermesMcpAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(timingSafeEqual).mockClear();
  });

  it("returns exactly the configured workspace-scoped service context", () => {
    expect(resolveHermesMcpAuth("Bearer dev-token-123", devEnvironment)).toEqual({
      workspaceId: "workspace_123",
      actorType: "service",
      actorId: "hermes-mcp-dev",
    });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["missing scheme", "dev-token-123"],
    ["wrong scheme", "Basic dev-token-123"],
    ["missing credential", "Bearer"],
    ["credential with whitespace", "Bearer dev-token-123 extra"],
    ["incorrect credential", "Bearer wrong-token"],
  ])("returns unauthorized for a %s authorization header", (_caseName, header) => {
    const error = captureAuthError(header);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });

  it("compares fixed-length SHA-256 digests with timingSafeEqual", () => {
    captureAuthError("Bearer a");

    expect(timingSafeEqual).toHaveBeenCalledOnce();
    const [presentedDigest, configuredDigest] = vi.mocked(timingSafeEqual).mock.calls[0];
    expect(presentedDigest).toBeInstanceOf(Uint8Array);
    expect(configuredDigest).toBeInstanceOf(Uint8Array);
    expect(presentedDigest).toHaveLength(32);
    expect(configuredDigest).toHaveLength(32);
  });

  it("never returns or logs the raw token when authentication fails", () => {
    const rawToken = "raw-secret-token-that-must-not-leak";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = captureAuthError(`Bearer ${rawToken}`);
    expect(`${error.name}:${error.message}:${error.stack ?? ""}:${JSON.stringify(error)}`).not.toContain(
      rawToken,
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("fails closed when development authentication is not fully configured", () => {
    const error = captureAuthError("Bearer anything", {
      NODE_ENV: "development",
      HERMES_MCP_DEV_TOKEN: "configured-token",
    });
    expect(error).toMatchObject({ code: "DEV_AUTH_NOT_CONFIGURED", status: 500 });
  });

  it("rejects development-only authentication configuration in production", () => {
    const rawToken = "production-must-not-use-this-token";
    const error = captureAuthError("Bearer anything", {
      NODE_ENV: "production",
      HERMES_MCP_DEV_TOKEN: rawToken,
      HERMES_MCP_DEV_WORKSPACE_ID: "workspace_production",
    });

    expect(error).toMatchObject({ code: "DEV_AUTH_DISABLED_IN_PRODUCTION", status: 500 });
    expect(`${error.message}:${error.stack ?? ""}:${JSON.stringify(error)}`).not.toContain(rawToken);
  });
});

describe("Hermes MCP middleware boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lets the exact MCP endpoint reach its route-level bearer authentication", async () => {
    vi.stubEnv("BASIC_AUTH_USER", "");
    vi.stubEnv("BASIC_AUTH_PASSWORD", "");
    vi.stubEnv("AUTH_SECRET", "");

    const response = await middleware(new NextRequest("http://localhost/api/hermes-mcp"));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(["/api/private", "/api/hermes-mcp/other"])(
    "does not make unrelated API path %s open",
    async (pathname) => {
      vi.stubEnv("BASIC_AUTH_USER", "");
      vi.stubEnv("BASIC_AUTH_PASSWORD", "");
      vi.stubEnv("AUTH_SECRET", "");

      const response = await middleware(new NextRequest(`http://localhost${pathname}`));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "UNAUTHORIZED" },
      });
    },
  );
});
