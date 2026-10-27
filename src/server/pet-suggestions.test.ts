import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
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

const suggestedNames = (animals: { suggestion?: { name: string } }[]) => animals.map((animal) => animal.suggestion?.name);

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
