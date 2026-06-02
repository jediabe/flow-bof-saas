import "./globals.css";
import type { Metadata } from "next";
import Nav from "@/components/Nav";
import { getCurrentUser } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Flow BOF SaaS",
  description:
    "Hosted dashboard for Flow BOF Automation. Brain to the local agent's hands.",
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
    <html lang="en">
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
