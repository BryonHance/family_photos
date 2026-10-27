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
          // The first openApi in each file loads and hashes the 1.2 GB Avito model,
          // which can take longer than the default 10 s on a busy machine.
          hookTimeout: 60_000,
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
