import { defineConfig } from "vitest/config";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        // Vite 5 can't resolve node:sqlite; redirect to a shim that uses
        // createRequire at runtime so Node handles it.
        find: /^node:sqlite$/,
        replacement: path.resolve(here, "tests/helpers/node-sqlite-shim.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    slowTestThreshold: 5_000,
    pool: "forks",
  },
});
