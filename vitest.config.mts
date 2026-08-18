import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Minimal vitest config for the pure-code test suites under
// src/lib/**/__tests__/**. Node env — no DOM, no jsdom.
//
// Path alias: mirror tsconfig.json's "@/*" → "./src/*" so tests
// resolve the same imports as production code without changing
// module specifiers.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(here, "src"),
    },
  },
});
