/**
 * Environment configuration, validated once at startup so misconfiguration
 * fails loudly instead of surfacing as a confusing 500 on the first tool call.
 *
 * There is exactly one useapi.net token: yours. Every end user's generations run
 * against their own connected Google Flow account, identified per request by an
 * email address that arrives inside a signed token. Nothing secret is stored
 * per user, so this server has no database.
 */

import { z } from "zod";

export type AuthMode = "jwt" | "service-key" | "none";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),

  /** "http" (remote, default) or "stdio" (local dev / Claude Desktop). */
  TRANSPORT: z.enum(["http", "stdio"]).default("http"),

  /**
   * Your useapi.net API token, including the `user:` prefix. One token for the
   * whole deployment — it owns the subscription that every connected Google
   * Flow account is attached to.
   */
  USEAPI_TOKEN: z.string().optional(),

  /**
   * Override the upstream base URL. Exists for testing against a mock; leave
   * unset in production.
   */
  USEAPI_BASE_URL: z.string().url().optional(),

  /**
   * How your web application authenticates to this server and says which end
   * user it is acting for.
   *  - jwt:         Authorization: Bearer <HS256 JWT> with `sub` and `flow_email` claims.
   *  - service-key: Authorization: Bearer <APEX_SERVICE_KEY>
   *                 + X-Apex-User-Id and X-Apex-Flow-Email headers.
   *  - none:        no auth, uses DEFAULT_FLOW_EMAIL. Local development only.
   */
  AUTH_MODE: z.enum(["jwt", "service-key", "none"]).default("jwt"),
  APEX_JWT_SECRET: z.string().min(32).optional(),
  APEX_JWT_ISSUER: z.string().optional(),
  APEX_JWT_AUDIENCE: z.string().optional(),

  /**
   * Shared secret guarding the /admin routes (account connect, disconnect,
   * health). Required in every auth mode except `none`, because those routes
   * handle Google session cookies.
   */
  APEX_SERVICE_KEY: z.string().min(16).optional(),

  /** Google Flow account used by stdio mode and AUTH_MODE=none. */
  DEFAULT_FLOW_EMAIL: z.string().email().optional(),

  /**
   * Comma-separated Origin allowlist (DNS-rebinding protection). Leave unset
   * when the client is a server-side process that sends no Origin header.
   */
  ALLOWED_ORIGINS: z.string().optional(),

  /** Public base URL of this server, for building replyUrl webhooks. */
  PUBLIC_URL: z.string().url().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof EnvSchema> & {
  useapiToken: string;
  allowedOrigins: string[] | null;
};

function fail(message: string): never {
  console.error(`[config] ${message}`);
  process.exit(1);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    fail(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;

  if (!cfg.USEAPI_TOKEN) {
    fail(
      "USEAPI_TOKEN is required. Get it from your useapi.net account; it looks like " +
        "'user:1234-abcdef…' and the 'user:' prefix is part of the token.",
    );
  }
  if (!cfg.USEAPI_TOKEN.startsWith("user:")) {
    fail(
      "USEAPI_TOKEN must include its 'user:' prefix. Copy the token verbatim from useapi.net.",
    );
  }

  if (cfg.TRANSPORT === "http") {
    if (cfg.AUTH_MODE === "jwt" && !cfg.APEX_JWT_SECRET) {
      fail("AUTH_MODE=jwt requires APEX_JWT_SECRET (at least 32 characters).");
    }
    if (cfg.AUTH_MODE === "service-key" && !cfg.APEX_SERVICE_KEY) {
      fail("AUTH_MODE=service-key requires APEX_SERVICE_KEY.");
    }
    if (cfg.AUTH_MODE === "none") {
      if (env.NODE_ENV === "production") {
        fail("AUTH_MODE=none is not permitted when NODE_ENV=production.");
      }
      if (!cfg.DEFAULT_FLOW_EMAIL) {
        fail("AUTH_MODE=none requires DEFAULT_FLOW_EMAIL to pick an account to act as.");
      }
    }
    if (cfg.AUTH_MODE !== "none" && !cfg.APEX_SERVICE_KEY) {
      fail(
        "APEX_SERVICE_KEY is required to guard the /admin account routes, which handle " +
          "Google session cookies. Generate one with: openssl rand -base64 32",
      );
    }
  }

  if (cfg.TRANSPORT === "stdio" && !cfg.DEFAULT_FLOW_EMAIL) {
    fail("stdio mode requires DEFAULT_FLOW_EMAIL — it serves a single account.");
  }

  return {
    ...cfg,
    useapiToken: cfg.USEAPI_TOKEN,
    allowedOrigins: cfg.ALLOWED_ORIGINS
      ? cfg.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : null,
  };
}
