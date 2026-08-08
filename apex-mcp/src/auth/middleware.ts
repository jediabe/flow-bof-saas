/**
 * Express authentication middleware.
 *
 * Two identities travel on every request:
 *   - your application, which is trusted (a signature or a shared secret), and
 *   - the end user it is acting for, expressed as a Google Flow account email.
 *
 * The email is the one that matters. It decides whose Google Flow credits get
 * spent, so it must come from something your backend signed, never from the
 * model and never from a client-supplied field the model can influence.
 *
 * Modes:
 *   jwt          Authorization: Bearer <HS256 JWT> with `sub` and `flow_email`.
 *   service-key  Authorization: Bearer <APEX_SERVICE_KEY>
 *                + X-Apex-User-Id and X-Apex-Flow-Email headers.
 *   none         Development only. Uses DEFAULT_FLOW_EMAIL.
 */

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.js";
import { safeEqual } from "./crypto.js";

export interface AuthenticatedRequest extends Request {
  apexUserId?: string;
  apexFlowEmail?: string;
  apexRequestId?: string;
}

const emailSchema = z.string().email();

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32002, message, data: { code } },
    id: null,
  });
}

function extractBearer(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim() ?? null;
}

export function checkOrigin(config: Config, req: Request, res: Response): boolean {
  const origin = req.header("origin");
  if (config.allowedOrigins && origin && !config.allowedOrigins.includes(origin)) {
    sendError(res, 403, "origin_not_allowed", `Origin '${origin}' is not allowed.`);
    return false;
  }
  return true;
}

export function createAuthMiddleware(config: Config) {
  return function authenticate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void {
    req.apexRequestId = req.header("x-request-id") ?? randomUUID();

    if (!checkOrigin(config, req, res)) return;

    if (config.AUTH_MODE === "none") {
      req.apexUserId = req.header("x-apex-user-id") ?? "local-dev";
      req.apexFlowEmail = config.DEFAULT_FLOW_EMAIL!;
      next();
      return;
    }

    const token = extractBearer(req);
    if (!token) {
      sendError(
        res,
        401,
        "missing_authorization",
        "Missing 'Authorization: Bearer <token>' header.",
      );
      return;
    }

    let userId: string;
    let flowEmail: string;

    if (config.AUTH_MODE === "service-key") {
      if (!safeEqual(token, config.APEX_SERVICE_KEY!)) {
        sendError(res, 401, "invalid_service_key", "Invalid service key.");
        return;
      }
      const headerUser = req.header("x-apex-user-id");
      const headerEmail = req.header("x-apex-flow-email");
      if (!headerUser) {
        sendError(
          res,
          400,
          "missing_user_id",
          "AUTH_MODE=service-key requires an 'X-Apex-User-Id' header.",
        );
        return;
      }
      if (!headerEmail) {
        sendError(
          res,
          400,
          "missing_flow_email",
          "AUTH_MODE=service-key requires an 'X-Apex-Flow-Email' header naming the " +
            "Google Flow account this request should run against.",
        );
        return;
      }
      userId = headerUser;
      flowEmail = headerEmail;
    } else {
      // AUTH_MODE === "jwt"
      let claims: jwt.JwtPayload;
      try {
        claims = jwt.verify(token, config.APEX_JWT_SECRET!, {
          algorithms: ["HS256"],
          ...(config.APEX_JWT_ISSUER ? { issuer: config.APEX_JWT_ISSUER } : {}),
          ...(config.APEX_JWT_AUDIENCE ? { audience: config.APEX_JWT_AUDIENCE } : {}),
        }) as jwt.JwtPayload;
      } catch (err) {
        const reason =
          err instanceof jwt.TokenExpiredError
            ? "JWT has expired."
            : err instanceof jwt.JsonWebTokenError
              ? "JWT signature or claims are invalid."
              : "JWT could not be verified.";
        sendError(res, 401, "invalid_jwt", reason);
        return;
      }

      if (!claims.sub) {
        sendError(res, 401, "missing_sub", "JWT is missing the required 'sub' claim.");
        return;
      }
      const claimEmail = claims["flow_email"];
      if (typeof claimEmail !== "string" || !claimEmail) {
        sendError(
          res,
          401,
          "missing_flow_email",
          "JWT is missing the required 'flow_email' claim. Your backend must put the " +
            "user's connected Google Flow account email in the signed payload — this server " +
            "will not accept it from anywhere else.",
        );
        return;
      }
      userId = String(claims.sub);
      flowEmail = claimEmail;
    }

    if (!emailSchema.safeParse(flowEmail).success) {
      sendError(
        res,
        400,
        "invalid_flow_email",
        `'${flowEmail}' is not a valid email address.`,
      );
      return;
    }

    req.apexUserId = userId;
    req.apexFlowEmail = flowEmail.toLowerCase();
    next();
  };
}

/**
 * Guards the /admin routes, which handle raw Google session cookies and can
 * connect or disconnect accounts. Always a shared secret, never a user token.
 */
export function createAdminMiddleware(config: Config) {
  return function requireAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!checkOrigin(config, req, res)) return;

    if (config.AUTH_MODE === "none") {
      next();
      return;
    }

    const provided = extractBearer(req) ?? "";
    if (!provided || !safeEqual(provided, config.APEX_SERVICE_KEY!)) {
      res.status(401).json({
        error: "Invalid or missing service key.",
        hint: "Send 'Authorization: Bearer <APEX_SERVICE_KEY>'. This is not a user JWT.",
      });
      return;
    }
    next();
  };
}
