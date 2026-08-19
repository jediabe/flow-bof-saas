import { createHash, timingSafeEqual } from "node:crypto";
import type { ServiceActorContext } from "@/lib/content-runs/types";

const DEV_ACTOR_ID = "hermes-mcp-dev";

export interface HermesMcpAuthEnvironment {
  readonly NODE_ENV?: string;
  readonly HERMES_MCP_DEV_TOKEN?: string;
  readonly HERMES_MCP_DEV_WORKSPACE_ID?: string;
}

export type HermesMcpAuthErrorCode =
  | "UNAUTHORIZED"
  | "DEV_AUTH_NOT_CONFIGURED"
  | "DEV_AUTH_DISABLED_IN_PRODUCTION";

export class HermesMcpAuthError extends Error {
  readonly status: 401 | 500;

  constructor(
    readonly code: HermesMcpAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HermesMcpAuthError";
    this.status = code === "UNAUTHORIZED" ? 401 : 500;
  }
}

export function resolveHermesMcpAuth(
  authorizationHeader: string | null | undefined,
  environment: HermesMcpAuthEnvironment = process.env,
): ServiceActorContext {
  const token = environment.HERMES_MCP_DEV_TOKEN;
  const workspaceId = environment.HERMES_MCP_DEV_WORKSPACE_ID;

  if (environment.NODE_ENV === "production") {
    throw new HermesMcpAuthError(
      "DEV_AUTH_DISABLED_IN_PRODUCTION",
      "Development MCP authentication is disabled in production.",
    );
  }

  if (!token || !workspaceId) {
    throw new HermesMcpAuthError(
      "DEV_AUTH_NOT_CONFIGURED",
      "Development MCP authentication is not configured.",
    );
  }

  const presentedToken = parseBearerToken(authorizationHeader);
  if (!presentedToken || !constantTimeDigestEqual(presentedToken, token)) {
    throw new HermesMcpAuthError("UNAUTHORIZED", "Invalid bearer credential.");
  }

  return {
    workspaceId,
    actorType: "service",
    actorId: DEV_ACTOR_ID,
  };
}

function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

function constantTimeDigestEqual(presentedToken: string, configuredToken: string): boolean {
  const presentedDigest = createHash("sha256").update(presentedToken, "utf8").digest();
  const configuredDigest = createHash("sha256").update(configuredToken, "utf8").digest();
  return timingSafeEqual(presentedDigest, configuredDigest);
}
