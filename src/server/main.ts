import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { exiftool } from "exiftool-vendored";
import { createApp } from "./app.ts";
import { FaceModelError, loadFaceDetector } from "./faces/detector.ts";
import { openFaceStore } from "./faces/store.ts";
import { loadAnimalDetector, PetModelError } from "./pets/detector.ts";
import { createProductionApp } from "./production.ts";

const port = Number(process.env.PORT ?? 3000);
// The face and pet models, fetched by `pixi run models` in development and built into the Docker image.
const modelsDir = process.env.MODELS_DIR ?? join(import.meta.dirname, "../../models");

// Checked before anything else starts, so a missing or corrupt model stops the server at once.
let faceDetector;
let animalDetector;
try {
  faceDetector = await loadFaceDetector(modelsDir);
  animalDetector = await loadAnimalDetector(modelsDir);
} catch (error) {
  if (!(error instanceof FaceModelError || error instanceof PetModelError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// Face and pet data only (ADR-0002, ADR-0003): in Docker a named volume, kept out of off-server backups.
const facesDb = process.env.FACES_DB ?? join(import.meta.dirname, "../../data/faces.db");
await mkdir(dirname(facesDb), { recursive: true });
const faceStore = openFaceStore(facesDb);

const tempDir = await mkdtemp(join(tmpdir(), "family-photos-"));
// Set in the Docker image. In development Vite serves the UI and proxies /api here.
const uiDir = process.env.UI_DIR;

const maxUploadBytes = 200 * 1024 * 1024; // 200 MB

const app = uiDir
  ? createProductionApp({ exiftool, tempDir, faceDetector, faceStore, animalDetector, maxUploadBytes, uiDir })
  : createApp({ exiftool, tempDir, faceDetector, faceStore, animalDetector, maxUploadBytes });

serve({ fetch: app.fetch, port }, () => {
  console.log(`${uiDir ? "Viewer" : "Analyze API"} listening on http://localhost:${port}`);
});

process.on("SIGINT", () => void exiftool.end().then(() => process.exit(0)));
process.on("SIGTERM", () => void exiftool.end().then(() => process.exit(0)));
