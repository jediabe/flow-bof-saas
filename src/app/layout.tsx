import "./globals.css";
import type { Metadata } from "next";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Flow BOF SaaS",
  description:
    "Hosted dashboard for Flow BOF Automation. Brain to the local agent's hands.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main className="ml-[220px] min-h-screen">
          <div className="max-w-[1200px] mx-auto px-8 py-8">{children}</div>
        </main>
      </body>
    </html>
  );
}
