import { defineConfig } from "vitest/config";

// Minimal vitest config for the pure-code test suites under
// src/lib/**/__tests__/**. Kept intentionally small — the
// tests we run today are all pure TypeScript (no DOM, no DB,
// no network) so we don't need jsdom / setup files / coverage
// plumbing yet. Expand when Phase C+ adds media/QA/orchestrator
// tests that touch fs or HTTP.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
