import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Unit tests only. Without this a bare `npx vitest run` also picked up test/integration/**, which
    // then ran against the dev database from .env and truncated it.
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage/unit",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      // Unit tests only exercise pure logic (src/lib/**) - route handlers
      // are covered by the integration suite instead, which has its own
      // separate coverage report (coverage/integration).
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/app.ts"],
    },
  },
});
