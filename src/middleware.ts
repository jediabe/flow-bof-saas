import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * Two-layer gate.
 *
 * 1. **Optional HTTP Basic Auth.** Activated when BOTH
 *    BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are set. Acts as a
 *    private-alpha outer wrapper around the whole app. Unset on a
 *    public deploy and rely on app-level signup/login instead.
 *
 * 2. **App-level signup/login.** Always on. Unauthenticated
 *    requests to a protected page get redirected to /login;
 *    unauthenticated API calls get 401.
 *
 * Both layers share the same skip list — paths that must respond
 * without either credential:
 *
 *   - /api/health           — uptime probes.
 *   - /api/runner/*         — connected runner uses its own Bearer
 *                             token (see src/lib/runner-auth.ts).
 *   - /_next/*              — Next's static/image bundles.
 *   - /uploads/*            — Kalodata reference images the runner
 *                             pulls without auth (gitignored).
 *   - /favicon.ico, /robots.txt
 *
 * The signed-cookie verification uses jose directly (no Prisma) so
 * middleware stays Edge-compatible. We only check the SIGNATURE here;
 * loading the User row + creating workspaces happens in
 * lib/workspace.ts on the actual page render.
 */

// Skip *everything* (basic auth + login redirect).
function isAlwaysOpen(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname.startsWith("/api/runner/") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/uploads/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  );
}

// Skip ONLY the login redirect (Basic Auth still applies if enabled).
function isPublicAppPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/signup"
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isAlwaysOpen(pathname)) {
    return NextResponse.next();
  }

  // ---------- Layer 1: optional Basic Auth ----------------------------
  const basicUser = process.env.BASIC_AUTH_USER || "";
  const basicPass = process.env.BASIC_AUTH_PASSWORD || "";
  if (basicUser && basicPass) {
    const header = req.headers.get("authorization") || "";
    let basicOk = false;
    if (header.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = atob(header.slice(6).trim());
        const sep = decoded.indexOf(":");
        const u = sep === -1 ? decoded : decoded.slice(0, sep);
        const p = sep === -1 ? "" : decoded.slice(sep + 1);
        basicOk = timingSafeEq(u, basicUser) && timingSafeEq(p, basicPass);
      } catch {
        /* fall through */
      }
    }
    if (!basicOk) {
      return new NextResponse("Authentication required.", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="flow-bof-saas (private alpha)"',
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  // ---------- Layer 2: app login -------------------------------------
  if (isPublicAppPath(pathname)) {
    return NextResponse.next();
  }

  const cookieValue = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const claims = cookieValue ? await verifyEdge(cookieValue) : null;
  if (claims) {
    return NextResponse.next();
  }

  // No session → redirect HTML/page requests to /login. API requests
  // get a clean 401 instead of an HTML page.
  if (pathname.startsWith("/api/")) {
    return new NextResponse(
      JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Sign in required." } }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  // Preserve where they were trying to go so we can bounce them back
  // after login. (Not wiring redirect-after-login yet, but the
  // breadcrumb is here when we do.)
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

/** jose verify in middleware. Edge-compatible — no Buffer/Node-only APIs. */
async function verifyEdge(token: string): Promise<unknown | null> {
  const secret = process.env.AUTH_SECRET || "";
  if (secret.length < 32) return null; // mirrors lib/auth.ts guard
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload.sub ? payload : null;
  } catch {
    return null;
  }
}

/** Constant-time compare for the optional basic-auth user/pass. */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let m = 1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) m |= 1;
    return m === 0;
  }
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

export const config = {
  matcher: [
    /*
     * Match every path except:
     *  - /_next/static  (build artefacts)
     *  - /_next/image   (image optimiser)
     *  - /favicon.ico
     *  - /uploads/*     (reference images served to the local runner)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|uploads/).*)",
  ],
};
