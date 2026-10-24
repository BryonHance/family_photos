import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { exiftool } from "exiftool-vendored";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const tempDir = await mkdtemp(join(tmpdir(), "family-photos-"));

serve({ fetch: createApp({ exiftool, tempDir }).fetch, port }, () => {
  console.log(`Analyze API listening on http://localhost:${port}`);
});

process.on("SIGINT", () => void exiftool.end().then(() => process.exit(0)));
process.on("SIGTERM", () => void exiftool.end().then(() => process.exit(0)));
