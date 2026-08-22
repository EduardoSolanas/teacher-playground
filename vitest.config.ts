import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Each worker gets its own in-memory database. Sharing the real
    // .data/whiteboard.db across parallel workers caused intermittent
    // "disk I/O error" failures and polluted the developer's database.
    env: {
      WHITEBOARD_DB_PATH: ":memory:",
    },
    // scripts/ is included so build-time transforms are testable: the
    // Excalidraw font patch decides whether a whiteboard fetches its fonts
    // from our origin or from a third-party CDN, which is too consequential
    // to live as an untested regex inside a build script.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      ".next",
      "tests/e2e",
      "**/*.workers.test.ts",
    ],
  },
});
