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
