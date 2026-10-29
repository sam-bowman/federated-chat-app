import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    // The unit tests are in src/. scripts/ has Node's own test runner's tests (`node --test`, run by the lint job in CI), which Vitest
    // cannot load.
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 10000,
    // By default Vitest swaps every .css import for an empty module, raw ones included; a test
    // that reads the stylesheet as text (lib/contrast.test.ts) needs the real content.
    css: { include: [/(index|fonts)\.css/] },
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx"],
    },
  },
});
