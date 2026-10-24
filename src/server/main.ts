import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { exiftool } from "exiftool-vendored";
import { createApp } from "./app.ts";
import { createProductionApp } from "./production.ts";

const port = Number(process.env.PORT ?? 3000);
const tempDir = await mkdtemp(join(tmpdir(), "family-photos-"));
// Set in the Docker image. In development Vite serves the UI and proxies /api here.
const uiDir = process.env.UI_DIR;

const maxUploadBytes = 200 * 1024 * 1024; // 200 MB

const app = uiDir
  ? createProductionApp({ exiftool, tempDir, maxUploadBytes, uiDir })
  : createApp({ exiftool, tempDir, maxUploadBytes });

serve({ fetch: app.fetch, port }, () => {
  console.log(`${uiDir ? "Viewer" : "Analyze API"} listening on http://localhost:${port}`);
});

process.on("SIGINT", () => void exiftool.end().then(() => process.exit(0)));
process.on("SIGTERM", () => void exiftool.end().then(() => process.exit(0)));
