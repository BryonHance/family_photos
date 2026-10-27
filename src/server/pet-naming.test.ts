import { readdir, readFile } from "node:fs/promises";
import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import type { AnimalDetector } from "./pets/detector.ts";
import { modelsDir, openApi, type Api } from "./testing/api.ts";

// These tests run the real buffalo_sc, D-FINE-S and Avito models: fetch them with `pixi run models`.
// cat-and-dog.jpg shows two Animals, left to right: a cat and a dog. cat.jpg shows the same cat alone.
// person-and-dog.jpg shows one Face and one Animal.

let exiftool: ExifTool;
let faceDetector: FaceDetector;
let api: Api;

beforeAll(async () => {
  exiftool = new ExifTool();
  faceDetector = await loadFaceDetector(modelsDir);
});

afterAll(async () => {
  await exiftool.end();
});

beforeEach(async () => {
  api = await openApi({ exiftool, faceDetector });
});

afterEach(async () => {
  await api.close();
});

describe("naming an Animal", () => {
  it("creates a Pet, and naming another Animal with the same name reuses it", async () => {
    const [cat, dog] = (await api.upload("cat-and-dog.jpg")).animals;

    const tom = await api.nameAnimal(cat!.id, "Tom");
    const again = await api.nameAnimal(dog!.id, "  tom ");

    expect(tom.name).toBe("Tom");
    expect(again).toEqual(tom);
    expect(await api.pets()).toEqual([{ id: tom.id, name: "Tom", animalCount: 2 }]);
  });
});

describe("Pets", () => {
  /** Names cat-and-dog.jpg's cat and dog, and returns their Pets. */
  async function nameCatAndDog(cat: string, dog: string) {
    const [catAnimal, dogAnimal] = (await api.upload("cat-and-dog.jpg")).animals;
    return { cat: await api.nameAnimal(catAnimal!.id, cat), dog: await api.nameAnimal(dogAnimal!.id, dog) };
  }
  const reopenedNames = async () => (await api.upload("cat-and-dog.jpg")).animals.map((animal) => animal.pet?.name);

  it("renames a Pet, which renames every Animal of it", async () => {
    const { cat, dog } = await nameCatAndDog("Tom", "Nellie");
    const [alone] = (await api.upload("cat.jpg")).animals;
    await api.nameAnimal(alone!.id, "Tom");

    expect(await api.renamePet(cat.id, "Tommy")).toEqual({ id: cat.id, name: "Tommy" });

    expect(await reopenedNames()).toEqual(["Tommy", "Nellie"]);
    expect((await api.upload("cat.jpg")).animals.map((animal) => animal.pet?.name)).toEqual(["Tommy"]);
    expect(await api.pets()).toEqual([
      { id: dog.id, name: "Nellie", animalCount: 1 },
      { id: cat.id, name: "Tommy", animalCount: 2 },
    ]);
  });

  it("refuses to rename a Pet to another Pet's name, or to nothing, but takes a Person's name", async () => {
    const { faces, animals } = await api.upload("person-and-dog.jpg");
    await api.nameFace(faces[0]!.id, "Max");
    const rex = await api.nameAnimal(animals[0]!.id, "Rex");
    const { cat } = await nameCatAndDog("Tom", "Nellie");

    expect((await api.call("PATCH", `/api/pets/${cat.id}`, { name: "nellie" })).status).toBe(409);
    expect((await api.call("PATCH", `/api/pets/${cat.id}`, { name: " " })).status).toBe(400);
    expect((await api.call("PATCH", "/api/pets/no-such-pet", { name: "Tom" })).status).toBe(404);
    expect(await reopenedNames()).toEqual(["Tom", "Nellie"]);
    // Pet names are kept apart from People's names.
    expect(await api.renamePet(rex.id, "Max")).toEqual({ id: rex.id, name: "Max" });
    expect((await api.upload("person-and-dog.jpg")).faces[0]!.person?.name).toBe("Max");
  });

  it("merges one Pet into another, moving its Animals and removing it", async () => {
    const { cat } = await nameCatAndDog("Nellie", "Rex");
    const [alone] = (await api.upload("cat.jpg")).animals;
    const puppy = await api.nameAnimal(alone!.id, "Nellie (puppy)");

    await api.mergePets(puppy.id, cat.id);

    expect((await api.upload("cat.jpg")).animals.map((animal) => animal.pet)).toEqual([cat]);
    expect(await reopenedNames()).toEqual(["Nellie", "Rex"]);
    expect((await api.pets()).map(({ name, animalCount }) => [name, animalCount])).toEqual([
      ["Nellie", 2],
      ["Rex", 1],
    ]);
  });

  it("refuses to merge a Pet into itself, an unknown Pet or a Person, or a Person into a Pet", async () => {
    const { faces, animals } = await api.upload("person-and-dog.jpg");
    const grandpa = await api.nameFace(faces[0]!.id, "Grandpa");
    const rex = await api.nameAnimal(animals[0]!.id, "Rex");

    expect((await api.call("POST", `/api/pets/${rex.id}/merge`, { into: rex.id })).status).toBe(400);
    expect((await api.call("POST", `/api/pets/${rex.id}/merge`, {})).status).toBe(400);
    expect((await api.call("POST", `/api/pets/${rex.id}/merge`, { into: "nobody" })).status).toBe(404);
    expect((await api.call("POST", `/api/pets/${rex.id}/merge`, { into: grandpa.id })).status).toBe(404);
    expect((await api.call("POST", `/api/people/${grandpa.id}/merge`, { into: rex.id })).status).toBe(404);
    expect(await api.pets()).toEqual([{ id: rex.id, name: "Rex", animalCount: 1 }]);
    expect(await api.people()).toEqual([{ id: grandpa.id, name: "Grandpa", faceCount: 1 }]);
  });

  it("deletes a Pet, leaving its Animals stored and unnamed", async () => {
    const { cat, dog } = await nameCatAndDog("Tom", "Rex");

    await api.deletePet(cat.id);

    expect(await reopenedNames()).toEqual([undefined, "Rex"]);
    expect(api.storedRows()["animals"]).toHaveLength(2);
    expect(await api.pets()).toEqual([{ id: dog.id, name: "Rex", animalCount: 1 }]);
    expect((await api.call("DELETE", `/api/pets/${cat.id}`)).status).toBe(404);
  });

  it("keeps a Pet whose Animals are all in old Photos listed, and named in those Photos", async () => {
    // Nellie, a cat who has died, was named in one old Photo; the Photos opened since show only the dog.
    const [old] = (await api.upload("cat.jpg")).animals;
    const nellie = await api.nameAnimal(old!.id, "Nellie");
    for (let i = 0; i < 3; i++) {
      const [dog] = (await api.upload("person-and-dog.jpg")).animals;
      await api.nameAnimal(dog!.id, "Rex");
    }

    expect(await api.pets()).toContainEqual({ id: nellie.id, name: "Nellie", animalCount: 1 });
    expect((await api.upload("cat.jpg")).animals.map((animal) => animal.pet)).toEqual([nellie]);
  });
});

describe("reopening a Photo", () => {
  it("returns the same stored Animals with the Pet names given to them, without storing them twice", async () => {
    const first = (await api.upload("cat-and-dog.jpg")).animals;
    const tom = await api.nameAnimal(first[0]!.id, "Tom");

    const reopened = (await api.upload("cat-and-dog.jpg")).animals;

    expect(reopened.map((animal) => animal.id)).toEqual(first.map((animal) => animal.id));
    expect(reopened.map((animal) => animal.species)).toEqual(["cat", "dog"]);
    expect(reopened.map((animal) => animal.pet)).toEqual([tom, undefined]);
    expect(api.storedRows()["animals"]).toHaveLength(2);
  });
});

describe("Pet names and People's names", () => {
  it("are kept apart: a Person named Max is never reused for an Animal, nor a Pet named Max for a Face", async () => {
    const { faces, animals } = await api.upload("person-and-dog.jpg");

    const grandpa = await api.nameFace(faces[0]!.id, "Max");
    const dog = await api.nameAnimal(animals[0]!.id, "max");

    expect(dog.id).not.toBe(grandpa.id);
    expect(dog.name).toBe("max");
    expect(await api.people()).toEqual([{ id: grandpa.id, name: "Max", faceCount: 1 }]);
    expect(await api.pets()).toEqual([{ id: dog.id, name: "max", animalCount: 1 }]);
    const reopened = await api.upload("person-and-dog.jpg");
    expect(reopened.faces[0]!.person).toEqual(grandpa);
    expect(reopened.animals[0]!.pet).toEqual(dog);
  });

  it("refuses an empty name and an unknown Animal", async () => {
    const [cat] = (await api.upload("cat.jpg")).animals;

    expect((await api.call("PUT", `/api/animals/${cat!.id}/pet`, { name: " " })).status).toBe(400);
    expect((await api.call("PUT", "/api/animals/no-such-animal/pet", { name: "Tom" })).status).toBe(404);
    // A Face's id is not an Animal's.
    const [face] = (await api.upload("person-and-dog.jpg")).faces;
    expect((await api.call("PUT", `/api/animals/${face!.id}/pet`, { name: "Tom" })).status).toBe(404);
    expect(await api.pets()).toEqual([]);
  });
});

describe('"Not a pet"', () => {
  it("hides the Animal on reopening and keeps only its box and the Photo hash, with no embedding", async () => {
    const [cat, dog] = (await api.upload("cat-and-dog.jpg")).animals;
    const [alone] = (await api.upload("cat.jpg")).animals;
    const nellie = await api.nameAnimal(alone!.id, "Nellie");
    await api.rejectPetSuggestion(cat!.id, nellie.id);
    const tom = await api.nameAnimal(cat!.id, "Tom");

    await api.markNotAPet(cat!.id);

    expect((await api.upload("cat-and-dog.jpg")).animals.map((animal) => animal.id)).toEqual([dog!.id]);
    const rows = api.storedRows()["animals"]!;
    expect(rows).toHaveLength(3);
    const dismissed = rows.find((row) => row["id"] === cat!.id)!;
    expect(dismissed).toMatchObject({ embedding: null, species: null, pet_id: null, model_version: null, not_a_pet: 1 });
    // Nor any rejected Suggestion.
    expect(api.storedRows()["rejected_pet_suggestions"]!.filter((row) => row["animal_id"] === cat!.id)).toEqual([]);
    expect(dismissed["photo_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect([dismissed["box_x"], dismissed["box_y"], dismissed["box_width"], dismissed["box_height"]]).toEqual([
      cat!.box.x,
      cat!.box.y,
      cat!.box.width,
      cat!.box.height,
    ]);
    expect((await api.pets()).map(({ name, animalCount }) => [name, animalCount])).toEqual([
      ["Nellie", 1],
      ["Tom", 0],
    ]);
  });

  it("cannot then be named", async () => {
    const [cat] = (await api.upload("cat.jpg")).animals;
    await api.markNotAPet(cat!.id);

    expect((await api.call("PUT", `/api/animals/${cat!.id}/pet`, { name: "Tom" })).status).toBe(404);
    expect((await api.call("POST", "/api/animals/no-such-animal/not-a-pet")).status).toBe(404);
  });
});

describe("a Photo stored under an older pet model version", () => {
  /** The real pet models standing in for an older version whose boxes sit `shift` box-widths to the right. */
  const olderPetModel = (shift: number): AnimalDetector => ({
    modelVersion: "older-pet-model",
    detect: async (image) =>
      (await api.animalDetector.detect(image)).map((animal) => ({
        ...animal,
        box: { ...animal.box, x: animal.box.x + shift * animal.box.width },
      })),
  });

  it('is detected again, and each new Animal keeps the Pet or "Not a pet" mark of the old box it mostly overlaps', async () => {
    const old = (await api.upload("cat-and-dog.jpg", { animals: olderPetModel(0.1) })).animals;
    await api.nameAnimal(old[1]!.id, "Rex");
    await api.markNotAPet(old[0]!.id);

    const reopened = (await api.upload("cat-and-dog.jpg")).animals;

    expect(reopened.map((animal) => [animal.species, animal.pet?.name])).toEqual([["dog", "Rex"]]);
    expect(reopened[0]!.id).not.toBe(old[1]!.id);
    expect(reopened[0]!.box.x).toBeLessThan(old[1]!.box.x);
    // The old Animals are replaced, not kept beside the new ones.
    const rows = api.storedRows()["animals"]!;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row["model_version"]).filter((v) => v !== null)).toEqual([api.animalDetector.modelVersion]);
    expect((await api.upload("cat-and-dog.jpg")).animals).toEqual(reopened);
  });

  it("carries a rejected Suggestion over to the new Animal that mostly overlaps the old one", async () => {
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");
    const [old] = (await api.upload("cat-and-dog.jpg", { animals: olderPetModel(0.1) })).animals;
    await api.rejectPetSuggestion(old!.id, tom.id);

    const [reopened] = (await api.upload("cat-and-dog.jpg")).animals;

    expect(reopened!.id).not.toBe(old!.id);
    expect(reopened!.suggestion).toBeUndefined();
  });

  it("leaves a new Animal unnamed when no old box mostly overlaps it", async () => {
    const [old] = (await api.upload("cat.jpg", { animals: olderPetModel(0.8) })).animals;
    await api.nameAnimal(old!.id, "Tom");

    const reopened = (await api.upload("cat.jpg")).animals;

    expect(reopened.map((animal) => animal.pet)).toEqual([undefined]);
  });

  it("detects only the Animals again, leaving its Faces untouched", async () => {
    const before = await api.upload("person-and-dog.jpg", { animals: olderPetModel(0.1) });
    await api.nameFace(before.faces[0]!.id, "Grandpa");

    const after = await api.upload("person-and-dog.jpg");

    expect(after.faces).toEqual(before.faces.map((face) => ({ ...face, person: expect.objectContaining({ name: "Grandpa" }) })));
    expect(after.animals[0]!.id).not.toBe(before.animals[0]!.id);
  });

  it("is not detected again when only the face model changes", async () => {
    const before = await api.upload("person-and-dog.jpg");

    const after = await api.upload("person-and-dog.jpg", { detector: { ...faceDetector, modelVersion: "newer-face-model" } });

    expect(after.animals).toEqual(before.animals);
    expect(after.faces[0]!.id).not.toBe(before.faces[0]!.id);
  });
});

describe('"Delete all face and pet data"', () => {
  /** faces.db and its write-ahead log, byte for byte, as anyone who copied the files would read them. */
  const databaseFiles = async () =>
    Buffer.concat(
      await Promise.all(["", "-wal"].map((suffix) => readFile(`${api.dbPath}${suffix}`).catch(() => Buffer.alloc(0)))),
    );

  it("removes every Animal and Pet as well as the face data, leaving no deleted embedding in the file", async () => {
    const { faces, animals } = await api.upload("person-and-dog.jpg");
    await api.nameFace(faces[0]!.id, "Grandpa");
    await api.nameAnimal(animals[0]!.id, "Rex");
    const [cat] = (await api.upload("cat.jpg")).animals;
    await api.markNotAPet(cat!.id);
    const embeddings = [...api.storedRows()["animals"]!, ...api.storedRows()["faces"]!]
      .map((row) => row["embedding"])
      .filter((embedding): embedding is Uint8Array => embedding instanceof Uint8Array);
    expect(embeddings).toHaveLength(2);
    for (const embedding of embeddings) expect((await databaseFiles()).includes(embedding)).toBe(true);

    await api.deleteAllFaceAndPetData();

    for (const [table, rows] of Object.entries(api.storedRows())) expect(rows, table).toEqual([]);
    expect(await api.pets()).toEqual([]);
    expect(await api.people()).toEqual([]);
    const files = await databaseFiles();
    for (const embedding of embeddings) expect(files.includes(embedding)).toBe(false);
    // Reopened, the Photo is a new one: its Animal is unnamed.
    expect((await api.upload("person-and-dog.jpg")).animals.map((animal) => animal.pet)).toEqual([undefined]);
  });
});

describe("what is kept (ADR-0001, ADR-0003)", () => {
  it("keeps pet data in faces.db beside face data, and never the Photo or any image of an Animal", async () => {
    const [cat] = (await api.upload("cat-and-dog.jpg")).animals;
    await api.nameAnimal(cat!.id, "Tom");
    await api.upload("cat-oriented.heic");

    expect(await readdir(api.tempDir)).toEqual([]);
    // faces.db is the file kept out of off-server backups, so pet data is too.
    const tables = api.storedRows();
    const rows = tables["animals"]!;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "box_height",
          "box_width",
          "box_x",
          "box_y",
          "embedding",
          "id",
          "model_version",
          "not_a_pet",
          "pet_id",
          "photo_sha256",
          "species",
          "unknown_pet_id",
        ],
      );
      // 768 float32s: an embedding, not pixels.
      expect((row["embedding"] as Uint8Array).byteLength).toBe(768 * 4);
    }
    for (const row of tables["pets"]!) expect(Object.keys(row)).toEqual(["id", "name"]);
    for (const row of tables["animal_photos"]!) expect(Object.keys(row)).toEqual(["sha256", "model_version"]);
    // An Unknown pet is only a number.
    for (const row of tables["unknown_pets"]!) expect(Object.keys(row)).toEqual(["id"]);
  });
});
