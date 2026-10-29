import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "api",
          environment: "node",
          include: ["src/server/**/*.test.ts"],
          testTimeout: 20_000,
          // Checks every model's SHA-256 once, so test files load them unhashed.
          globalSetup: ["src/server/testing/global-setup.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "app",
          environment: "jsdom",
          include: ["src/web/**/*.test.tsx"],
          setupFiles: ["src/web/test-setup.ts"],
        },
      },
    ],
  },
});
