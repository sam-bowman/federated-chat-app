import { defineConfig } from "vitest/config";

export default defineConfig({
  // Run every file in a single persistent forked process rather than
  // spawning a new one per file - observed as more reliable with coverage
  // instrumentation enabled (a fresh fork per file occasionally crashed
  // outright with no JS-level error, independent of which file it was).
  // Top-level as of Vitest 4+ (used to live under `test`).
  poolOptions: {
    forks: {
      singleFork: true,
    },
  },
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
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/integration",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      // A regression floor, not a target - set a few points below the
      // measured baseline (~49/35/53/55% at the time this was added) so CI
      // fails on a real drop (e.g. a big new route file shipped with no
      // tests) without being so tight that normal fluctuation trips it.
      // Raise these over time as coverage genuinely improves.
      thresholds: {
        statements: 45,
        branches: 30,
        functions: 45,
        lines: 50,
      },
    },
  },
});
