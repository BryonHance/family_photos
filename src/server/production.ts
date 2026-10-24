import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, type AppConfig } from "./app.ts";

export type ProductionConfig = AppConfig & {
  /** The built UI (`dist/web`), served from the same origin as the analyze API so no CORS is needed. */
  uiDir: string;
};

export function createProductionApp({ uiDir, ...config }: ProductionConfig) {
  const app = createApp(config);
  app.use("/*", serveStatic({ root: uiDir }));
  return app;
}
