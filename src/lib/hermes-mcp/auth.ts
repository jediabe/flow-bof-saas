import { createHash, timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/auth";
import type { ServiceActorContext } from "@/lib/content-runs/types";
import { db } from "@/lib/db";

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

export interface AuthenticateHermesMcpDependencies {
  findWorkspaceByApiToken?: (token: string) => Promise<{ id: string } | null>;
  verifySessionToken?: typeof verifySession;
  findWorkspaceByOwnerId?: (ownerId: string) => Promise<{ id: string } | null>;
  environment?: HermesMcpAuthEnvironment;
}

function cookieValue(header: string | null, name: string): string {
  if (!header) return "";
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  }
  return "";
}

export async function authenticateHermesMcpRequest(
  request: Request,
  dependencies: AuthenticateHermesMcpDependencies = {},
): Promise<ServiceActorContext> {
  const environment = dependencies.environment ?? process.env;
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const token = parseBearerToken(authorization);
    if (!token) throw new HermesMcpAuthError("UNAUTHORIZED", "Invalid bearer credential.");

    if (
      environment.NODE_ENV !== "production" &&
      environment.HERMES_MCP_DEV_TOKEN &&
      environment.HERMES_MCP_DEV_WORKSPACE_ID &&
      constantTimeDigestEqual(token, environment.HERMES_MCP_DEV_TOKEN)
    ) {
      return {
        workspaceId: environment.HERMES_MCP_DEV_WORKSPACE_ID,
        actorType: "service",
        actorId: DEV_ACTOR_ID,
      };
    }

    const findWorkspace = dependencies.findWorkspaceByApiToken ?? (async (apiToken: string) =>
      db.workspace.findUnique({ where: { apiToken }, select: { id: true } }));
    const workspace = await findWorkspace(token);
    if (!workspace) throw new HermesMcpAuthError("UNAUTHORIZED", "Invalid bearer credential.");
    return {
      workspaceId: workspace.id,
      actorType: "service",
      actorId: "hermes-mcp-bearer",
    };
  }

  const sessionToken = cookieValue(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (sessionToken) {
    const claims = await (dependencies.verifySessionToken ?? verifySession)(sessionToken);
    if (claims) {
      const findWorkspace = dependencies.findWorkspaceByOwnerId ?? (async (ownerId: string) =>
        db.workspace.findFirst({
          where: { ownerId },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        }));
      const workspace = await findWorkspace(claims.sub);
      if (workspace) {
        return {
          workspaceId: workspace.id,
          actorType: "service",
          actorId: claims.sub,
        };
      }
    }
  }

  throw new HermesMcpAuthError("UNAUTHORIZED", "Authentication required.");
}
