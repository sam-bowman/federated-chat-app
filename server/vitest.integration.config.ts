import { defineConfig } from "vitest/config";

export default defineConfig({
  // (There used to be a `poolOptions: { forks: { singleFork: true } }` here, to stop a worker crashing now and then on Windows. Vitest 4 removed
  // that option, so it had been doing nothing for a long time, and the crash was never in the pool anyway: it was Node 24.15.0 on Windows
  // (see scripts/check-node.mjs and docs/testing.md). Do not add a pool setting to fix it.)
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
