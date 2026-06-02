import type { NextConfig } from "next";

const config: NextConfig = {
  // Skeleton-only — no exotic features. Strict mode in React surfaces
  // mistakes early.
  reactStrictMode: true,
  // `output: "standalone"` produces .next/standalone/ — a self-contained
  // Node bundle the production Docker image copies out and runs with
  // `node server.js` directly. Local `next dev` and `next start` are
  // unaffected; this flag only changes what `next build` writes to disk.
  output: "standalone",
  // Default browser-side calls to the local agent need to know its
  // base URL. We expose it via NEXT_PUBLIC_AGENT_BASE_URL (see
  // .env.example) so client components can read it. The server can
  // also call the agent — same env var, no NEXT_PUBLIC_ prefix needed
  // when called from a server action.
};

export default config;
