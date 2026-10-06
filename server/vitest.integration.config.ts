import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/integration/**/*.test.ts"],
    setupFiles: ["test/setupEnv.ts"],
    // Integration tests share one Postgres database and reset it between
    // tests (see test/helpers/db.ts) - running files in parallel workers
    // would let two files truncate out from under each other.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
