// A harness for API-seam tests that send a sequence of uploads and face- and
// pet-naming requests to one app, backed by its own faces.db in a fresh temporary directory.
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExifTool } from "exiftool-vendored";
import { expect } from "vitest";
import type { Analysis, Animal, Face, PersonSummary, PetRef, PetSummary } from "../../shared/analysis.ts";
import { createApp } from "../app.ts";
import type { FaceDetector } from "../faces/detector.ts";
import { openFaceStore } from "../faces/store.ts";
import { loadAnimalDetector, type AnimalDetector } from "../pets/detector.ts";

export const modelsDir = join(import.meta.dirname, "../../../models");
export const fixture = (name: string) => join(import.meta.dirname, "../../../fixtures", name);

/** D-FINE-S and the Avito model, loaded once for every harness. */
let sharedAnimalDetector: Promise<AnimalDetector> | undefined;

export type Api = Awaited<ReturnType<typeof openApi>>;

/**
 * One app with its own faces.db. Every request goes through `createApp`, as in
 * production. `upload` takes another face or animal detector to stand in for an
 * older or newer model (for example `{ ...faceDetector, modelVersion: "old" }`).
 */
export async function openApi({ exiftool, faceDetector }: { exiftool: ExifTool; faceDetector: FaceDetector }) {
  const dir = await mkdtemp(join(tmpdir(), "family-photos-api-"));
  const tempDir = join(dir, "uploads");
  await mkdir(tempDir);
  const dbPath = join(dir, "faces.db");
  const faceStore = openFaceStore(dbPath);
  // Every Photo is searched for cats and dogs too, as in production.
  const animalDetector = await (sharedAnimalDetector ??= loadAnimalDetector(modelsDir));
  const app = (detector: FaceDetector, animals = animalDetector) =>
    createApp({ exiftool, tempDir, faceDetector: detector, faceStore, animalDetector: animals, maxUploadBytes: 5 * 1024 * 1024 });

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
    async upload(
      fixtureName: string,
      { detector = faceDetector, animals = animalDetector }: { detector?: FaceDetector; animals?: AnimalDetector } = {},
    ) {
      const form = new FormData();
      form.append("photo", new File([await readFile(fixture(fixtureName))], fixtureName));
      return json<Analysis>(app(detector, animals).request("/api/analyze", { method: "POST", body: form }));
    },

    /** The real D-FINE-S and Avito models, for standing in for another version of them. */
    animalDetector,

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
    nameAnimal: (animalId: string, name: string) => json<PetRef>(call("PUT", `/api/animals/${animalId}/pet`, { name })),
    confirmPetSuggestion: (animalId: string, petId: string) =>
      json<PetRef>(call("POST", `/api/animals/${animalId}/suggestion/confirm`, { petId })),
    /** Returns the Animal as it now stands. */
    rejectPetSuggestion: (animalId: string, petId: string) =>
      json<Animal>(call("POST", `/api/animals/${animalId}/suggestion/reject`, { petId })),
    markNotAPet: async (animalId: string) =>
      expect((await call("POST", `/api/animals/${animalId}/not-a-pet`)).status).toBe(204),
    pets: async () => (await json<{ pets: PetSummary[] }>(call("GET", "/api/pets"))).pets,
    renamePet: (petId: string, name: string) => json<PetRef>(call("PATCH", `/api/pets/${petId}`, { name })),
    mergePets: async (petId: string, intoPetId: string) =>
      expect((await call("POST", `/api/pets/${petId}/merge`, { into: intoPetId })).status).toBe(204),
    deletePet: async (petId: string) => expect((await call("DELETE", `/api/pets/${petId}`)).status).toBe(204),
    deleteAllFaceAndPetData: async () => expect((await call("DELETE", "/api/face-and-pet-data")).status).toBe(204),

    /**
     * Every row of faces.db, read straight from the file. Only for checking what
     * ADR-0002 and ADR-0003 allow to be kept; behaviour is tested through the API.
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
