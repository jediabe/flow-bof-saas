import "./globals.css";
import type { Metadata } from "next";
import { Inter, Kanit } from "next/font/google";
import Nav from "@/components/Nav";
import { getCurrentUser } from "@/lib/workspace";

/**
 * Body font — Inter. Self-hosted via next/font so no external
 * request at runtime + no layout shift as the font loads.
 * Exposed as CSS var --font-inter (consumed by
 * tailwind.config → fontFamily.sans).
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/**
 * Display font — Kanit bold italic. The closest Google Fonts
 * match to the APEX wordmark's bold-italic-condensed impact
 * style. Used for hero headlines + the wordmark itself. Loaded
 * only in the weights we actually use (400 body + 700 display)
 * to keep the payload small.
 *
 * Exposed as --font-kanit; tailwind.config maps it to
 * fontFamily.display, and .h-display / .font-display in
 * globals.css consume it.
 */
const kanit = Kanit({
  subsets: ["latin"],
  weight: ["500", "700"],
  style: ["normal", "italic"],
  variable: "--font-kanit",
  display: "swap",
});

export const metadata: Metadata = {
  title: "APEX — TikTok Shop hub",
  description:
    "APEX Initiative — TikTok Shop analytics, hook & prompt generation, and mobile posting for UK BOF creators.",
};

// Disable static rendering so every visit re-checks the session
// cookie. Without this Next would aggressively cache the root
// layout's "is the user logged in" decision and the rail would
// appear stuck on the wrong state after login/logout.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Same `getCurrentUser({ optional: true })` Nav uses, but reading
  // it here lets us also collapse the main content's left margin
  // when there's no session — the /login form ends up centred on
  // the whole viewport instead of pushed 220px right.
  const user = await getCurrentUser({ optional: true });
  const authed = !!user;

  return (
    <html
      lang="en"
      className={`${inter.variable} ${kanit.variable}`}
    >
      <body>
        <Nav />
        <main
          className={`${authed ? "ml-[220px]" : ""} min-h-screen`}
        >
          <div
            className={
              authed
                ? "max-w-[1200px] mx-auto px-8 py-8"
                : "min-h-screen flex items-center justify-center px-6 py-12"
            }
          >
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}
