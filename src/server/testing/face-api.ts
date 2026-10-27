// A harness for API-seam tests that send a sequence of uploads and face-naming
// requests to one app, backed by its own faces.db in a fresh temporary directory.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExifTool } from "exiftool-vendored";
import { expect } from "vitest";
import type { Analysis, Face, PersonSummary } from "../../shared/analysis.ts";
import { createApp } from "../app.ts";
import type { FaceDetector } from "../faces/detector.ts";
import { openFaceStore } from "../faces/store.ts";
import { loadAnimalDetector, type AnimalDetector } from "../pets/detector.ts";

export const modelsDir = join(import.meta.dirname, "../../../models");
export const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures", name);

/** D-FINE-S, loaded once for every harness. */
let sharedAnimalDetector: Promise<AnimalDetector> | undefined;

export type FaceApi = Awaited<ReturnType<typeof openFaceApi>>;

/**
 * One app with its own faces.db. Every request goes through `createApp`, as in
 * production. `upload` takes another detector to stand in for an older or newer
 * model (for example `{ ...faceDetector, modelVersion: "old" }`).
 */
export async function openFaceApi({ exiftool, faceDetector }: { exiftool: ExifTool; faceDetector: FaceDetector }) {
  const dir = await mkdtemp(join(tmpdir(), "family-photos-faces-"));
  const tempDir = join(dir, "uploads");
  await mkdir(tempDir);
  const dbPath = join(dir, "faces.db");
  const faceStore = openFaceStore(dbPath);
  // Every Photo is searched for cats and dogs too, as in production.
  const animalDetector = await (sharedAnimalDetector ??= loadAnimalDetector(modelsDir));
  const app = (detector: FaceDetector) =>
    createApp({ exiftool, tempDir, faceDetector: detector, faceStore, animalDetector, maxUploadBytes: 5 * 1024 * 1024 });

  async function call(method: string, path: string, body?: unknown, detector = faceDetector) {
    return app(detector).request(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const response = await res;
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  return {
    /** Where uploaded Photos sit while they are read; it must be empty after every response. */
    tempDir,
    dbPath,
    call,

    /** Uploads a fixture Photo and returns its Analysis. */
    async upload(fixtureName: string, { detector = faceDetector }: { detector?: FaceDetector } = {}) {
      const form = new FormData();
      form.append("photo", new File([await readFile(fixture(fixtureName))], fixtureName));
      return json<Analysis>(app(detector).request("/api/analyze", { method: "POST", body: form }));
    },

    nameFace: (faceId: string, name: string) =>
      json<{ id: string; name: string }>(call("PUT", `/api/faces/${faceId}/person`, { name })),
    confirmSuggestion: (faceId: string, personId: string) =>
      json<{ id: string; name: string }>(call("POST", `/api/faces/${faceId}/suggestion/confirm`, { personId })),
    /** Returns the Face as it now stands. */
    rejectSuggestion: (faceId: string, personId: string) =>
      json<Face>(call("POST", `/api/faces/${faceId}/suggestion/reject`, { personId })),
    markNotAFace: async (faceId: string) => expect((await call("POST", `/api/faces/${faceId}/not-a-face`)).status).toBe(204),
    people: async () => (await json<{ people: PersonSummary[] }>(call("GET", "/api/people"))).people,
    renamePerson: (personId: string, name: string) =>
      json<{ id: string; name: string }>(call("PATCH", `/api/people/${personId}`, { name })),
    mergePeople: async (personId: string, intoPersonId: string) =>
      expect((await call("POST", `/api/people/${personId}/merge`, { into: intoPersonId })).status).toBe(204),
    deletePerson: async (personId: string) => expect((await call("DELETE", `/api/people/${personId}`)).status).toBe(204),
    deleteAllFaceData: async () => expect((await call("DELETE", "/api/face-data")).status).toBe(204),

    /**
     * Every row of faces.db, read straight from the file. Only for checking what
     * ADR-0002 allows to be kept; behaviour is tested through the API.
     */
    storedRows() {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[];
        return Object.fromEntries(
          tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]]),
        );
      } finally {
        db.close();
      }
    },

    async close() {
      faceStore.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
