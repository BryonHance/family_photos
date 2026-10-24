import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AnalyzeError } from "../shared/analysis.ts";
import { analyzePhoto, UnsupportedFileError, type AnalyzerConfig } from "./analyzer.ts";

export type AppConfig = AnalyzerConfig & {
  /** The largest Photo accepted, in bytes. Production uses 200 MB. */
  maxUploadBytes: number;
};

/** Room for the multipart envelope around the Photo, so the body limit only stops clearly oversized requests early. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function createApp(config: AppConfig) {
  const app = new Hono();

  const reject = (c: Context, status: 400 | 413 | 415, kind: string, message: string) =>
    c.json<AnalyzeError>({ error: { kind, message } }, status);

  const tooLarge = (c: Context) =>
    reject(
      c,
      413,
      "too-large",
      `This file is too large. Photos must be ${formatBytes(config.maxUploadBytes)} or smaller.`,
    );

  app.post(
    "/api/analyze",
    bodyLimit({ maxSize: config.maxUploadBytes + MULTIPART_OVERHEAD_BYTES, onError: tooLarge }),
    async (c) => {
      const body = await c.req.parseBody();
      const photo = body["photo"];
      if (!(photo instanceof File)) {
        return reject(c, 400, "no-photo", "No Photo was sent. Choose a Photo to analyze.");
      }
      if (photo.size > config.maxUploadBytes) return tooLarge(c);

      const bytes = new Uint8Array(await photo.arrayBuffer());
      try {
        return c.json(await analyzePhoto(config, { bytes, name: photo.name }));
      } catch (error) {
        if (!(error instanceof UnsupportedFileError)) throw error;
        return reject(
          c,
          415,
          "unsupported-file",
          `This file is not a supported Photo (${error.mimeType}). Open a JPEG, PNG, WebP, HEIC, TIFF or RAW Photo.`,
        );
      }
    },
  );

  return app;
}

function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes >= mb ? `${Math.round(bytes / mb)} MB` : `${bytes} bytes`;
}
