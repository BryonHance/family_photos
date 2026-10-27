import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import type { AnimalDetector } from "./pets/detector.ts";
import { fixture, modelsDir, openApi, type Api } from "./testing/api.ts";

// These tests run the real buffalo_sc, D-FINE-S and Avito models: fetch them with `pixi run models`.
// The same cat is in cat.jpg, cat.png, cat.webp and (left) cat-and-dog.jpg.
// The same dog is in dog.jpg, person-and-dog.jpg and (right) cat-and-dog.jpg.

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

const unknownPetLabels = (animals: { unknownPet?: { label: string; photoCount: number } }[]) =>
  animals.map((animal) => animal.unknownPet && `${animal.unknownPet.label}, in ${animal.unknownPet.photoCount} Photos`);

const suggestedNames =(animals: { suggestion?: { name: string } }[]) => animals.map((animal) => animal.suggestion?.name);

/** As `animalsWith`, for the real face models finding a Photo's Faces. */
const facesWith = (...vectors: Record<number, number>[]): FaceDetector => ({
  modelVersion: faceDetector.modelVersion,
  detect: async (photo) => {
    const faces = (await faceDetector.detect(photo)).sort((a, b) => a.box.x - b.box.x);
    return faces.map((face, i) => {
      const embedding = new Float32Array(512);
      for (const [axis, weight] of Object.entries(vectors[i] ?? { [100 + i]: 1 })) embedding[Number(axis)] = weight;
      const length = Math.hypot(...embedding);
      return { ...face, embedding: embedding.map((v) => v / length) };
    });
  },
});

/**
 * The real pet models finding a Photo's Animals and their species, standing in
 * an embedding for each, left to right: `vectors[i]` maps axes to weights, made
 * unit length. An Animal without one gets an axis of its own, unlike any other.
 */
const animalsWith = (...vectors: Record<number, number>[]): AnimalDetector => ({
  modelVersion: api.animalDetector.modelVersion,
  detect: async (image) => {
    const animals = (await api.animalDetector.detect(image)).sort((a, b) => a.box.x - b.box.x);
    return animals.map((animal, i) => {
      const embedding = new Float32Array(768);
      for (const [axis, weight] of Object.entries(vectors[i] ?? { [100 + i]: 1 })) embedding[Number(axis)] = weight;
      const length = Math.hypot(...embedding);
      return { ...animal, embedding: embedding.map((v) => v / length) };
    });
  },
});

describe("Suggestions", () => {
  it("suggests the Pet of a named Animal for the same pet in another Photo", async () => {
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");

    const animals = (await api.upload("cat-and-dog.jpg")).animals;

    expect(animals[0]!.suggestion).toEqual(tom);
    expect(animals[0]!.pet).toBeUndefined();
    expect(suggestedNames(animals)).toEqual(["Tom", undefined]);
  });

  it("confirming a Suggestion names the Animal", async () => {
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");
    const [suggested] = (await api.upload("cat-and-dog.jpg")).animals;

    expect(await api.confirmPetSuggestion(suggested!.id, tom.id)).toEqual(tom);

    const [reopened] = (await api.upload("cat-and-dog.jpg")).animals;
    expect(reopened!.pet).toEqual(tom);
    expect(reopened!.suggestion).toBeUndefined();
    expect(await api.pets()).toEqual([{ id: tom.id, name: "Tom", animalCount: 2 }]);
  });

  it("a rejected Suggestion never returns, and ignoring one saves nothing", async () => {
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");
    const [suggested] = (await api.upload("cat-and-dog.jpg")).animals;
    const ignored = await api.upload("cat-and-dog.jpg");
    expect(ignored.animals[0]!.suggestion).toEqual(tom);

    const afterRejecting = await api.rejectPetSuggestion(suggested!.id, tom.id);

    expect(afterRejecting.suggestion).toBeUndefined();
    expect(afterRejecting.pet).toBeUndefined();
    const [reopened] = (await api.upload("cat-and-dog.jpg")).animals;
    expect(reopened!.suggestion).toBeUndefined();
    expect(reopened!.pet).toBeUndefined();
  });

  it("never suggests two Animals of one Photo as the same Pet: the better match wins", async () => {
    const [cat] = (await api.upload("cat.jpg", { animals: animalsWith({ 0: 1 }) })).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");

    const animals = (await api.upload("cat-and-dog.jpg", { animals: animalsWith({ 0: 0.8, 1: 0.6 }, { 0: 0.9, 2: Math.sqrt(0.19) }) }))
      .animals;

    expect(animals.map((animal) => animal.suggestion)).toEqual([undefined, tom]);
  });

  it("leaves the Animal that loses a clash without a Suggestion, rather than its next-best Pet", async () => {
    // Tom is axis 0 and Rex axis 1. Both Animals of the second Photo are nearest to Tom,
    // the right-hand one less so; it is like Rex too, but less than like Tom.
    const [cat] = (await api.upload("cat.jpg", { animals: animalsWith({ 0: 1 }) })).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");
    const [dog] = (await api.upload("dog.jpg", { animals: animalsWith({ 1: 1 }) })).animals;
    await api.nameAnimal(dog!.id, "Rex");

    const animals = (
      await api.upload("cat-and-dog.jpg", {
        animals: animalsWith({ 0: 0.9, 3: Math.sqrt(0.19) }, { 0: 0.75, 1: 0.66, 4: Math.sqrt(1 - 0.75 ** 2 - 0.66 ** 2) }),
      })
    ).animals;

    expect(animals.map((animal) => animal.suggestion)).toEqual([tom, undefined]);
    // It then follows the Unknown pet rule: alone in a new Unknown pet, it shows no label.
    expect(animals[1]!.unknownPet).toBeUndefined();
  });

  it("does not suggest a Pet already named in the same Photo", async () => {
    const [cat] = (await api.upload("cat.jpg", { animals: animalsWith({ 0: 1 }) })).animals;
    await api.nameAnimal(cat!.id, "Tom");
    const both = animalsWith({ 0: 0.9, 1: Math.sqrt(0.19) }, { 0: 0.8, 2: 0.6 });
    const [left, right] = (await api.upload("cat-and-dog.jpg", { animals: both })).animals;

    await api.nameAnimal(left!.id, "Tom");

    const [, reopenedRight] = (await api.upload("cat-and-dog.jpg", { animals: both })).animals;
    expect(reopenedRight!.id).toBe(right!.id);
    expect(reopenedRight!.suggestion).toBeUndefined();
  });

  it("is not limited by species: a cat can be suggested a Pet first named on a dog", async () => {
    const [dog] = (await api.upload("dog.jpg", { animals: animalsWith({ 0: 1 }) })).animals;
    expect(dog!.species).toBe("dog");
    const rex = await api.nameAnimal(dog!.id, "Rex");

    const [cat] = (await api.upload("cat.jpg", { animals: animalsWith({ 0: 0.8, 1: 0.6 }) })).animals;

    expect(cat!.species).toBe("cat");
    expect(cat!.suggestion).toEqual(rex);
  });

  it("never suggests a Pet for a Face, nor a Person for an Animal", async () => {
    // Max is a Person on axis 0 and Rex a Pet on axis 1. In person-and-dog.jpg the
    // Face is more like Rex than Max, and the Animal more like Max than Rex.
    const [neil] = (await api.upload("crew.jpg", { detector: facesWith({ 0: 1 }) })).faces;
    const max = await api.nameFace(neil!.id, "Max");
    const [dog] = (await api.upload("dog.jpg", { animals: animalsWith({ 1: 1 }) })).animals;
    const rex = await api.nameAnimal(dog!.id, "Rex");

    const { faces, animals } = await api.upload("person-and-dog.jpg", {
      detector: facesWith({ 0: 0.66, 1: 0.75, 2: 0.04 }),
      animals: animalsWith({ 0: 0.72, 1: 0.69, 3: 0.07 }),
    });

    expect(faces[0]!.suggestion).toEqual(max);
    expect(animals[0]!.suggestion).toEqual(rex);
  });

  it("refuses to confirm or reject for an unknown Animal or Pet, or for a Person", async () => {
    const { faces } = await api.upload("person-and-dog.jpg");
    const grandpa = await api.nameFace(faces[0]!.id, "Grandpa");
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");
    const [suggested] = (await api.upload("cat-and-dog.jpg")).animals;

    for (const verb of ["confirm", "reject"]) {
      expect((await api.call("POST", `/api/animals/no-such-animal/suggestion/${verb}`, { petId: tom.id })).status).toBe(404);
      expect((await api.call("POST", `/api/animals/${suggested!.id}/suggestion/${verb}`, { petId: "nothing" })).status).toBe(404);
      expect((await api.call("POST", `/api/animals/${suggested!.id}/suggestion/${verb}`, { petId: grandpa.id })).status).toBe(404);
      expect((await api.call("POST", `/api/animals/${suggested!.id}/suggestion/${verb}`, {})).status).toBe(400);
    }
    expect((await api.upload("cat-and-dog.jpg")).animals[0]!.suggestion).toEqual(tom);
  });
});

describe("Unknown pets", () => {
  it("labels unnamed Animals of the same pet across two Photos alike, with how many Photos they span", async () => {
    const first = (await api.upload("cat.jpg")).animals;
    // An Unknown pet in a single Photo shows no label.
    expect(unknownPetLabels(first)).toEqual([undefined]);

    const second = (await api.upload("cat-and-dog.jpg")).animals;

    // The dog is in no other Photo yet.
    expect(unknownPetLabels(second)).toEqual([expect.stringMatching(/^Unknown pet \d+, in 2 Photos$/), undefined]);
    expect(unknownPetLabels((await api.upload("cat.jpg")).animals)).toEqual([unknownPetLabels(second)[0]]);
    expect(second.every((animal) => animal.pet === undefined && animal.suggestion === undefined)).toBe(true);

    const [dog] = (await api.upload("dog.jpg")).animals;
    expect(dog!.unknownPet).toEqual({ label: expect.stringMatching(/^Unknown pet \d+$/), photoCount: 2 });
    expect(dog!.unknownPet!.label).not.toBe(second[0]!.unknownPet!.label);
  });

  it('never reuses an Unknown pet number, even after "Delete all face and pet data"', async () => {
    await api.upload("cat.jpg");
    const before = unknownPetLabels((await api.upload("cat-and-dog.jpg")).animals);

    await api.deleteAllFaceAndPetData();

    await api.upload("cat.jpg");
    const [after] = unknownPetLabels((await api.upload("cat-and-dog.jpg")).animals);
    expect(after).toMatch(/^Unknown pet \d+, in 2 Photos$/);
    expect(before).not.toContain(after);
  });

  it("lets two Animals of one Photo join the same Unknown pet, each the one of its most similar Animal", async () => {
    await api.upload("cat.jpg", { animals: animalsWith({ 0: 1 }) });

    const both = (
      await api.upload("cat-and-dog.jpg", { animals: animalsWith({ 0: 0.9, 1: Math.sqrt(0.19) }, { 0: 0.8, 2: 0.6 }) })
    ).animals;

    expect(unknownPetLabels(both)).toEqual([
      expect.stringMatching(/^Unknown pet \d+, in 2 Photos$/),
      expect.stringMatching(/^Unknown pet \d+, in 2 Photos$/),
    ]);
    expect(both[1]!.unknownPet).toEqual(both[0]!.unknownPet);
  });

  it("gives the Animals of a Photo as they now stand, by one of its Animals, such as after their Pet is deleted", async () => {
    await api.upload("cat.jpg");
    const [beside] = (await api.upload("cat-and-dog.jpg")).animals;
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");
    await api.confirmPetSuggestion(beside!.id, tom.id);

    await api.deletePet(tom.id);

    const now = await api.animalsOfPhotoOf(cat!.id);
    expect(now[0]!.unknownPet?.photoCount).toBe(2);
    expect(now).toEqual((await api.upload("cat.jpg")).animals);
    expect((await api.call("GET", "/api/animals/no-such-animal/photo")).status).toBe(404);
  });

  it("the Animals of a deleted Pet join an Unknown pet again, under a number never used before", async () => {
    await api.upload("cat.jpg");
    const [before] = (await api.upload("cat-and-dog.jpg")).animals;
    const usedLabel = before!.unknownPet!.label;
    const [cat] = (await api.upload("cat.jpg")).animals;
    const tom = await api.nameAnimal(cat!.id, "Tom");
    await api.confirmPetSuggestion(before!.id, tom.id);

    await api.deletePet(tom.id);

    const [alone] = (await api.upload("cat.jpg")).animals;
    const [beside] = (await api.upload("cat-and-dog.jpg")).animals;
    expect(alone!.pet).toBeUndefined();
    expect(alone!.unknownPet).toEqual(beside!.unknownPet);
    expect(alone!.unknownPet?.photoCount).toBe(2);
    expect(alone!.unknownPet?.label).not.toBe(usedLabel);
  });

  it("an Unknown pet left with Animals in one Photo shows no label", async () => {
    await api.upload("cat.jpg");
    const [cat] = (await api.upload("cat-and-dog.jpg")).animals;

    await api.markNotAPet(cat!.id);

    expect(unknownPetLabels((await api.upload("cat.jpg")).animals)).toEqual([undefined]);
  });

  describe("a chain of look-alikes", () => {
    /**
     * The real pet models finding the Animal of a Photo, standing in an
     * embedding `degrees` round a circle: Animals 40° apart are alike (cosine
     * 0.77), Animals 80° apart are not (0.17). The fixtures' real Animals are
     * either near-identical or wholly unlike, so they cannot make a chain.
     */
    const firstAnimalAt = (degrees: number): AnimalDetector => ({
      modelVersion: api.animalDetector.modelVersion,
      detect: async (image) => {
        const [animal] = await api.animalDetector.detect(image);
        const embedding = new Float32Array(768);
        embedding[0] = Math.cos((degrees * Math.PI) / 180);
        embedding[1] = Math.sin((degrees * Math.PI) / 180);
        return [{ ...animal!, embedding }];
      },
    });

    /** Three Photos, one Animal each: A is like B, B is like C, A is not like C. */
    async function uploadChain() {
      const [a] = (await api.upload("cat.jpg", { animals: firstAnimalAt(0) })).animals;
      const [b] = (await api.upload("dog.jpg", { animals: firstAnimalAt(40) })).animals;
      const [c] = (await api.upload("person-and-dog.jpg", { animals: firstAnimalAt(80) })).animals;
      return { a: a!, b: b!, c: c! };
    }
    const reopen = async (fixtureName: string) => (await api.upload(fixtureName)).animals[0]!;

    it("is one Unknown pet", async () => {
      const { c } = await uploadChain();

      expect(c.unknownPet?.photoCount).toBe(3);
      expect((await reopen("cat.jpg")).unknownPet).toEqual(c.unknownPet);
    });

    it("naming one Animal of an Unknown pet suggests that Pet for the rest, even the unlike ones", async () => {
      const { a } = await uploadChain();

      const tom = await api.nameAnimal(a.id, "Tom");

      expect((await reopen("dog.jpg")).suggestion).toEqual(tom);
      expect((await reopen("person-and-dog.jpg")).suggestion).toEqual(tom);
    });

    it("rejecting that Suggestion takes the Animal out of the Unknown pet", async () => {
      const { a, c } = await uploadChain();
      const tom = await api.nameAnimal(a.id, "Tom");

      const afterRejecting = await api.rejectPetSuggestion(c.id, tom.id);

      // Still in the Unknown pet, it would show "in 2 Photos" (B and C); alone, it shows no label.
      expect(afterRejecting).toEqual({ id: c.id, species: c.species, box: c.box });
      expect(await reopen("person-and-dog.jpg")).toEqual(afterRejecting);
      expect((await reopen("dog.jpg")).suggestion).toEqual(tom);
    });

    it("suggests the named Pet for the rest even when another Pet is a nearer match", async () => {
      const { a } = await uploadChain();
      const tom = await api.nameAnimal(a.id, "Tom");
      // Rex is like C (cosine 0.68, enough for a Suggestion) but not enough to join its Unknown pet.
      const rexAt80 = animalsWith({ 0: 0.68 * Math.cos((80 * Math.PI) / 180), 1: 0.68 * Math.sin((80 * Math.PI) / 180), 2: Math.sqrt(1 - 0.68 ** 2) });
      const [rexAnimal] = (await api.upload("cat.png", { animals: rexAt80 })).animals;
      await api.nameAnimal(rexAnimal!.id, "Rex");

      expect((await reopen("person-and-dog.jpg")).suggestion).toEqual(tom);
    });

    it("keeps one state per Animal: naming or confirming takes it out of its Unknown pet", async () => {
      const { a, b } = await uploadChain();
      const tom = await api.nameAnimal(a.id, "Tom");
      await api.confirmPetSuggestion(b.id, tom.id);

      const stored = api.storedRows()["animals"]!;
      for (const named of [a, b]) {
        expect(stored.find((row) => row["id"] === named.id)).toMatchObject({ pet_id: tom.id, unknown_pet_id: null });
      }
      // C is still suggested as Tom.
      expect((await reopen("person-and-dog.jpg")).suggestion).toEqual(tom);
    });
  });

  it("upgrades a faces.db that kept a named Animal in its Unknown pet, and refuses both from then on", async () => {
    await api.close();
    const catPhoto = await photoHash("cat.jpg");
    const dogPhoto = await photoHash("dog.jpg");
    const unit = (axis: number) => {
      const embedding = new Float32Array(768);
      embedding[axis] = 1;
      return new Uint8Array(embedding.buffer);
    };
    api = await openApi({
      exiftool,
      faceDetector,
      // As the pet store left it before an Animal had one state: the named cat
      // kept its Unknown pet, which the unlike dog is also in.
      existing: (db) => {
        db.exec(`
          CREATE TABLE pets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
          CREATE TABLE unknown_pets (id INTEGER PRIMARY KEY AUTOINCREMENT);
          CREATE TABLE animals (
            id             TEXT PRIMARY KEY,
            photo_sha256   TEXT NOT NULL,
            box_x          REAL NOT NULL,
            box_y          REAL NOT NULL,
            box_width      REAL NOT NULL,
            box_height     REAL NOT NULL,
            species        TEXT CHECK (species IN ('cat', 'dog')),
            model_version  TEXT,
            embedding      BLOB,
            pet_id         TEXT REFERENCES pets (id) ON DELETE SET NULL,
            not_a_pet      INTEGER NOT NULL DEFAULT 0 CHECK (not_a_pet IN (0, 1)),
            unknown_pet_id INTEGER REFERENCES unknown_pets (id) ON DELETE SET NULL,
            CHECK (not_a_pet = 0 OR (species IS NULL AND embedding IS NULL AND pet_id IS NULL AND model_version IS NULL AND unknown_pet_id IS NULL)),
            CHECK (not_a_pet = 1 OR (species IS NOT NULL AND embedding IS NOT NULL AND model_version IS NOT NULL))
          );
          CREATE TABLE animal_photos (sha256 TEXT PRIMARY KEY, model_version TEXT NOT NULL);
          INSERT INTO pets VALUES ('tom', 'Tom');
          INSERT INTO unknown_pets VALUES (5);`);
        const insert = db.prepare("INSERT INTO animals VALUES (?, ?, 0.1, 0.1, 0.5, 0.5, ?, ?, ?, ?, 0, 5)");
        insert.run("cat", catPhoto, "cat", api.animalDetector.modelVersion, unit(0), "tom");
        insert.run("dog", dogPhoto, "dog", api.animalDetector.modelVersion, unit(1), null);
        const photo = db.prepare("INSERT INTO animal_photos VALUES (?, ?)");
        for (const sha256 of [catPhoto, dogPhoto]) photo.run(sha256, api.animalDetector.modelVersion);
      },
    });

    expect((await api.upload("dog.jpg")).animals).toEqual([
      expect.objectContaining({ id: "dog", suggestion: { id: "tom", name: "Tom" } }),
    ]);
    expect((await api.upload("cat.jpg")).animals).toEqual([
      expect.objectContaining({ id: "cat", pet: { id: "tom", name: "Tom" } }),
    ]);
    expect(api.storedRows()["animals"]!.find((row) => row["id"] === "cat")).toMatchObject({ unknown_pet_id: null });
    const db = new DatabaseSync(api.dbPath);
    try {
      expect(() => db.exec("UPDATE animals SET unknown_pet_id = (SELECT id FROM unknown_pets) WHERE id = 'cat'")).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  });
});

/** The SHA-256 of a fixture's bytes: the Photo's hash, as the store keys it. */
const photoHash = async (name: string) => createHash("sha256").update(await readFile(fixture(name))).digest("hex");
