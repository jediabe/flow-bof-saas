import { NextResponse, type NextRequest } from "next/server";

/**
 * Private-alpha HTTP Basic Auth gate.
 *
 * Activates when BOTH BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are set
 * in the runtime environment. Anything missing turns the gate off so
 * local `npm run dev` (no env vars) keeps working without prompting.
 *
 * Skipped paths:
 *   - /api/health      — must respond to uptime probes without a
 *                        password.
 *   - /_next/*         — Next's static asset / RSC chunks. Browser
 *                        fetches them automatically; basic auth would
 *                        force the prompt on every navigation.
 *   - /favicon.ico, /robots.txt, /uploads/* — static files; protected
 *                        only when they live behind a logged-in page,
 *                        which they don't on the alpha.
 *
 * The `matcher` further narrows what runs middleware; the explicit
 * checks inside the function are belt-and-suspenders for paths the
 * matcher can't easily express.
 *
 * Never logs the password — Authorization headers are read but never
 * echoed; failure responses return only the realm.
 */
export function middleware(req: NextRequest) {
  const expectedUser = process.env.BASIC_AUTH_USER || "";
  const expectedPass = process.env.BASIC_AUTH_PASSWORD || "";

  // Both env vars must be set; one without the other is a config
  // mistake we'd rather fail open on (better than locking the user
  // out of a half-configured deploy).
  if (!expectedUser || !expectedPass) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (
    pathname === "/api/health" ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/uploads/") ||
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt"
  ) {
    return NextResponse.next();
  }

  const header = req.headers.get("authorization") || "";
  if (header.toLowerCase().startsWith("basic ")) {
    try {
      // Edge runtime: atob is available; Buffer is not.
      const decoded = atob(header.slice(6).trim());
      const sep = decoded.indexOf(":");
      const user = sep === -1 ? decoded : decoded.slice(0, sep);
      const pass = sep === -1 ? "" : decoded.slice(sep + 1);
      if (
        timingSafeEq(user, expectedUser) &&
        timingSafeEq(pass, expectedPass)
      ) {
        return NextResponse.next();
      }
    } catch {
      // Fall through to 401.
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="flow-bof-saas (private alpha)"',
      "Content-Type": "text/plain; charset=utf-8",
      // Don't tempt browsers to cache a 401.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Constant-time string compare. The Edge runtime doesn't expose
 * Node's `crypto.timingSafeEqual`; this is the standard XOR loop.
 * Returns true iff `a` and `b` are byte-for-byte equal.
 */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Run a fake compare so attackers can't distinguish length
    // mismatch from value mismatch via timing.
    let mismatch = 1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      mismatch |= 1;
    }
    return mismatch === 0;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Run on every page + API request, except Next's static asset paths
 * and image-optimisation calls (Next handles those before we get a
 * chance to inspect them anyway).
 */
export const config = {
  matcher: [
    /*
     * Match all paths except:
     *  - /_next/static  (build artefacts)
     *  - /_next/image   (image optimiser)
     *  - /favicon.ico
     *  - /uploads/*     (Kalodata-served reference images;
     *                    the local runner pulls these without auth)
     */
    "/((?!_next/static|_next/image|favicon\\.ico|uploads/).*)",
  ],
};
