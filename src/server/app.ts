import { Hono } from "hono";
import type { AnalyzeError } from "../shared/analysis.ts";
import { analyzePhoto, type AnalyzerConfig } from "./analyzer.ts";

export type AppConfig = AnalyzerConfig;

export function createApp(config: AppConfig) {
  const app = new Hono();

  app.post("/api/analyze", async (c) => {
    const body = await c.req.parseBody();
    const photo = body["photo"];
    if (!(photo instanceof File)) {
      const error: AnalyzeError = { error: { kind: "no-photo", message: "No Photo was sent." } };
      return c.json(error, 400);
    }

    const bytes = new Uint8Array(await photo.arrayBuffer());
    const lastModified = typeof body["lastModified"] === "string" ? Number(body["lastModified"]) : NaN;
    return c.json(
      await analyzePhoto(config, {
        bytes,
        name: photo.name,
        lastModified: Number.isFinite(lastModified) ? lastModified : undefined,
      }),
    );
  });

  return app;
}
