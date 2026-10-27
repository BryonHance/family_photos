import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import type { AnimalDetector } from "./pets/detector.ts";
import { modelsDir, openFaceApi, type FaceApi } from "./testing/face-api.ts";

// These tests run the real buffalo_sc, D-FINE-S and Avito models: fetch them with `pixi run models`.
// The same cat is in cat.jpg, cat.png, cat.webp and (left) cat-and-dog.jpg.
// The same dog is in dog.jpg, person-and-dog.jpg and (right) cat-and-dog.jpg.

let exiftool: ExifTool;
let faceDetector: FaceDetector;
let api: FaceApi;

beforeAll(async () => {
  exiftool = new ExifTool();
  faceDetector = await loadFaceDetector(modelsDir);
});

afterAll(async () => {
  await exiftool.end();
});

beforeEach(async () => {
  api = await openFaceApi({ exiftool, faceDetector });
});

afterEach(async () => {
  await api.close();
});

const unknownPetLabels = (animals: { unknownPet?: { label: string; photoCount: number } }[]) =>
  animals.map((animal) => animal.unknownPet && `${animal.unknownPet.label}, in ${animal.unknownPet.photoCount} Photos`);

const suggestedNames =(animals: { suggestion?: { name: string } }[]) => animals.map((animal) => animal.suggestion?.name);

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
  });
});
